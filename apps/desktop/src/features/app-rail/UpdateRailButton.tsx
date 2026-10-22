import { useTranslation } from "react-i18next";
import { TooltipButton, cx } from "../../components/ui";
import { IconTriangleAlert, IconDownload, IconRefresh } from "../../components/icons";
import { useUpdateState } from "../../hooks/use-update-state";
import { api } from "../../lib/api";

/*
  mc-agent: the update button above Settings in the app rail. It appears once
  a newer version is found and the install can update itself: click to
  download (the ring fills as it downloads), then click again to restart into
  the new version. A failed download turns it into a retry.
*/
export function UpdateRailButton() {
  const { t } = useTranslation();
  const update = useUpdateState();
  const version = update?.availableVersion;
  if (!update || !version) return null;
  const selfUpdating = update.selfInstall === true || update.mode === "in-app";
  const status = update.status;
  if (!selfUpdating) return null;
  if (status === "available" && update.dismissed) return null;
  if (!["available", "downloading", "downloaded", "error"].includes(status)) return null;

  const progress = Math.max(0, Math.min(100, update.progressPercent ?? 0));
  const tooltip =
    status === "downloading"
      ? t("updates.downloading", { percent: Math.round(progress) })
      : status === "downloaded"
        ? t("mcProject.updateRestartTo", { version })
        : status === "error"
          ? t("mcProject.updateRetry", { error: update.error ?? "" })
          : t("mcProject.updateDownload", { version });

  return (
    <TooltipButton
      type="button"
      tooltipSide="right"
      className={cx("app-rail-update", `is-${status}`)}
      data-nav="update"
      tooltip={tooltip}
      ariaLabel={tooltip}
      aria-busy={status === "downloading"}
      style={status === "downloading" ? { ["--update-progress" as string]: `${progress}%` } : undefined}
      onClick={() => {
        if (status === "downloading") return;
        if (status === "downloaded") void api.updatesInstall().catch(() => undefined);
        else void api.updatesDownload().catch(() => undefined);
      }}
    >
      {status === "downloaded" ? (
        <IconRefresh size={15} aria-hidden />
      ) : status === "error" ? (
        <IconTriangleAlert size={15} aria-hidden />
      ) : (
        <IconDownload size={15} aria-hidden />
      )}
    </TooltipButton>
  );
}
