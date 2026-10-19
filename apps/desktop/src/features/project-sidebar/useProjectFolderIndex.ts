import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ProjectGroupRecord } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { normalizeProjectPath } from "../../lib/sidebar-session-groups";
import { buildProjectFolderIndex, type ProjectFolderIndex } from "./project-merge";

/**
 * Project groups indexed by folder for the sidebar (mc-agent), plus the
 * recorded project folders that no longer exist. Reloaded when `refreshKey`
 * changes (open projects, sessions) and when the window regains focus; a
 * failed load keeps the previous data, so the sidebar falls back to
 * upstream's per-folder entries rather than breaking.
 */
export function useProjectFolderIndex(refreshKey: string): {
  index: ProjectFolderIndex;
  missing: ReadonlySet<string>;
} {
  const { t } = useTranslation();
  const [groups, setGroups] = useState<ProjectGroupRecord[]>([]);
  const [missingPaths, setMissingPaths] = useState<string[]>([]);
  const [focusTick, setFocusTick] = useState(0);

  useEffect(() => {
    const onFocus = () => setFocusTick((value) => value + 1);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  useEffect(() => {
    let canceled = false;
    void api
      .listProjectGroups()
      .then(({ groups: listed }) => {
        if (!canceled) setGroups(listed);
      })
      .catch(() => {
        // Keep the previous index; see above.
      });
    void api
      .missingProjectFolders()
      .then(({ folders }) => {
        if (!canceled) setMissingPaths(folders);
      })
      .catch(() => {
        // Without the check nothing is hidden.
      });
    return () => {
      canceled = true;
    };
  }, [refreshKey, focusTick]);

  const resourcesLabel = t("mcProject.sidebarResourcesTag");
  const index = useMemo(
    () => buildProjectFolderIndex(groups, normalizeProjectPath, resourcesLabel),
    [groups, resourcesLabel],
  );
  const missing = useMemo(
    () =>
      new Set(
        missingPaths
          .map((path) => normalizeProjectPath(path))
          .filter((path): path is string => Boolean(path)),
      ),
    [missingPaths],
  );
  return { index, missing };
}
