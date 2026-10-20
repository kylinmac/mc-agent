import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { UsageSummary } from "@pi-desktop/shared";
import { compactTokens, labelStep, niceCeil, type ModelSeries } from "./usage-model";

/*
  mc-agent: the usage page's daily chart (MC-ADR-0011). A y-axis with gridlines
  on a rounded scale, dates along the bottom, and a tooltip that shows at once
  above the bar under the pointer: the day's total, turns, and either its
  split by model (all models) or new tokens against cache reads (one model).
*/

const GRID = [0, 0.25, 0.5, 0.75, 1];

export function UsageDailyChart({
  days,
  stacks,
  series,
  colorOf,
}: {
  days: UsageSummary["byDay"];
  /** Per-day tokens by series key in all-models mode; null for a single model. */
  stacks: Map<string, Map<string, number>> | null;
  series: readonly ModelSeries[];
  colorOf: (color: number) => string;
}) {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState<number | null>(null);
  const top = niceCeil(Math.max(0, ...days.map((day) => day.totalTokens)));
  const step = labelStep(days.length);
  const active = hovered === null ? null : days[hovered];

  return (
    <div className="mc-usage-daily">
      <div className="mc-usage-yaxis" aria-hidden>
        {GRID.map((ratio) => (
          <span key={ratio} style={{ bottom: `${ratio * 100}%` }}>
            {compactTokens(Math.round(top * ratio))}
          </span>
        ))}
      </div>
      <div className="mc-usage-plot">
        {GRID.map((ratio) => (
          <span key={ratio} className="mc-usage-gridline" style={{ bottom: `${ratio * 100}%` }} aria-hidden />
        ))}
        <div className="mc-usage-chart" role="img" aria-label={t("mcProject.usageByDay")} onMouseLeave={() => setHovered(null)}>
          {days.map((day, index) => (
            <div
              key={day.day}
              className="mc-usage-bar"
              data-hovered={hovered === index ? "true" : undefined}
              onMouseEnter={() => setHovered(index)}
            >
              <span className="mc-usage-bar-fill" style={{ height: `${(day.totalTokens / top) * 100}%` }}>
                {stacks ? (
                  // All models: one segment per model, largest model at the bottom.
                  [...series].reverse().map((entry) => {
                    const value = stacks.get(day.day)?.get(entry.key) ?? 0;
                    return value > 0 ? (
                      <span
                        key={entry.key || "<other>"}
                        className="mc-usage-bar-model"
                        style={{ height: `${(value / day.totalTokens) * 100}%`, background: colorOf(entry.color) }}
                      />
                    ) : null;
                  })
                ) : (
                  <>
                    <span className="mc-usage-bar-fresh" />
                    <span
                      className="mc-usage-bar-cache"
                      style={{ height: day.totalTokens ? `${(day.cacheReadTokens / day.totalTokens) * 100}%` : 0 }}
                    />
                  </>
                )}
              </span>
            </div>
          ))}
        </div>
        {active && hovered !== null ? (
          <div
            className="mc-usage-tooltip"
            // Above a short bar; beside a tall one (opening toward the wider
            // side), so it never leaves the chart.
            data-align={
              active.totalTokens / top > 0.45
                ? hovered / days.length > 0.5
                  ? "left"
                  : "right"
                : hovered / days.length < 0.2
                  ? "start"
                  : hovered / days.length > 0.8
                    ? "end"
                    : "center"
            }
            style={{
              left: `${((hovered + 0.5) / days.length) * 100}%`,
              ...(active.totalTokens / top > 0.45
                ? { top: 0 }
                : { bottom: `${(active.totalTokens / top) * 100}%` }),
            }}
            role="tooltip"
          >
            <div className="mc-usage-tooltip-head">
              <span>{active.day}</span>
              <strong>{compactTokens(active.totalTokens)}</strong>
            </div>
            <div className="mc-usage-tooltip-sub">{t("mcProject.usageTurns", { count: active.turns })}</div>
            {stacks
              ? series.map((entry) => {
                  const value = stacks.get(active.day)?.get(entry.key) ?? 0;
                  return value > 0 ? (
                    <div key={entry.key || "<other>"} className="mc-usage-tooltip-row">
                      <i style={{ background: colorOf(entry.color) }} />
                      <span>{entry.label}</span>
                      <span>{compactTokens(value)}</span>
                    </div>
                  ) : null;
                })
              : [
                  [t("mcProject.usageFresh"), active.totalTokens - active.cacheReadTokens, "fresh"],
                  [t("mcProject.usageCacheRead"), active.cacheReadTokens, "cache"],
                ].map(([label, value, kind]) => (
                  <div key={kind as string} className="mc-usage-tooltip-row" data-kind={kind}>
                    <i />
                    <span>{label}</span>
                    <span>{compactTokens(value as number)}</span>
                  </div>
                ))}
          </div>
        ) : null}
        <div className="mc-usage-xaxis" aria-hidden>
          {days.map((day, index) => (
            <span key={day.day}>{index % step === 0 || index === days.length - 1 ? day.day.slice(5) : ""}</span>
          ))}
        </div>
      </div>
      <div className="mc-usage-legend">
        {stacks ? (
          series.map((entry) => (
            <span key={entry.key || "<other>"} className="mc-usage-legend-item">
              <i style={{ background: colorOf(entry.color) }} />
              {entry.label}
            </span>
          ))
        ) : (
          <>
            <span className="mc-usage-legend-fresh">{t("mcProject.usageFresh")}</span>
            <span className="mc-usage-legend-cache">{t("mcProject.usageCacheRead")}</span>
          </>
        )}
      </div>
    </div>
  );
}
