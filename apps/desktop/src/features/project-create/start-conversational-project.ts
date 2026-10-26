import { useAppStore } from "../../stores/app-store";
import { useNewProjectIntent } from "./new-project-intent";

/**
 * mc-agent (MC-ADR-0023): the entry points other than the home composer.
 * Open a fresh chat outside any project with the composer armed, so the next
 * message the user sends describes the project to create.
 */
export async function startConversationalProject(): Promise<void> {
  const state = useAppStore.getState();
  if (state.createProjectDialogOpen) state.closeProjectDialog();
  try {
    await state.newSession({ projectPath: null });
    useNewProjectIntent.getState().arm();
  } catch (error) {
    state.showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
  }
}
