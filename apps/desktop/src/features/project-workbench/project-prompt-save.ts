import { api } from "../../lib/api";
import { withProjectPromptTemplate } from "./project-prompt";

/**
 * Store the project's template choice against the configuration as saved now,
 * so edits made elsewhere since the dialog opened are kept.
 */
export async function saveProjectPromptTemplate(
  paths: readonly string[],
  primaryPath: string,
  templateId: string,
): Promise<void> {
  const { config } = await api.getSystemPromptConfig();
  const next = withProjectPromptTemplate(config, paths, primaryPath, templateId);
  if (JSON.stringify(next.projectRules) === JSON.stringify(config.projectRules)) return;
  await api.setSystemPromptConfig(next);
}
