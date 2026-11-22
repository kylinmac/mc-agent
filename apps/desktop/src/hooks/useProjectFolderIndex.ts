import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import type { ProjectGroupRecord } from "@pi-desktop/shared";
import { api } from "../lib/api";
import { normalizeProjectPath } from "../lib/sidebar-session-groups";
import { buildProjectFolderIndex, type ProjectFolderIndex } from "../lib/projects/project-folders";

type FolderSnapshot = {
  groups: ProjectGroupRecord[];
  missingPaths: string[];
  focusTick: number;
};

const EMPTY_INDEX: ProjectFolderIndex = new Map();
const EMPTY_MISSING: ReadonlySet<string> = new Set();
const MAX_CACHED_KEYS = 64;

let snapshot: FolderSnapshot = { groups: [], missingPaths: [], focusTick: 0 };
const fetchedKeys = new Set<string>();
let groupReqSeq = 0;
let groupAppliedSeq = 0;
let missingReqSeq = 0;
let missingAppliedSeq = 0;
const listeners = new Set<() => void>();
let listeningFocus = false;

function notify(): void {
  for (const listener of listeners) listener();
}

function onWindowFocus(): void {
  snapshot = { ...snapshot, focusTick: snapshot.focusTick + 1 };
  fetchedKeys.clear();
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!listeningFocus && typeof window !== "undefined") {
    window.addEventListener("focus", onWindowFocus);
    listeningFocus = true;
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && listeningFocus && typeof window !== "undefined") {
      window.removeEventListener("focus", onWindowFocus);
      listeningFocus = false;
    }
  };
}

function getSnapshot(): FolderSnapshot {
  return snapshot;
}

function requestRefresh(refreshKey: string, focusTick: number): void {
  const effectiveKey = `${focusTick}:${refreshKey}`;
  if (fetchedKeys.has(effectiveKey)) return;
  if (fetchedKeys.size >= MAX_CACHED_KEYS) {
    const oldest = fetchedKeys.values().next().value;
    if (oldest !== undefined) fetchedKeys.delete(oldest);
  }
  fetchedKeys.add(effectiveKey);
  const gSeq = ++groupReqSeq;
  const mSeq = ++missingReqSeq;
  void api
    .listProjectGroups()
    .then(({ groups: listed }) => {
      if (gSeq >= groupAppliedSeq) {
        groupAppliedSeq = gSeq;
        snapshot = { ...snapshot, groups: listed };
        notify();
      }
    })
    .catch(() => {
      // Keep the previous index; see below.
    });
  void api
    .missingProjectFolders()
    .then(({ folders }) => {
      if (mSeq >= missingAppliedSeq) {
        missingAppliedSeq = mSeq;
        snapshot = { ...snapshot, missingPaths: folders };
        notify();
      }
    })
    .catch(() => {
      // Without the check nothing is hidden.
    });
}

/**
 * Project groups indexed by folder for the sidebar and titlebar tabs (mc-agent),
 * plus recorded project folders that no longer exist. Shared across callers so
 * simultaneous mounts and window focus changes issue a single host query pair.
 * Pass `null` when the caller does not currently render folder data.
 */
export function useProjectFolderIndex(refreshKey: string | null): {
  index: ProjectFolderIndex;
  missing: ReadonlySet<string>;
} {
  const { t } = useTranslation();
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (refreshKey === null) return;
    requestRefresh(refreshKey, state.focusTick);
  }, [refreshKey, state.focusTick]);

  const resourcesLabel = t("mcProject.sidebarResourcesTag");
  const index = useMemo(
    () =>
      refreshKey === null
        ? EMPTY_INDEX
        : buildProjectFolderIndex(state.groups, normalizeProjectPath, resourcesLabel),
    [refreshKey, state.groups, resourcesLabel],
  );
  const missing = useMemo(
    () =>
      refreshKey === null
        ? EMPTY_MISSING
        : new Set(
            state.missingPaths
              .map((path) => normalizeProjectPath(path))
              .filter((path): path is string => Boolean(path)),
          ),
    [refreshKey, state.missingPaths],
  );
  return { index, missing };
}
