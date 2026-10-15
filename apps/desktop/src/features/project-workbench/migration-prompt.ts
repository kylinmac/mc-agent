/**
 * The instruction for an AI-organized resource folder (mc-agent R5). The
 * session runs in Plan mode in the resource folder, so the model proposes and
 * the user approves before any file changes; these rules bound what the plan
 * may contain.
 */

export type MigrationPromptInput = {
  resourceFolder: string;
  /** Target categories: the chosen template's first-level folders. */
  categories: readonly string[];
  templateName: string;
  workspaces: ReadonlyArray<{ path: string; description?: string; kind?: "workspace" | "reference" }>;
};

export function migrationPrompt({
  resourceFolder,
  categories,
  templateName,
  workspaces,
}: MigrationPromptInput): string {
  const categoryList = categories.length > 0 ? categories.map((name) => `- ${name}/`).join("\n") : "- (no categories; keep files at the folder root)";
  const list = (kind: "workspace" | "reference") => {
    const folders = workspaces.filter((workspace) => (workspace.kind ?? "workspace") === kind);
    return folders.length > 0
      ? folders
          .map((workspace) => `- ${workspace.path}${workspace.description ? ` — ${workspace.description}` : ""}`)
          .join("\n")
      : "- (none)";
  };
  return [
    `Organize this project's documents into its resource folder using the "${templateName}" template.`,
    "",
    `Resource folder: ${resourceFolder}`,
    "Target categories (first-level folders of the resource folder). This list is complete; do not look for the template elsewhere:",
    categoryList,
    "",
    "Development workspaces (code; their descriptions say what each one is):",
    list("workspace"),
    "",
    "Reference folders (external documents and materials, not code):",
    list("reference"),
    "",
    "Rules:",
    "0. Only access the resource folder and the folders listed above; do not browse their parent folders or any other path. Read each folder's description and treat it accordingly: index the documents of a reference folder; do not organize it as code.",
    "1. First produce a plan as a table: source file, target category, and INDEX, MOVE or DRAFT. Do not change any file before the plan is approved.",
    "2. Do not copy documents out of a workspace. INDEX a workspace document by adding one line to the target category's INDEX.md: `- [Title](<path relative to that INDEX.md>)`. Create INDEX.md with a `# Index` heading if it is missing, and keep its other lines. Never modify, move or delete anything inside a workspace.",
    "3. MOVE is allowed only for files already inside the resource folder (for example to re-sort them into the target categories).",
    "4. Create missing category folders only inside the resource folder.",
    "5. Only include project documents (requirements, designs, specs, references, notes). Skip source code, build output, dependencies, secrets, and binaries.",
    "6. Never overwrite an existing file; add a numeric suffix instead. Leave workspaces.md and AGENTS.md at the resource folder root untouched.",
    "7. If a target category has no matching document anywhere, DRAFT one: write a new Markdown file into that category folder, based only on what you read in the folders above. Start it with `> AI draft — sources: <files you used>` and do not invent facts; mark open questions as such. Put drafted files in the plan as DRAFT.",
    "8. After executing the approved plan, list what was indexed, moved or drafted and anything that failed.",
    "",
    "Answer in the user's language.",
  ].join("\n");
}
