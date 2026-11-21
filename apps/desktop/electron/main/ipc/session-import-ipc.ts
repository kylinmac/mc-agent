import {
  IPC,
  SESSION_IMPORT_SOURCES,
  sessionImportKey,
  type ImportRunResult,
  type SessionImportCandidate,
  type SessionImportScanResult,
  modelConfigImportKey,
  publicModelConfigCandidate,
  draftMatchesExisting,
  providerCreateInputFromDraft,
  isModelConfigImportSource,
  type ModelConfigImportDraft,
} from "@pi-desktop/shared";
import {
  convertSession,
  importPiDesktop,
  scanAllSources,
  scanModelConfigs,
  scanPiDesktop,
  type ExternalSessionSummary,
} from "../importers";
import type { HostProcess } from "../host-process";
import type { Logger } from "../logger";
import type { IpcRegistrar } from "./types";

function publicSessionCandidate(session: ExternalSessionSummary): SessionImportCandidate {
  const { source, externalId, title, projectPath, model, createdAt, updatedAt, messageCount } = session;
  return { source, externalId, title, projectPath, model, createdAt, updatedAt, messageCount };
}

function importSelectionKey(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const source = Reflect.get(value, "source");
  const externalId = Reflect.get(value, "externalId");
  if (typeof externalId !== "string" || !externalId) return null;
  const knownSource = SESSION_IMPORT_SOURCES.find((entry) => entry === source);
  return knownSource ? sessionImportKey({ source: knownSource, externalId }) : null;
}

function modelConfigSelectionKey(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const source = Reflect.get(value, "source");
  const externalId = Reflect.get(value, "externalId");
  if (
    !isModelConfigImportSource(source) ||
    typeof externalId !== "string" ||
    !externalId
  ) {
    return null;
  }
  return modelConfigImportKey(source, externalId);
}

