import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type {
  ExternalImportBatchResult, ExternalImportScanError, ExternalImportScanResult,
  ExternalImportSelection, ExternalImportWriteError,
} from "@pi-desktop/shared";
import { Badge } from "../../../components/ui";
import { useAppStore } from "../../../stores/app-store";
import {
  ImportGroup, ImportIdle, ImportResults, ImportRow, ImportToolbar, groupBySource, toggleKey, useGroupDisclosure,
} from "../import-workbench";

type Reason = ExternalImportScanError | ExternalImportWriteError | "refresh-failed";
const reasonKeys: Record<Reason, string> = {
  "invalid-json": "settings.externalImportFeedback.json",
  "invalid-format": "settings.externalImportFeedback.format",
  "permission-denied": "settings.externalImportFeedback.permission",
  "source-unreadable": "settings.externalImportFeedback.read",
  "skill-too-large": "settings.externalImportFeedback.size",
  "scan-failed": "settings.externalImportFeedback.scan",
  "stale-selection": "settings.externalImportFeedback.stale",
  "invalid-mcp": "settings.externalImportFeedback.mcp",
  "invalid-skill": "settings.externalImportFeedback.skill",
  "invalid-destination": "settings.externalImportFeedback.destination",
  "host-unavailable": "settings.externalImportFeedback.host",
  "source-missing": "settings.externalImportFeedback.missing",
  "import-failed": "settings.externalImportFeedback.save",
  "refresh-failed": "settings.externalImportFeedback.refresh",
};

export interface ExternalAgentImportDestination {
  level: "global" | "project";
  projectPath?: string;
  onImported: () => Promise<unknown>;
}

interface Feedback {
  label?: string;
  selectionId?: string;
  reason: Reason;
}

