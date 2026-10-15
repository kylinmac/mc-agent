/**
 * The "project folders" note a session receives when its project has more
 * than one folder (mc-agent R1.5 / R10, MC-ADR-0003).
 *
 * Every launch path (desktop session launch, sidecar instruction refresh,
 * headless launch resolver) builds the same note from `project.group.context`,
 * so the wording lives here once. Workspaces are equal: the note names the
 * session's start folder, the project's resource folder, and every other
 * workspace with its description from `workspaces.md`.
 */

export type ProjectFolderGuideRoot = {
  path?: string;
  kind?: "workspace" | "resources";
};

export type ProjectFolderGuideNote = {
  path: string;
  heading?: string;
  description?: string;
};

export type ProjectFolderGuideInput = {
  roots: readonly ProjectFolderGuideRoot[];
  /** The folder this session starts in (its project path). */
  startPath: string;
  notes?: readonly ProjectFolderGuideNote[];
};

const MAX_DESCRIPTION_CHARS = 300;

function comparable(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/+$/, "");
}

function folderName(path: string): string {
  return comparable(path).split("/").pop() || path;
}

/** One line of description; long or multi-line text is shortened. */
function oneLine(description: string | undefined): string {
  const text = (description ?? "").replace(/\s+/g, " ").trim();
  return text.length > MAX_DESCRIPTION_CHARS ? `${text.slice(0, MAX_DESCRIPTION_CHARS - 1)}…` : text;
}

/** Returns "" for a single-folder project, which needs no note. */
export function projectFolderGuide({ roots, startPath, notes = [] }: ProjectFolderGuideInput): string {
  const folders = roots.filter((root): root is ProjectFolderGuideRoot & { path: string } =>
    typeof root.path === "string" && root.path.length > 0,
  );
  if (folders.length <= 1) return "";
  const start = comparable(startPath);
  const describe = (root: { path: string; kind?: string }): string => {
    if (root.kind === "resources") return `Resource folder (project documents): ${root.path}`;
    const note = notes.find((candidate) => comparable(candidate.path) === comparable(root.path));
    const name = note?.heading || folderName(root.path);
    const description = oneLine(note?.description);
    return `Workspace "${name}": ${root.path}${description ? ` — ${description}` : ""}`;
  };
  const startRoot = folders.find((root) => comparable(root.path) === start);
  const lines = [
    "Project folders:",
    startRoot ? `- Start folder. ${describe(startRoot)}` : `- Start folder: ${startPath}`,
    ...folders.filter((root) => root !== startRoot).map((root) => `- ${describe(root)}`),
    "Use an absolute path when reading or editing a folder other than the start folder.",
    "A workspace may have its own AGENTS.md; read it before changing files there.",
  ];
  return lines.join("\n");
}
