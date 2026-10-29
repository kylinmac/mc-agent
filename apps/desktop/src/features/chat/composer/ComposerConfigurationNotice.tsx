import type { TFunction } from "i18next";
import type { AppState } from "../../../stores/app-state";
import { Badge } from "../../../components/ui";

type ConfigurationStatus = AppState["sessionConfigurationStatus"][string];

export function configurationNotice(t: TFunction, status?: ConfigurationStatus): string | undefined {
  const keys = {
    pending: "chat.configurationPending",
    applying: "chat.configurationApplying",
    failed: "chat.configurationFailed",
  };
  return status ? t(keys[status]) : undefined;
}

export function ComposerConfigurationNotice({ t, status }: { t: TFunction; status?: ConfigurationStatus }) {
  const notice = configurationNotice(t, status);
  return notice ? (
    <div className="composer-configuration-notice" role="status">
      <Badge tone={status === "failed" ? "error" : "warning"}>{notice}</Badge>
    </div>
  ) : null;
}
