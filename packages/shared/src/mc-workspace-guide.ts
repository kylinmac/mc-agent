/**
 * mc-agent (R40): workspace artifact placement & work-panel guidance.
 *
 * Complementary to `projectFolderGuide` (which only fires for multi-folder
 * projects). Gives the model a concise, consistent contract for keeping new
 * files inside the active workspace and pointing users to the right work-panel
 * tabs (Files, Changes/Diff review annotations, Terminal, Canvas).
 */

export type WorkspaceArtifactGuideInput = {
  workspacePath?: string | null;
  resourcePath?: string | null;
  remote?: boolean;
};

/**
 * Returns a short, deterministic prompt note when the session has a workspace
 * path, or "" when no workspace is attached.
 */
export function workspaceArtifactGuide({
  workspacePath,
  resourcePath,
  remote = false,
}: WorkspaceArtifactGuideInput): string {
  const workspace = typeof workspacePath === "string" ? workspacePath.trim() : "";
  if (!workspace) return "";
  const resource = typeof resourcePath === "string" ? resourcePath.trim() : "";
  const locationRule = resource && resource !== workspace
    ? `Keep newly created source files, demos, and scaffolds inside the session workspace (${workspace}), and project documents inside the project resource folder (${resource}) unless the user explicitly specifies another path. Do not create deliverables in /tmp, ~, or Desktop where the app's file tree and change review cannot see them.`
    : `Keep newly created files, demos, reports, and scaffolds inside the session workspace (${workspace}) unless the user explicitly specifies another path. Do not create deliverables in /tmp, ~, or Desktop where the app's file tree and change review cannot see them.`;

  const panelLine = remote
    ? "The right-side work panel displays workspace files and change diffs live; mention relevant paths so the user can review edits there."
    : "The right-side work panel displays this workspace live with tabs for Files, Changes (line-level diff review & annotations), Terminal, and Canvas (HTML prototype preview and Excalidraw whiteboard). After producing files, web prototypes, or diagrams, briefly point the user to the matching work-panel tab when helpful.";

  return `Workspace artifacts & work panel:\n- ${locationRule}\n- ${panelLine}`;
}
