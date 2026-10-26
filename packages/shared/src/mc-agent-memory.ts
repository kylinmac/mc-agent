/**
 * mc-agent: project memory entries the agent writes with its `Remember` tool
 * (MC-ADR-0019). They live beside the user's own entries and are told apart
 * by their id, so the user can see, edit or delete them like any other.
 */
export const AGENT_MEMORY_ID_PREFIX = "agent-";
export const AGENT_MEMORY_TITLE_MAX = 80;
export const AGENT_MEMORY_CONTENT_MAX = 2_000;
/** The agent may keep this many entries per project; the user's are not counted. */
export const AGENT_MEMORY_MAX_ENTRIES = 40;

export function isAgentMemoryEntry(entry: { id: string }): boolean {
  return entry.id.startsWith(AGENT_MEMORY_ID_PREFIX);
}
