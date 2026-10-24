/** Classify bounded local codes; never display raw provider or network errors. */
export function dictationErrorKey(error: unknown): string {
  if (!(error instanceof Error)) return "failed";
  if (error.name === "NotAllowedError") return "permission";
  if (error.name === "NotFoundError" || error.name === "NotReadableError" || error.name === "OverconstrainedError") return "deviceFailed";
  const code = error.message;
  if (code === "DICTATION_BUSY" || code === "LIVE_MICROPHONE_BUSY") return "busy";
  if (code === "DICTATION_FINAL_TRANSCRIPT_TIMEOUT") return "incomplete";
  if (code === "DICTATION_CANCELLED_OR_TIMEOUT") return "timedOut";
  if (code === "DICTATION_PROVIDER_UNAVAILABLE" || code === "DICTATION_AUTH_FAILED" || code === "DICTATION_HTTP_401") return "authFailed";
  if (code === "DICTATION_HTTP_403") return "accessDenied";
  if (code === "DICTATION_HTTP_400" || code === "DICTATION_HTTP_422") return "requestRejected";
  if (code === "DICTATION_HTTP_404") return "endpointNotFound";
  if (code === "DICTATION_HTTP_429") return "rateLimited";
  if (/^DICTATION_HTTP_5\d{2}$/.test(code)) return "serviceUnavailable";
  if (code === "DICTATION_REQUEST_FAILED") return "requestFailed";
  return "failed";
}
