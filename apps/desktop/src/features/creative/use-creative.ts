import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectGroupRecord } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import type {
  CreativeAsset,
  CreativeCategory,
  CreativeComparison,
  CreativeJob,
} from "./creative-types";

/*
  mc-agent creative studio data: projects with their purpose, and one
  project's assets, jobs and comparisons, refreshed when a job changes.
*/

export function useCreativeProjects() {
  const [groups, setGroups] = useState<ProjectGroupRecord[]>([]);
  const [purposes, setPurposes] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);
  const reload = useCallback(async () => {
    const [{ groups: listed }, { purposes: marks }] = await Promise.all([
      api.listProjectGroups(),
      api.creative.call("creative.purposes"),
    ]);
    setGroups(listed.filter((group) => !group.legacy && !group.remote));
    setPurposes(marks ?? {});
    setLoaded(true);
  }, []);
  useEffect(() => {
    void reload().catch(() => setLoaded(true));
  }, [reload]);
  return { groups, purposes, loaded, reload };
}

export function useStudioData(groupId: string | null) {
  const [assets, setAssets] = useState<CreativeAsset[]>([]);
  const [jobs, setJobs] = useState<CreativeJob[]>([]);
  const [comparisons, setComparisons] = useState<CreativeComparison[]>([]);
  const [categories, setCategories] = useState<CreativeCategory[]>([]);
  const [error, setError] = useState<string | null>(null);
  const current = useRef(groupId);
  current.current = groupId;

  const reload = useCallback(async () => {
    const id = current.current;
    if (!id) {
      setAssets([]);
      setJobs([]);
      setComparisons([]);
      setCategories([]);
      return;
    }
    try {
      const [listedAssets, listedJobs, listedComparisons, listedCategories] = await Promise.all([
        api.creative.call("creative.assets.list", { groupId: id, filter: {} }),
        api.creative.call("creative.jobs.list", { groupId: id, limit: 200 }),
        api.creative.call("creative.comparisons.list", { groupId: id }),
        api.creative.call("creative.categories.list", { groupId: id }),
      ]);
      if (current.current !== id) return;
      setAssets(listedAssets.assets);
      setJobs(listedJobs.jobs);
      setComparisons(listedComparisons.comparisons);
      setCategories(listedCategories.categories);
      setError(null);
    } catch (failure) {
      if (current.current === id) setError(failure instanceof Error ? failure.message : String(failure));
    }
  }, []);

  useEffect(() => {
    if (!groupId) {
      void reload();
      return;
    }
    // Registrations a crash cut off are completed before the first read.
    void api.creative
      .call("creative.jobs.reconcile", { groupId })
      .catch(() => undefined)
      .finally(() => void reload());
  }, [groupId, reload]);

  useEffect(() => {
    let timer: number | undefined;
    const off = api.creative.onJob((job) => {
      if (job.groupId !== current.current) return;
      // Results land one by one; one refresh per burst is enough.
      setJobs((list) => {
        const index = list.findIndex((entry) => entry.id === job.id);
        if (index < 0) return [job, ...list];
        const next = [...list];
        next[index] = job;
        return next;
      });
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void reload(), 250);
    });
    return () => {
      off();
      window.clearTimeout(timer);
    };
  }, [reload]);

  return { assets, jobs, comparisons, categories, error, reload };
}

const imageCache = new Map<string, Promise<string | null>>();
const MAX_CACHED = 300;

/** A project asset's image as a data URL: a preview at `size` px, or full (0). */
export function useAssetImage(groupId: string, assetId: string | null | undefined, size: number) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!assetId) {
      setUrl(null);
      return;
    }
    let live = true;
    const key = `${groupId}\u0000${assetId}\u0000${size}`;
    let pending = imageCache.get(key);
    if (!pending) {
      pending = api.creative
        .image(groupId, assetId, size)
        .then((result) => result.dataUrl)
        .catch(() => null);
      imageCache.set(key, pending);
      while (imageCache.size > MAX_CACHED) {
        const oldest = imageCache.keys().next().value;
        if (oldest === undefined) break;
        imageCache.delete(oldest);
      }
    }
    void pending.then((value) => {
      if (live) setUrl(value);
    });
    return () => {
      live = false;
    };
  }, [groupId, assetId, size]);
  return url;
}
