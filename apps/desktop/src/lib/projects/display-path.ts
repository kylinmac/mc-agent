/**
 * The folder a project row shows (mc-agent). Once a project has a resource
 * folder it is the primary path, but users know a project by its code; show
 * the first workspace, and fall back to the primary path.
 */
export function projectDisplayPath(project: {
  path: string;
  roots: ReadonlyArray<{ path: string; kind?: "workspace" | "resources" | "reference" }>;
}): string {
  return (
    project.roots.find((root) => !root.kind || root.kind === "workspace")?.path ??
    project.roots.find((root) => root.kind !== "resources")?.path ??
    project.path
  );
}
