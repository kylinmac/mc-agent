/**
 * mc-agent (R43): Settings → Mobile access.
 *
 * Allows enabling/disabling the `mc-mobile-gateway` (iroh P2P/Relay),
 * generating one-time QR / URI pairing codes, and revoking paired mobile
 * devices with instant disconnect.
 */
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  MobileDeviceInfo,
  MobileGatewayStatus,
  MobilePairingOffer,
} from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { IconCopy, IconReview, IconTrash } from "../../components/icons";
import { Button, SettingsToggle } from "../../components/ui";
import { SettingsCard, SettingsRow } from "./primitives";

function formatRemaining(expiresAtSec: number, nowMs: number): string {
  const secs = Math.max(0, expiresAtSec - Math.floor(nowMs / 1000));
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return `${mins}:${String(rem).padStart(2, "0")}`;
}

function formatTimestamp(unixSec: number): string {
  if (!unixSec) return "—";
  try {
    return new Date(unixSec * 1000).toLocaleString();
  } catch {
    return "—";
  }
}

export function MobileAccessPage() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<MobileGatewayStatus | null>(null);
  const [offer, setOffer] = useState<MobilePairingOffer | null>(null);
  const [busy, setBusy] = useState<"toggle" | "pair" | string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const refresh = useCallback(async () => {
    try {
      const current = await api.mcMobile.status();
      setStatus(current);
      setError(current.error ?? null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }, []);

  useEffect(() => {
    void refresh();
    return api.mcMobile.onStatusChanged((next) => {
      setStatus(next);
      if (next.error) setError(next.error);
      else if (next.state === "running" || next.state === "stopped") setError(null);
    });
  }, [refresh]);

  useEffect(() => {
    if (!offer) return;
    const id = window.setInterval(() => {
      const current = Date.now();
      setNowMs(current);
      if (offer.expiresAt <= Math.floor(current / 1000)) {
        setOffer(null);
      }
    }, 1000);
    return () => window.clearInterval(id);
  }, [offer]);

  const onToggleEnabled = async (next: boolean) => {
    setBusy("toggle");
    setError(null);
    try {
      const updated = await api.mcMobile.setEnabled(next);
      setStatus(updated);
      if (!next) setOffer(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(null);
    }
  };

  const onCreatePair = async () => {
    setBusy("pair");
    setError(null);
    try {
      const created = await api.mcMobile.createPair();
      setOffer(created);
      setNowMs(Date.now());
      setCopied(false);
      await refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(null);
    }
  };

  const onCopyUri = async () => {
    if (!offer) return;
    try {
      await navigator.clipboard.writeText(offer.pairUri);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError(t("mcProject.mobileCopyFailed"));
    }
  };

  const onRevoke = async (device: MobileDeviceInfo) => {
    setBusy(device.deviceId);
    setError(null);
    try {
      const res = await api.mcMobile.revokeDevice(device.deviceId);
      setStatus(res.status);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(null);
    }
  };

  const state = status?.state ?? "stopped";
  const enabled = status?.enabled === true;
  const devices = status?.devices ?? [];
  const stateLabelKey =
    state === "running"
      ? "mcProject.mobileStateRunning"
      : state === "starting"
        ? "mcProject.mobileStateStarting"
        : state === "error"
          ? "mcProject.mobileStateError"
          : "mcProject.mobileStateStopped";

  const qrDataUrl = offer
    ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(offer.qrSvg)}`
    : null;

  return (
    <div className="settings-stack">
      <SettingsCard>
        <SettingsRow
          title={t("mcProject.mobileEnableTitle")}
          description={t("mcProject.mobileEnableDesc")}
        >
          <SettingsToggle
            checked={enabled}
            disabled={busy === "toggle"}
            onChange={() => void onToggleEnabled(!enabled)}
            label={t("mcProject.mobileEnableTitle")}
          />
        </SettingsRow>
        <SettingsRow
          title={t("mcProject.mobileStatusTitle")}
          description={
            status?.nodeId
              ? t("mcProject.mobileNodeSummary", {
                  nodeId: `${status.nodeId.slice(0, 10)}…${status.nodeId.slice(-6)}`,
                  transport: status.relay
                    ? t("mcProject.mobileTransportRelayReady")
                    : t("mcProject.mobileTransportLanOnly"),
                })
              : t("mcProject.mobileStatusIdleDesc")
          }
        >
          <span className={`mc-mobile-pill is-${state}`}>
            {t(stateLabelKey)}
          </span>
        </SettingsRow>
        {error && <div className="mc-mobile-error">{error}</div>}
      </SettingsCard>

      <SettingsCard>
        <SettingsRow
          title={t("mcProject.mobilePairTitle")}
          description={t("mcProject.mobilePairDesc")}
        >
          <Button
            variant="primary"
            disabled={busy !== null}
            onClick={() => void onCreatePair()}
          >
            <IconReview size={14} />
            {offer ? t("mcProject.mobilePairRefresh") : t("mcProject.mobilePairGenerate")}
          </Button>
        </SettingsRow>

        {offer && qrDataUrl && (
          <div className="mc-mobile-pair-panel">
            <div className="mc-mobile-qr-frame">
              <img
                src={qrDataUrl}
                alt={t("mcProject.mobilePairQrAlt")}
                className="mc-mobile-qr-img"
              />
            </div>
            <div className="mc-mobile-pair-info">
              <div className="mc-mobile-pair-meta">
                {t("mcProject.mobilePairExpiresIn", {
                  time: formatRemaining(offer.expiresAt, nowMs),
                })}
              </div>
              <code className="mc-mobile-pair-uri">{offer.pairUri}</code>
              <div className="mc-mobile-pair-actions">
                <Button variant="secondary" onClick={() => void onCopyUri()}>
                  <IconCopy size={14} />
                  {copied ? t("mcProject.mobileCopied") : t("mcProject.mobileCopyCode")}
                </Button>
              </div>
            </div>
          </div>
        )}
      </SettingsCard>

      <SettingsCard>
        <SettingsRow
          title={t("mcProject.mobileDevicesTitle")}
          description={t("mcProject.mobileDevicesDesc")}
        >
          <span className="mc-mobile-pill">{devices.length}</span>
        </SettingsRow>
        {devices.length === 0 ? (
          <div className="mc-mobile-empty">{t("mcProject.mobileDevicesEmpty")}</div>
        ) : (
          <div className="mc-mobile-device-list">
            {devices.map((device) => (
              <div key={device.deviceId} className="mc-mobile-device-row">
                <div className="mc-mobile-device-info">
                  <div className="mc-mobile-device-name">
                    <span
                      className={`mc-mobile-dot ${device.online ? "is-online" : "is-offline"}`}
                    />
                    <span>{device.name}</span>
                    <span className="mc-mobile-platform">{device.platform}</span>
                  </div>
                  <div className="mc-mobile-device-meta">
                    {device.online
                      ? t("mcProject.mobileDeviceOnline")
                      : t("mcProject.mobileDeviceLastSeen", {
                          time: formatTimestamp(device.lastSeenAt),
                        })}
                  </div>
                </div>
                <Button
                  variant="secondary"
                  disabled={busy === device.deviceId}
                  onClick={() => void onRevoke(device)}
                >
                  <IconTrash size={14} />
                  {t("mcProject.mobileRevoke")}
                </Button>
              </div>
            ))}
          </div>
        )}
      </SettingsCard>

      <div className="mc-mobile-security-note">{t("mcProject.mobileSecurityNote")}</div>
    </div>
  );
}
