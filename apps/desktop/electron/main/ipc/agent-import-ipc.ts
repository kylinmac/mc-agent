/**
 * Batch import handlers for third-party AI-tool skills and MCP servers.
 *
 * `*Scan` handlers wrap the on-disk scanners in the `importers/` directory and
 * translate their failures into a `sources[]` row so the panel never receives a
 * rejected promise. `*Run` handlers replay each candidate through the host RPC
 * one at a time and bucket the results into `imported / skipped / failed`, so a
 * single bad entry does not abort the batch.
 *
 * `runSkillImport` and `runMcpImport` are exported so the unit test can drive
 * them against a stub host without booting a real sidecar.
 */
import { IPC } from "@pi-desktop/shared";
import type {
  ExternalMcpImportItem as McpImportRunItem,
  ExternalMcpImportPayload as McpImportRunPayload,
  ExternalMcpImportRunResult as McpImportRunResult,
  ExternalSkillImportItem as SkillImportRunItem,
  ExternalSkillImportPayload as SkillImportRunPayload,
  ExternalSkillImportRunResult as SkillImportRunResult,
  ExternalMcpScanResult,
  ExternalSkillScanResult,
  McpServerInput,
  McpServerRecord,
  UserSkillRecord,
} from "@pi-desktop/shared";
import type { HostProcess } from "../host-process";
import {
  scanExternalMcp,
  type McpCandidate,
  type McpScanResult,
} from "../importers/agent-mcp-scan";
import {
  scanExternalSkills,
  type SkillCandidate,
  type SkillScanResult,
} from "../importers/agent-skill-scan";
import type { IpcRegistrar } from "./types";

export type HostCall = <T = unknown>(method: string, params?: unknown) => Promise<T>;

export type AgentImportIpcDependencies = {
  registrar: IpcRegistrar;
  getHost: () => HostProcess | null;
  sendToRenderer: (channel: string, payload?: unknown) => void;
  refreshUserMcp?: (projectPath?: string | null) => Promise<unknown>;
  currentWorkspacePath?: () => string | null;
};

export type {
  McpImportRunItem,
  McpImportRunPayload,
  McpImportRunResult,
  SkillImportRunItem,
  SkillImportRunPayload,
  SkillImportRunResult,
};

/** True when a host error message is the "same name/id already imported" case. */
function isExistsError(message: string): boolean {
  return /already exists/i.test(message);
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return String(error);
  } catch {
    return "unknown error";
  }
}

/**
 * Replay each skill candidate through `skills.import`. One failure never stops
 * the batch; anything that reads like "already at this level" is skipped, and
 * every other RPC error is captured with its message.
 */
export async function runSkillImport(
  hostCall: HostCall,
  payload: SkillImportRunPayload,
): Promise<SkillImportRunResult> {
  const mode = payload.mode ?? "copy";
  const level = payload.level;
  const projectPath = payload.projectPath;
  const result: SkillImportRunResult = {
    imported: [],
    skipped: [],
    failed: [],
  };
  for (const item of payload.items) {
    // Directory shape: `rootDir` is the folder that contains SKILL.md, and the
    // scanner leaves it filled. Fall back to the source path only when it is
    // missing so a partly-formed candidate still reports through the failed
    // bucket rather than silently pointing at the SKILL.md file itself.
    const path = item.shape === "dir" ? item.rootDir ?? item.sourcePath : item.sourcePath;
    const params: Record<string, unknown> = {
      path,
      id: item.id,
      name: item.name,
      level,
      mode,
      shape: item.shape,
      ...(item.description !== undefined ? { description: item.description } : {}),
      ...(projectPath !== undefined ? { projectPath } : {}),
    };
    try {
      const res = await hostCall<{ skill: UserSkillRecord }>("skills.import", params);
      result.imported.push({ item, skill: res?.skill });
    } catch (error) {
      const message = describeError(error);
      if (isExistsError(message)) {
        result.skipped.push({ item, reason: "exists" });
      } else {
        result.failed.push({ item, error: message });
      }
    }
  }
  return result;
}

