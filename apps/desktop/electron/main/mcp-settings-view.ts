import type { McpServerRecord, McpServerSettingsRecord, McpServerStatus } from "@pi-desktop/shared";

export function mcpCommandLabel(command?: string): string | undefined {
  const basename = command?.split(/[\\/]/).at(-1);
  return basename && /^[\w.-]+$/.test(basename) ? basename : undefined;
}

export function mcpUrlOrigin(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}

export function mcpSettingsRecord(record: McpServerRecord): McpServerSettingsRecord {
  const { id, label, level, projectPath, path, description, transport, timeoutSeconds, enabled, scope, createdAt, updatedAt } = record;
  return {
    id, label, level, projectPath, path, description, transport, timeoutSeconds, enabled, scope, createdAt, updatedAt,
    commandLabel: mcpCommandLabel(record.command), urlOrigin: mcpUrlOrigin(record.url),
    hasArgs: Boolean(record.args?.length), envKeys: Object.keys(record.env ?? {}), headerKeys: Object.keys(record.headers ?? {}),
  };
}

export function mcpSettingsStatus(status: McpServerStatus): McpServerStatus {
  // Transport errors can contain complete command lines, URLs or server-supplied text.
  const { message: _transportError, ...summary } = status;
  return summary;
}
