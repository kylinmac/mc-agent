import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { UsageCounts, UsageSummary } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { SegmentedControl } from "../../components/ui";
import { SettingsCard } from "./primitives";
import {
  compactTokens,
  dayStacks,
  daysForModel,
  fillDays,
  folderName,
  modelKey,
  modelSeries,
  rangeStart,
  type ModelSeries,
  type Range,
} from "./usage-model";
import { SettingsMenuSelect } from "../../components/settings/SettingsMenuSelect";
import { UsageDailyChart } from "./UsageDailyChart";

/*
  mc-agent: token usage by model, project, day and conversation (MC-ADR-0011),
  from the usage every turn records. Local data only; no prices, since the
  configured models carry none.
*/

const ALL_MODELS = "*";

/** CSS color of a model's series slot; the folded "other" entry is neutral. */
function seriesColor(color: number): string {
  return color < 0 ? "var(--mc-series-other)" : `var(--mc-series-${color + 1})`;
}

/** Each model's share of the range, as a ring. */
function Donut({ series, total }: { series: readonly ModelSeries[]; total: number }) {
  const radius = 40;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  return (
    <svg className="mc-usage-donut" viewBox="0 0 100 100" aria-hidden>
      <circle cx="50" cy="50" r={radius} fill="none" className="mc-usage-donut-track" strokeWidth="14" />
      {series.map((entry) => {
        const length = Math.max(0, entry.share * circumference);
        const segment = (
          <circle
            key={entry.key || "<other>"}
            cx="50"
            cy="50"
            r={radius}
            fill="none"
            stroke={seriesColor(entry.color)}
            strokeWidth="14"
            strokeDasharray={`${length} ${circumference - length}`}
            strokeDashoffset={-offset}
            transform="rotate(-90 50 50)"
          />
        );
        offset += length;
        return segment;
      })}
      <text x="50" y="48" textAnchor="middle" className="mc-usage-donut-value">
        {compactTokens(total)}
      </text>
      <text x="50" y="61" textAnchor="middle" className="mc-usage-donut-label">
        tokens
      </text>
    </svg>
  );
}

function Share({ value, total }: { value: number; total: number }) {
  const percent = total > 0 ? (value / total) * 100 : 0;
  return (
    <span className="mc-usage-share" title={`${percent.toFixed(1)}%`}>
      <span style={{ width: `${Math.max(percent, value > 0 ? 1 : 0)}%` }} />
    </span>
  );
}

function Kpi({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="mc-usage-kpi">
      <div className="mc-usage-kpi-label">{label}</div>
      <div className="mc-usage-kpi-value">{value}</div>
      {detail ? <div className="mc-usage-kpi-detail">{detail}</div> : null}
    </div>
  );
}

