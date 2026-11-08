/**
 * mc-agent: how update requests present themselves, and how their failures
 * read in the UI.
 *
 * GitHub's release pages (`/releases/latest`, `/releases/download/...`) may
 * answer non-browser clients such as electron-updater's default
 * `electron-builder` agent or Node's `node` with 503/504 while a browser opening
 * the same URL gets through (seen 2026-11-08). Update checks and downloads
 * therefore send Electron's own Chromium user agent.
 */

/** Used only when Electron gives no browser-style agent (tests, odd builds). */
const FALLBACK_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

export function updateUserAgent(electronFallback: string | undefined): string {
  const agent = electronFallback?.trim();
  return agent?.startsWith("Mozilla/") ? agent : FALLBACK_USER_AGENT;
}

/** Same request, with the update user agent set. */
export function withUpdateUserAgent(init: RequestInit | undefined, userAgent: string): RequestInit {
  const headers = new Headers(init?.headers);
  headers.set("User-Agent", userAgent);
  return { ...init, headers };
}

const MAX_ERROR_CHARS = 300;

/**
 * electron-updater's HTTP errors embed the response headers (cookies
 * included), the body and the whole releases feed. The UI gets one short
 * line; the full text stays in the log.
 */
export function conciseUpdateError(message: string): string {
  const status = /HttpError: (\d{3})\b/.exec(message)?.[1];
  if (status) return `GitHub did not answer the update request (HTTP ${status}); try again later`;
  const first = message.split(/\r?\n|\\n| Headers: | Data:|, XML:/)[0]!.replace(/\s+/g, " ").trim();
  return first.length <= MAX_ERROR_CHARS ? first : `${first.slice(0, MAX_ERROR_CHARS - 1)}…`;
}