export function registerSessionImportIpc({ registrar, getHost, logger }: {
  registrar: IpcRegistrar;
  getHost: () => HostProcess | null;
  logger: Pick<Logger, "app">;
}): void {
  let scannedImportSessions = new Map<string, ExternalSessionSummary>();
  let scannedModelConfigs = new Map<string, ModelConfigImportDraft>();

  registrar.handle(IPC.invoke.sessionImportScan, async (): Promise<SessionImportScanResult> => {
    const host = getHost();
    const scanned = await scanAllSources();
    const { truncated } = scanned;
    // mc-agent (MC-ADR-0009): an installed PI-Desktop, copied by host-core.
    let piDesktop: ExternalSessionSummary[] = [];
    if (host) {
      try {
        piDesktop = await scanPiDesktop(host);
      } catch (error) {
        logger.app("session", "warn", "pi-desktop import scan failed", { data: { error: String(error) } });
      }
    }
    const sessions = [...scanned.sessions, ...piDesktop].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    scannedImportSessions = new Map(
      sessions.map((session) => [sessionImportKey(session), session]),
    );
    return {
      sessions: sessions.map(publicSessionCandidate),
      ...(Object.keys(truncated).length > 0 ? { truncated } : {}),
    };
  });

  registrar.handle(
    IPC.invoke.sessionImportRun,
    async (selections: unknown): Promise<ImportRunResult> => {
      const host = getHost();
      if (!host) throw new Error("host unavailable");
      let imported = 0;
      let skipped = 0;
      let failed = 0;
      const items = Array.isArray(selections) ? selections : [];
      const candidates = scannedImportSessions;
      const piDesktopIds: string[] = [];
      for (const selection of items) {
        const key = importSelectionKey(selection);
        const item = key ? candidates.get(key) : undefined;
        if (item?.source === "pi-desktop") {
          piDesktopIds.push(item.externalId);
          continue;
        }
        if (!item) {
          failed += 1;
          logger.app("session", "warn", "session import selection rejected", {
            data: { reason: "candidate was not returned by the latest scan" },
          });
          continue;
        }
        try {
          const converted = await convertSession(item);
          const res = await host.call<{ imported?: boolean }>("session.import", {
            // mc-agent (MC-ADR-0009): another agent's model is not configured
            // here; the conversation continues on this app's default model.
            session: { ...converted.session, modelId: null, providerId: null },
            messages: converted.messages,
          });
          if (res.imported) imported += 1;
          else skipped += 1;
        } catch (e) {
          failed += 1;
          logger.app("session", "warn", "session import failed", {
            data: { source: item?.source, externalId: item?.externalId, error: String(e) },
          });
        }
      }
      if (piDesktopIds.length) {
        try {
          const outcome = await importPiDesktop(host, piDesktopIds);
          imported += outcome.imported;
          skipped += outcome.skipped;
          failed += outcome.failed;
        } catch (e) {
          failed += piDesktopIds.length;
          logger.app("session", "warn", "pi-desktop import failed", { data: { error: String(e) } });
        }
      }
      logger.app("session", "info", "session import finished", {
        data: { imported, skipped, failed },
      });
      return { imported, skipped, failed };
    },
  );

  registrar.handle(IPC.invoke.modelConfigImportScan, async () => {
    const drafts = await scanModelConfigs();
    scannedModelConfigs = new Map(
      drafts.map((draft) => [modelConfigImportKey(draft.source, draft.externalId), draft]),
    );
    return { providers: drafts.map(publicModelConfigCandidate) };
  });
  registrar.handle(
    IPC.invoke.modelConfigImportRun,
    async (selections: unknown): Promise<ImportRunResult> => {
      const host = getHost();
      if (!host) throw new Error("host unavailable");
      let imported = 0;
      let skipped = 0;
      let failed = 0;
      const items = Array.isArray(selections) ? selections : [];
      const candidates = scannedModelConfigs;
      const existing = await host.call<{
        providers: Array<{
          id: string;
          baseUrl?: string | null;
          apiStyle?: string | null;
          vendorKey?: string | null;
          hasSecret?: boolean;
        }>;
      }>("providers.list", { includeDisabled: true });
      // Matching an import by endpoint alone collapses distinct credentials.
      // Resolve existing API keys in Electron main so same-endpoint profiles
      // remain independent without exposing secrets to the renderer.
      const known = await Promise.all(
        (existing.providers ?? []).map(async (provider) => {
          let secretValue: string | undefined;
          if (provider.hasSecret) {
            try {
              secretValue = (
                await host.call<{ value?: string }>("providers.getSecret", {
                  id: provider.id,
                })
              ).value;
            } catch {
              // A provider may only have an OAuth credential, or its secret
              // backend may be temporarily unavailable. In either case,
              // failing closed here avoids collapsing a new profile.
            }
          }
          return { ...provider, secretValue };
        }),
      );
      let firstImported:
        | { id: string; defaultModelId?: string; models?: Array<{ id: string }> }
        | undefined;
      for (const selection of items) {
        const key = modelConfigSelectionKey(selection);
        const draft = key ? candidates.get(key) : undefined;
        if (!draft) {
          failed += 1;
          logger.app("provider", "warn", "model config import selection rejected", {
            data: { reason: "candidate was not returned by the latest scan" },
          });
          continue;
        }
        if (draftMatchesExisting(draft, known)) {
          skipped += 1;
          continue;
        }
        try {
          const created = await host.call<{
            provider: { id: string; defaultModelId?: string; models?: Array<{ id: string }> };
          }>("providers.create", providerCreateInputFromDraft(draft));
          imported += 1;
          known.push({
            ...draft,
            id: created.provider.id,
            secretValue: draft.secretValue,
          });
          firstImported ??= created.provider;
        } catch (e) {
          failed += 1;
          logger.app("provider", "warn", "model config import failed", {
            data: {
              source: draft.source,
              externalId: draft.externalId,
              name: draft.name,
              hasSecret: draft.hasSecret,
              error: String(e),
            },
          });
        }
      }
      if (firstImported) {
        try {
          const settings = await host.call<{ defaultProviderId?: string }>("settings.get");
          if (!settings?.defaultProviderId) {
            await host.call("settings.set", {
              defaultProviderId: firstImported.id,
              defaultModelId:
                firstImported.models?.[0]?.id ?? firstImported.defaultModelId,
            });
          }
        } catch (e) {
          logger.app("provider", "warn", "model config import default not set", {
            data: { error: String(e) },
          });
        }
      }
      logger.app("provider", "info", "model config import finished", {
        data: { imported, skipped, failed },
      });
      return { imported, skipped, failed };
    },
  );
}