export function ExternalAgentImportPanel<Source extends string, Candidate extends ExternalImportSelection & { source: Source }>({
  description, foundKey, sourceNames, groupPrefix, row, scan, run, onImported, options,
}: {
  description: string;
  foundKey: string;
  sourceNames: Record<Source, string>;
  groupPrefix: string;
  row: (item: Candidate) => { title: string; meta: string; badge: string };
  scan: () => Promise<ExternalImportScanResult<Candidate, Source | "error">>;
  run: (items: ExternalImportSelection[]) => Promise<ExternalImportBatchResult>;
  onImported: () => Promise<unknown>;
  options?: ReactNode;
}) {
  const { t } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  const [result, setResult] = useState<ExternalImportScanResult<Candidate, Source | "error"> | null>(null);
  const [selected, setSelected] = useState(new Set<string>());
  const [feedback, setFeedback] = useState<Feedback[]>([]);
  const [busy, setBusy] = useState<"scan" | "import" | null>(null);
  const disclosure = useGroupDisclosure();
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  async function readScan() {
    try {
      const next = await scan();
      if (!mounted.current) return;
      const scanFailure = next.sources.find((source) => source.kind === "error" && source.error);
      if (scanFailure?.error) {
        setFeedback([{ reason: scanFailure.error }]);
        return;
      }
      setResult(next);
      setFeedback([]);
      setSelected(new Set());
      disclosure.reset();
    } catch {
      if (mounted.current) setFeedback([{ reason: "scan-failed" }]);
    }
  }

  async function startScan() {
    if (busy) return;
    setBusy("scan");
    await readScan();
    if (mounted.current) setBusy(null);
  }

  async function importSelected() {
    if (busy || !result || !selected.size) return;
    const items = Array.from(selected, (selectionId) => ({ selectionId }));
    setBusy("import");
    try {
      const outcome = await run(items);
      if (!mounted.current) return;
      const failures = outcome.failed.map(({ requestIndex, error }) => ({
        selectionId: items[requestIndex]?.selectionId, reason: error,
      }));
      const unsubmitted = feedback.filter((message) => message.selectionId && !selected.has(message.selectionId));
      const messages = [...unsubmitted, ...failures];
      setFeedback(messages);
      if (failures.length) disclosure.reset();
      const done = new Set([...outcome.imported, ...outcome.skipped].map(({ item }) => item.selectionId));
      setSelected((previous) => new Set([...previous].filter((id) => !done.has(id))));
      showToast(t("settings.importAgentScanResult", {
        imported: outcome.imported.length, skipped: outcome.skipped.length, failed: failures.length,
      }), { variant: failures.length ? "error" : "success" });
      if (outcome.imported.length) {
        try {
          await onImported();
        } catch {
          if (mounted.current) setFeedback([...messages, { reason: "refresh-failed" }]);
          return;
        }
      }
      // A new scan retires all current IDs. Keep failed rows selectable until an explicit rescan.
      if (mounted.current && !messages.length) await readScan();
    } catch {
      if (mounted.current) setFeedback([{ reason: "import-failed" }]);
    } finally {
      if (mounted.current) setBusy(null);
    }
  }

  const candidates = result?.candidates ?? [];
  const sourceErrors: Feedback[] = (result?.sources ?? []).flatMap((source) => source.error ? [{
    label: source.path || (source.kind !== "error" ? t(sourceNames[source.kind]) : undefined),
    reason: source.error,
  }] : []);
  const messages = [...sourceErrors, ...feedback.filter((message) => !message.selectionId)];
  const rowErrors = new Map(feedback.map(({ selectionId, reason }) => [selectionId, reason]));
  return (
    <fieldset className="import-workbench" disabled={busy !== null} aria-busy={busy !== null} aria-label={description}>
      {result ? (
        <ImportToolbar
          found={t(foundKey, { count: candidates.length })}
          selectedCount={selected.size}
          allSelected={candidates.length > 0 && candidates.every((item) => selected.has(item.selectionId))}
          selectAllLabel={t("settings.importSelectAll")}
          onToggleAll={(on) => setSelected(new Set(on ? candidates.map((item) => item.selectionId) : []))}
          scanning={busy === "scan"}
          importing={busy === "import"}
          onScan={() => void startScan()}
          onImport={() => void importSelected()}
          options={options}
        />
      ) : <ImportIdle description={description} onScan={() => void startScan()} scanning={busy === "scan"} />}
      {messages.length > 0 && (
        <div className="ext-import-error" role="alert">
          <ul className="import-feedback">
            {messages.map(({ label, reason }, index) => (
              <li key={index}>{label && <><bdi>{label}</bdi>{" · "}</>}{t(reasonKeys[reason])}</li>
            ))}
          </ul>
        </div>
      )}
      {result && (candidates.length > 0 || !messages.length) && (
        <ImportResults message={!candidates.length ? t("settings.importAgentScanNone") : undefined}>
          <div className="import-groups">
            {groupBySource(candidates).map((group, index) => (
              <ImportGroup
                key={group.id}
                bodyId={`${groupPrefix}-${index}`}
                name={t(sourceNames[group.items[0].source])}
                count={group.items.length}
                countLabel={t(foundKey, { count: group.items.length })}
                expanded={disclosure.isExpanded(group.id)}
                onToggle={() => disclosure.toggle(group.id)}
              >
                {group.items.map((candidate) => {
                  const { title, meta, badge } = row(candidate);
                  const error = rowErrors.get(candidate.selectionId);
                  return (
                    <ImportRow
                      key={candidate.selectionId}
                      title={title}
                      meta={meta}
                      checked={selected.has(candidate.selectionId)}
                      onChange={(on) => setSelected((previous) => toggleKey(previous, candidate.selectionId, on))}
                      error={error && t(reasonKeys[error])}
                      badge={<Badge tone="neutral">{badge}</Badge>}
                    />
                  );
                })}
              </ImportGroup>
            ))}
          </div>
        </ImportResults>
      )}
    </fieldset>
  );
}