export function UsagePage() {
  const { t } = useTranslation();
  const selectSession = useAppStore((state) => state.selectSession);
  const [range, setRange] = useState<Range>("30d");
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [chartModel, setChartModel] = useState(ALL_MODELS);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let canceled = false;
    const now = Date.now();
    setError(null);
    api.usageSummary(rangeStart(range, now), now).then(
      (loaded) => {
        if (!canceled) setSummary(loaded);
      },
      (failure: unknown) => {
        if (!canceled) setError(failure instanceof Error ? failure.message : String(failure));
      },
    );
    return () => {
      canceled = true;
    };
  }, [range]);

  const series = useMemo(
    () => (summary ? modelSeries(summary.byModel, t("mcProject.usageOtherModels"), t("mcProject.usageUnknownModel")) : []),
    [summary, t],
  );
  const colorOf = useMemo(() => new Map(series.map((entry) => [entry.key, entry.color])), [series]);
  // A model picked for the chart that this range does not have falls back to all.
  const pickedModel = chartModel !== ALL_MODELS && summary?.byModel.some((row) => modelKey(row) === chartModel) ? chartModel : ALL_MODELS;
  const days = useMemo(() => {
    if (!summary) return [];
    const source = pickedModel === ALL_MODELS ? summary.byDay : daysForModel(summary.byDayModel, pickedModel);
    return fillDays(source, summary.fromMs, summary.toMs);
  }, [summary, pickedModel]);
  const stacks = useMemo(
    () => (summary && pickedModel === ALL_MODELS ? dayStacks(summary.byDayModel, series) : null),
    [summary, pickedModel, series],
  );
  const totals: UsageCounts | undefined = summary?.totals;
  const cacheHit =
    totals && totals.inputTokens + totals.cacheReadTokens > 0
      ? (totals.cacheReadTokens / (totals.inputTokens + totals.cacheReadTokens)) * 100
      : 0;

  return (
    <div className="settings-stack mc-usage">
      <div className="mc-usage-head">
        <p className="mc-prompts-intro">{t("mcProject.usageIntro")}</p>
        <SegmentedControl
          label={t("mcProject.usageRange")}
          value={range}
          onChange={setRange}
          options={[
            { value: "today", label: t("mcProject.usageToday") },
            { value: "7d", label: t("mcProject.usageDays", { count: 7 }) },
            { value: "30d", label: t("mcProject.usageDays", { count: 30 }) },
            { value: "90d", label: t("mcProject.usageDays", { count: 90 }) },
            { value: "all", label: t("mcProject.usageAll") },
          ]}
        />
      </div>

      {error ? <div className="mc-prompts-muted">{error}</div> : null}
      {!summary && !error ? <div className="mc-prompts-muted">{t("mcProject.importScanning")}</div> : null}

      {summary && totals ? (
        <>
          <div className="mc-usage-kpis">
            <Kpi label={t("mcProject.usageTotal")} value={compactTokens(totals.totalTokens)} detail={t("mcProject.usageTurns", { count: totals.turns })} />
            <Kpi label={t("mcProject.usageInput")} value={compactTokens(totals.inputTokens)} />
            <Kpi label={t("mcProject.usageOutput")} value={compactTokens(totals.outputTokens)} detail={totals.reasoningTokens ? t("mcProject.usageReasoning", { value: compactTokens(totals.reasoningTokens) }) : undefined} />
            <Kpi
              label={t("mcProject.usageCacheRead")}
              value={compactTokens(totals.cacheReadTokens)}
              detail={t("mcProject.usageCacheHit", { percent: cacheHit.toFixed(0) })}
            />
            <Kpi label={t("mcProject.usageCacheWrite")} value={compactTokens(totals.cacheWriteTokens)} />
          </div>

          {totals.turns === 0 ? (
            <div className="settings-row">
              <div className="settings-row-copy mc-prompts-muted">{t("mcProject.usageEmpty")}</div>
            </div>
          ) : (
            <>
              {days.length > 1 ? (
                <SettingsCard
                  title={t("mcProject.usageByDay")}
                  action={
                    <SettingsMenuSelect
                      label={t("mcProject.usageChartModel")}
                      value={pickedModel}
                      options={[
                        { id: ALL_MODELS, label: t("mcProject.usageAllModels") },
                        ...summary.byModel.map((row) => ({
                          id: modelKey(row),
                          label: row.modelId || t("mcProject.usageUnknownModel"),
                        })),
                      ]}
                      onChange={setChartModel}
                    />
                  }
                >
                  <UsageDailyChart days={days} stacks={stacks} series={series} colorOf={seriesColor} />
                </SettingsCard>
              ) : null}

              <SettingsCard title={t("mcProject.usageByModel")}>
                <div className="mc-usage-models">
                  <Donut series={series} total={totals.totalTokens} />
                  <ul className="mc-usage-model-legend">
                    {series.map((entry) => (
                      <li key={entry.key || "<other>"}>
                        <i style={{ background: seriesColor(entry.color) }} />
                        <span className="mc-usage-name">{entry.label}</span>
                        {entry.detail ? <span className="mc-usage-sub">{entry.detail}</span> : null}
                        <span className="mc-usage-model-share">{(entry.share * 100).toFixed(1)}%</span>
                        <span className="mc-usage-strong">{compactTokens(entry.total)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <table className="mc-usage-table">
                  <thead>
                    <tr>
                      <th>{t("mcProject.usageModel")}</th>
                      <th>{t("mcProject.usageTurnsHead")}</th>
                      <th>{t("mcProject.usageInput")}</th>
                      <th>{t("mcProject.usageOutput")}</th>
                      <th>{t("mcProject.usageCacheRead")}</th>
                      <th>{t("mcProject.usageTotal")}</th>
                      <th aria-label={t("mcProject.usageShare")} />
                    </tr>
                  </thead>
                  <tbody>
                    {summary.byModel.map((row) => (
                      <tr key={modelKey(row)}>
                        <td>
                          <div className="mc-usage-name">
                            <i
                              className="mc-usage-dot"
                              style={{ background: seriesColor(colorOf.get(modelKey(row)) ?? -1) }}
                            />
                            {row.modelId || t("mcProject.usageUnknownModel")}
                          </div>
                          {row.providerName || row.providerId ? (
                            <div className="mc-usage-sub">{row.providerName || row.providerId}</div>
                          ) : null}
                        </td>
                        <td>{row.turns}</td>
                        <td>{compactTokens(row.inputTokens)}</td>
                        <td>{compactTokens(row.outputTokens)}</td>
                        <td>{compactTokens(row.cacheReadTokens)}</td>
                        <td className="mc-usage-strong">{compactTokens(row.totalTokens)}</td>
                        <td>
                          <Share value={row.totalTokens} total={totals.totalTokens} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </SettingsCard>

              <SettingsCard title={t("mcProject.usageByProject")}>
                <table className="mc-usage-table">
                  <tbody>
                    {summary.byProject.map((row) => (
                      <tr key={row.path ?? "<none>"}>
                        <td>
                          <div className="mc-usage-name">{folderName(row.path) || t("mcProject.importNoProject")}</div>
                          {row.path ? <div className="mc-usage-sub" title={row.path}>{row.path}</div> : null}
                        </td>
                        <td>{t("mcProject.usageTurns", { count: row.turns })}</td>
                        <td className="mc-usage-strong">{compactTokens(row.totalTokens)}</td>
                        <td>
                          <Share value={row.totalTokens} total={totals.totalTokens} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </SettingsCard>

              <SettingsCard title={t("mcProject.usageTopSessions")}>
                <table className="mc-usage-table">
                  <tbody>
                    {summary.topSessions.map((row) => (
                      <tr key={row.sessionId}>
                        <td>
                          <button
                            type="button"
                            className="mc-usage-link"
                            title={t("mcProject.usageOpenSession")}
                            onClick={() => void selectSession(row.sessionId)}
                          >
                            {row.title.trim() || t("chat.untitledTask")}
                          </button>
                          {row.projectPath ? <div className="mc-usage-sub">{folderName(row.projectPath)}</div> : null}
                        </td>
                        <td>{t("mcProject.usageTurns", { count: row.turns })}</td>
                        <td className="mc-usage-strong">{compactTokens(row.totalTokens)}</td>
                        <td>
                          <Share value={row.totalTokens} total={totals.totalTokens} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </SettingsCard>
            </>
          )}
        </>
      ) : null}
    </div>
  );
}