/** Send the requested activation state with the config so the host returns the saved record. */
export async function runMcpImport(
  hostCall: HostCall,
  payload: McpImportRunPayload,
): Promise<McpImportRunResult> {
  const level = payload.level ?? "global";
  const projectPath = level === "project" ? payload.projectPath : undefined;
  const result: McpImportRunResult = {
    imported: [],
    skipped: [],
    failed: [],
  };
  for (const item of payload.items) {
    const server: McpServerInput = {
      id: item.id,
      level,
      ...(projectPath ? { projectPath } : {}),
      transport: item.transport,
      ...(item.disabled === true ? { enabled: false } : {}),
      ...(item.label !== undefined ? { label: item.label } : {}),
      ...(item.description !== undefined ? { description: item.description } : {}),
      ...(item.command !== undefined ? { command: item.command } : {}),
      ...(item.args !== undefined ? { args: item.args } : {}),
      ...(item.env !== undefined ? { env: item.env } : {}),
      ...(item.url !== undefined ? { url: item.url } : {}),
      ...(item.headers !== undefined ? { headers: item.headers } : {}),
    };
    try {
      const res = await hostCall<{ server: McpServerRecord }>("mcp.upsert", { server });
      result.imported.push({ item, server: res?.server });
    } catch (error) {
      const message = describeError(error);
      if (isExistsError(message)) {
        result.skipped.push({ item, reason: "exists" });
      } else {
        result.failed.push({ item, error: message });
      }
    }
  }
  return result;
}

/**
 * A synthetic `sources[]` row for a scan whose top-level call threw. The panel
 * knows how to render one; a rejected IPC promise it has nowhere to display.
 *
 * `kind: "error"` sits outside the scanners' own unions on purpose — no real
 * source ever emits it — so the row is distinguishable from a normal source
 * that happened to be missing on disk.
 */
type ScanErrorReport = {
  candidates: [];
  sources: [{ kind: "error"; path: string; exists: false; error: string; count: 0 }];
};

function scanErrorReport(error: unknown): ScanErrorReport {
  return {
    candidates: [],
    sources: [
      {
        kind: "error",
        path: "",
        exists: false,
        error: describeError(error),
        count: 0,
      },
    ],
  };
}

/** Register the four `*importScan` / `*importRun` handlers. */
export function registerAgentImportIpc({
  registrar,
  getHost,
  sendToRenderer,
  refreshUserMcp,
  currentWorkspacePath,
}: AgentImportIpcDependencies): void {
  registrar.handle(
    IPC.invoke.skillImportScan,
    async ({ projectPath }: { projectPath?: string } = {}): Promise<ExternalSkillScanResult> => {
      try {
        return await scanExternalSkills({ projectPath });
      } catch (error) {
        return scanErrorReport(error);
      }
    },
  );

  registrar.handle(IPC.invoke.skillImportRun, async (payload: SkillImportRunPayload) => {
    const host = getHost();
    if (!host) throw new Error("host unavailable");
    const hostCall: HostCall = (method, params) => host.call(method, params);
    const result = await runSkillImport(hostCall, payload);
    if (result.imported.length) {
      sendToRenderer(IPC.event.pluginChanged, { reason: "skill" });
    }
    return result;
  });

  registrar.handle(
    IPC.invoke.mcpImportScan,
    async ({ projectPath }: { projectPath?: string } = {}): Promise<ExternalMcpScanResult> => {
      try {
        return await scanExternalMcp({ projectPath });
      } catch (error) {
        return scanErrorReport(error);
      }
    },
  );

  registrar.handle(IPC.invoke.mcpImportRun, async (payload: McpImportRunPayload) => {
    const host = getHost();
    if (!host) throw new Error("host unavailable");
    const hostCall: HostCall = (method, params) => host.call(method, params);
    const result = await runMcpImport(hostCall, payload);
    if (result.imported.length) {
      if (refreshUserMcp && currentWorkspacePath) {
        await refreshUserMcp(currentWorkspacePath()).catch(() => undefined);
      }
      sendToRenderer(IPC.event.pluginChanged, { reason: "mcp" });
    }
    return result;
  });
}

export type { McpCandidate, McpScanResult, SkillCandidate, SkillScanResult };
