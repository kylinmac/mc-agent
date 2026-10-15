/**
 * Following a resource folder that moved because its project was renamed
 * (mc-agent R1.3). host-core rewrites its own records; the renderer only has
 * to stop pointing at the old path.
 */

export type ResourceMove = { from: string; to: string };

export type ProjectRenameResult = {
  resourcesMoved?: ResourceMove;
  resourcesRenameError?: string;
};

function comparable(path: string | null | undefined): string {
  return (path ?? "").replaceAll("\\", "/").replace(/\/+$/, "");
}

/** Which open entries to close and which path to reopen, if any. */
export function planResourceMove(
  state: { workspacePath?: string | null; openProjectPaths: readonly string[] },
  move: ResourceMove,
): { close: string[]; activate: string | null } {
  const from = comparable(move.from);
  const close = state.openProjectPaths.filter((path) => comparable(path) === from);
  const active = comparable(state.workspacePath) === from;
  return { close, activate: active || close.length > 0 ? move.to : null };
}
