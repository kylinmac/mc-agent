import type { ExternalImportScanError, ExternalImportWriteError } from "@pi-desktop/shared";

export function scanReadError(error: NodeJS.ErrnoException): ExternalImportScanError {
  return error.code === "EACCES" || error.code === "EPERM" ? "permission-denied" : "source-unreadable";
}

export function importWriteError(error: unknown): ExternalImportWriteError | "exists" {
  if (!(error instanceof Error)) return "import-failed";
  const code = "errorCode" in error ? error.errorCode : "code" in error ? error.code : undefined;
  // Host validation messages can quote user input. Match only the registry's conflict templates.
  if (error.message === "already exists" ||
      /^(MCP_INVALID: a server|SKILL_INVALID: a skill) with this (id|name) already exists at this level$/.test(error.message) ||
      error.message.startsWith("SKILL_INVALID: destination already exists: ")) return "exists";
  switch (code) {
    case "EACCES":
    case "EPERM":
    case "UNAUTHORIZED":
    case "PERMISSION_DENIED":
    case "PERMISSION_REQUIRED": return "permission-denied";
    case "MCP_INVALID": return "invalid-mcp";
    case "SKILL_INVALID": return /^SKILL_INVALID: import (directory |file )?source does not exist$/.test(error.message)
      ? "source-missing" : "invalid-skill";
    case "CAPABILITY_INVALID": return "invalid-destination";
    case "HOST_UNAVAILABLE": return "host-unavailable";
    default: return "import-failed";
  }
}
