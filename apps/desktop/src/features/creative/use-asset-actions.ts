import { useTranslation } from "react-i18next";
import type { CreativeAsset } from "@pi-desktop/shared";
import { api } from "../../lib/api";

/*
  What the studio does to images, each with its own meaning (see the review's
  C6): import files into a category, move between categories (undoable),
  remove from the library (files stay, undoable), and delete the files (after
  one confirmation; the records stay for history).
*/

export type StudioNotice = string | { text: string; undo: () => Promise<void> } | null;

export function useAssetActions({
  groupId,
  assetById,
  category,
  reload,
  setNotice,
  onGone,
}: {
  groupId: string | null;
  assetById: ReadonlyMap<string, CreativeAsset>;
  /** The open category; imports land there. */
  category: string;
  reload: () => Promise<void>;
  setNotice: (notice: StudioNotice) => void;
  /** Images left the grid: drop them from the selection and references. */
  onGone: (ids: string[]) => void;
}) {
  const { t } = useTranslation();

  const importFiles = async (paths: string[]) => {
    if (!groupId || !paths.length) return;
    const { assets: added } = await api.creative.importFiles(groupId, paths, category);
    setNotice(t("mcProject.creativeImported", { count: added.length }));
    await reload();
  };

  const moveAssets = async (ids: string[], target: string) => {
    if (!groupId || !ids.length) return;
    const project = groupId;
    // Where each one was, so the move can be undone.
    const before = new Map<string, string[]>();
    for (const id of ids) {
      const from = assetById.get(id)?.category ?? "";
      if (from === target) continue;
      before.set(from, [...(before.get(from) ?? []), id]);
    }
    await api.creative.call("creative.assets.move", { groupId: project, assetIds: ids, category: target });
    setNotice({
      text: t("mcProject.creativeMoved", {
        count: ids.length,
        name: target || t("mcProject.creativeUncategorized"),
      }),
      undo: async () => {
        for (const [from, moved] of before) {
          await api.creative.call("creative.assets.move", { groupId: project, assetIds: moved, category: from });
        }
        setNotice(t("mcProject.creativeMoveUndone", { count: ids.length }));
        await reload();
      },
    });
    await reload();
  };

  /** Out of the library only; the files stay, and the notice can undo it. */
  const removeFromLibrary = async (ids: string[]) => {
    if (!groupId || !ids.length) return;
    const project = groupId;
    for (const id of ids) await api.creative.call("creative.assets.remove", { groupId: project, assetId: id });
    onGone(ids);
    setNotice({
      text: t("mcProject.creativeRemovedSelected", { count: ids.length }),
      undo: async () => {
        for (const id of ids) await api.creative.call("creative.assets.restore", { groupId: project, assetId: id });
        setNotice(t("mcProject.creativeRestored", { count: ids.length }));
        await reload();
      },
    });
    await reload();
  };

  /** Delete files after one confirmation; their records stay for history. */
  const deleteFiles = async (ids: string[]) => {
    if (!groupId || !ids.length) return;
    if (!window.confirm(t("mcProject.creativeDeleteFilesConfirm", { count: ids.length }))) return;
    let failed = 0;
    for (const id of ids) {
      try {
        await api.creative.call("creative.assets.deleteFile", { groupId, assetId: id });
      } catch {
        failed += 1;
      }
    }
    onGone(ids);
    setNotice(
      failed
        ? t("mcProject.creativeDeletedSomeFailed", { count: ids.length - failed, failed })
        : t("mcProject.creativeDeletedFiles", { count: ids.length }),
    );
    await reload();
  };

  return { importFiles, moveAssets, removeFromLibrary, deleteFiles };
}
