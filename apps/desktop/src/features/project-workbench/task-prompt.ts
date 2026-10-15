/**
 * The first message of a task run (mc-agent R7): the task's goal, its
 * acceptance criteria, and the exact resources it relies on with their
 * confirmation state, so the session works from a known basis.
 */

export type TaskPromptInput = {
  title: string;
  goal: string;
  acceptance: string;
  resources: ReadonlyArray<{ title: string; path?: string; url?: string; status: string }>;
  previousRejection?: string;
};

export function taskPrompt({ title, goal, acceptance, resources, previousRejection }: TaskPromptInput): string {
  const lines = [`Task: ${title}`, ""];
  if (goal.trim()) lines.push("Goal:", goal.trim(), "");
  lines.push("Acceptance criteria (the work is reviewed against these):", acceptance.trim(), "");
  if (resources.length > 0) {
    lines.push("Resources to work from (read them before changing anything):");
    for (const resource of resources) {
      const location = resource.path ?? resource.url ?? "";
      const state = resource.status === "draft" ? " (draft, not yet confirmed)" : "";
      lines.push(`- ${resource.title}: ${location}${state}`);
    }
    lines.push("");
  }
  if (previousRejection?.trim()) {
    lines.push("The previous attempt was not accepted:", previousRejection.trim(), "");
  }
  lines.push(
    "When you finish, summarize what changed and how each acceptance criterion was verified. Do not claim a criterion is met without checking it.",
  );
  return lines.join("\n");
}
