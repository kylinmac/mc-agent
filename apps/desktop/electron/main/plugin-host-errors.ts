


export type PluginApiError = Error & { code?: string };

export function apiError(code: string, message: string): PluginApiError {
  const err = new Error(message) as PluginApiError;
  err.code = code;
  return err;
}

/**
 * Error code one host API call answers with. Host services classify their own
 * failures as `errorCode` (agent-runtime, host-core) while this runtime's own
 * refusals carry `code`; the broker forwards whichever is present so a plugin
 * can branch on the same documented code the app uses instead of reading every
 * service failure as a generic one. Every other host boundary reads the same
 * precedence — `data.errorCode`, then `errorCode`, then `code`.
 */
export function pluginCallErrorCode(error: unknown): string {
  const candidate = error as
    | { code?: string; errorCode?: string; data?: { errorCode?: string } }
    | null
    | undefined;
  return (
    candidate?.data?.errorCode ??
    candidate?.errorCode ??
    candidate?.code ??
    "PLUGIN_API_FAILED"
  );
}
