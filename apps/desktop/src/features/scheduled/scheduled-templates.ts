import type { ScheduledTask } from "@pi-desktop/shared";

/*
  mc-agent: starting points for a scheduled task. A template only fills the
  form (title, instruction, schedule); the project, model and permissions are
  still chosen there, and nothing runs until the task is saved.
*/

export type ScheduledTemplateIcon = "digest" | "tests" | "deps" | "todo" | "review" | "docs";

export type ScheduledTemplate = {
  id: string;
  icon: ScheduledTemplateIcon;
  /** i18n keys under `mcProject.` */
  titleKey: string;
  descriptionKey: string;
  promptKey: string;
  cadence: ScheduledTask["cadence"];
  schedule: NonNullable<ScheduledTask["schedule"]>;
};

/** Monday = 0, as the host counts. */
const WEEKDAYS = [0, 1, 2, 3, 4];

function at(hour: number, minute: number, weekdays: number[]): NonNullable<ScheduledTask["schedule"]> {
  return { hour, minute, weekday: weekdays[0] ?? 0, weekdays };
}

export const SCHEDULED_TEMPLATES: readonly ScheduledTemplate[] = [
  {
    id: "dailyDigest",
    icon: "digest",
    titleKey: "schedTplDigestTitle",
    descriptionKey: "schedTplDigestDesc",
    promptKey: "schedTplDigestPrompt",
    cadence: "weekly",
    schedule: at(9, 0, WEEKDAYS),
  },
  {
    id: "testHealth",
    icon: "tests",
    titleKey: "schedTplTestsTitle",
    descriptionKey: "schedTplTestsDesc",
    promptKey: "schedTplTestsPrompt",
    cadence: "weekly",
    schedule: at(8, 30, WEEKDAYS),
  },
  {
    id: "dependencyCheck",
    icon: "deps",
    titleKey: "schedTplDepsTitle",
    descriptionKey: "schedTplDepsDesc",
    promptKey: "schedTplDepsPrompt",
    cadence: "weekly",
    schedule: at(10, 0, [0]),
  },
  {
    id: "weeklyReview",
    icon: "review",
    titleKey: "schedTplReviewTitle",
    descriptionKey: "schedTplReviewDesc",
    promptKey: "schedTplReviewPrompt",
    cadence: "weekly",
    schedule: at(17, 0, [4]),
  },
  {
    id: "todoSweep",
    icon: "todo",
    titleKey: "schedTplTodoTitle",
    descriptionKey: "schedTplTodoDesc",
    promptKey: "schedTplTodoPrompt",
    cadence: "weekly",
    schedule: at(16, 0, [4]),
  },
  {
    id: "docsDrift",
    icon: "docs",
    titleKey: "schedTplDocsTitle",
    descriptionKey: "schedTplDocsDesc",
    promptKey: "schedTplDocsPrompt",
    cadence: "weekly",
    schedule: at(15, 0, [2]),
  },
];

/** A schedule as one phrase ("Weekdays at 09:00", "Every Friday at 17:00"). */
export function templateWhen(
  template: ScheduledTemplate,
  t: (key: string, options?: Record<string, unknown>) => string,
  locale: string,
): string {
  const { hour, minute, weekdays = [] } = template.schedule;
  const time = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  if (weekdays.length === 5 && WEEKDAYS.every((day) => weekdays.includes(day))) {
    return t("mcProject.schedWhenWeekdays", { time });
  }
  if (weekdays.length === 1) {
    // 2024-01-01 was a Monday, which the host counts as day 0.
    const day = new Date(2024, 0, 1 + weekdays[0]!).toLocaleDateString(locale, {
      weekday: locale.startsWith("zh") ? "short" : "long",
    });
    return t("mcProject.schedWhenWeekly", { day, time });
  }
  return t("mcProject.schedWhenDaily", { time });
}
