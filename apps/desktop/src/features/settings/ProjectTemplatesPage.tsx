import { useAppStore } from "../../stores/app-store";
import { TemplateManager } from "../project-workbench/TemplateEditor";
import { DefaultProjectLocation } from "../project-create/DefaultProjectLocation";

/*
  mc-agent (R1.4): the one place to manage resource-folder templates, so they
  can be edited before any template project exists. The create dialog and the
  project workbench link here.
*/
export function ProjectTemplatesPage() {
  const showToast = useAppStore((state) => state.showToast);
  return (
    <div className="settings-stack">
      <DefaultProjectLocation />
      <TemplateManager onError={(message) => showToast(message, { variant: "error" })} />
    </div>
  );
}
