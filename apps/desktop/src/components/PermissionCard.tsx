import { useMemo, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import type { PendingPermission } from "../lib/pending-permissions";
import { useAppStore } from "../stores/app-store";
import { buildToolPresentation } from "../lib/tool-presentation";
import { ToolDetailBlocks } from "./ToolDetails";
import { Button, Field, Select } from "./ui";
import { isGlobalPermissionMode, type GlobalPermissionMode } from "@pi-desktop/shared";
import { ScheduledModelPicker } from "../features/scheduled/ScheduledModelPicker";
import type { ScheduledModelSelection } from "../features/scheduled/ScheduledExecutionSettings";
import { PERMISSION_MODE_I18N_KEYS } from "../lib/permission-mode-labels";

export function PermissionCard({
  permission,
  queued = 0,
}: {
  permission: PendingPermission;
  /** Requests waiting behind this one; the user answers them in order. */
  queued?: number;
}) {
  const { t } = useTranslation();
  const resolvePermission = useAppStore((state) => state.resolvePermission);
  const showToast = useAppStore((state) => state.showToast);
  const workspace = useAppStore((state) =>
    state.sessions.find((session) => session.id === permission.sessionId)?.projectPath,
  );
  const creatingTask = permission.toolName === "ScheduledTaskCreate" && !permission.sessionId.startsWith("remote:");
  const defaultModel = useAppStore((s) => s.settings?.scheduledDefaultModel);
  const [modelOverride, setTaskModel] = useState<ScheduledModelSelection>();
  const taskModel = modelOverride ?? defaultModel ?? {};
  const [taskMode, setTaskMode] = useState<GlobalPermissionMode>("ask");
  const [resolving, setResolving] = useState(false);

  const restoreComposerFocus = () => {
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLTextAreaElement>(".composer-input")?.focus();
    });
  };

  const resolve = async (
    decision: "allow-once" | "allow-session" | "deny",
  ) => {
    if (resolving) return;
    setResolving(true);
    try {
      await resolvePermission(permission.sessionId, permission.requestId, decision,
        creatingTask && decision === "allow-once" ? { scheduledPermissionMode: taskMode, scheduledModel: taskModel } : undefined);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), {
        variant: "error",
      });
      setResolving(false);
    } finally {
      restoreComposerFocus();
    }
  };

  // Same structured presentation as the transcript tool rows: a command reads
  // as shell, file content as code, everything else as labeled fields.
  const argBlocks = useMemo(
    () =>
      buildToolPresentation({
        toolName: permission.toolName,
        toolArgs: permission.argsPreview,
      }),
    [permission.argsPreview, permission.toolName],
  );
  const risk = (permission.risk || "high") as "low" | "medium" | "high";

  return (
    <section
      className={`permission-card risk-${risk}`}
      role="region"
      aria-label={t("permission.title")}
    >
      <div className="permission-card-header">
        <span className="permission-card-title" role="status" aria-live="polite">
          {t("permission.title")}
        </span>
        {queued > 0 ? (
          <span className="permission-card-queued">
            {t("permission.queued", { count: queued })}
          </span>
        ) : null}
        <span className={`permission-risk risk-${risk}`}>
          {t(`permission.risk.${risk}`)}
        </span>
      </div>
      {permission.agentName ? (
        <div className="permission-card-agent">
          {t("permission.fromSubagent", { agent: permission.agentName })}
        </div>
      ) : null}
      <div className="permission-card-prompt">
        <Trans
          i18nKey="permission.allowPrompt"
          values={{ tool: permission.toolName }}
          components={{ highlight: <span className="text-text-primary" /> }}
        />
      </div>
      {permission.reason && !creatingTask ? (
        <div className="permission-card-reason">
          {permission.toolName === "WorkPanelAction" && permission.reason === "Interactive terminal actions require approval because the pending command and program state are unknown."
            ? t("mcProject.terminalApprovalReason")
            : permission.reason}
        </div>
      ) : null}
      {argBlocks.length > 0 ? (
        <div className="permission-card-args">
          <ToolDetailBlocks blocks={argBlocks} />
        </div>
      ) : null}
      <div className="permission-card-meta">
        <span title={workspace}>
          {t("permission.workspace", {
            workspace: workspace || t("permission.temporarySession"),
          })}
        </span>
      </div>
      {creatingTask && (
        <Field label={t("scheduled.detailPermission")}>
          <Select value={taskMode} disabled={resolving}
            onChange={(event) => {
              if (isGlobalPermissionMode(event.target.value)) setTaskMode(event.target.value);
            }}>
            {(["ask", "accept-edits", "auto"] as const).map((mode) => (
              <option key={mode} value={mode}>{t(PERMISSION_MODE_I18N_KEYS[mode])}</option>
            ))}
          </Select>
          {taskMode === "auto" && <span>{t("scheduled.autoPermissionHint")}</span>}
        </Field>
      )}
      {creatingTask && (
        <ScheduledModelPicker value={taskModel} disabled={resolving} onChange={setTaskModel} />
      )}
      <div className="permission-card-actions">
        <Button
          variant="ghost"
          disabled={resolving}
          onClick={() => void resolve("deny")}
        >
          {t("permission.deny")}
        </Button>
        {!creatingTask && <Button
          variant="secondary"
          disabled={resolving}
          onClick={() => void resolve("allow-session")}
        >
          {t("permission.allowSession")}
        </Button>}
        <Button
          variant="primary"
          disabled={resolving}
          onClick={() => void resolve("allow-once")}
        >
          {t(creatingTask ? "scheduled.create" : "permission.allowOnce")}
        </Button>
      </div>
    </section>
  );
}
