import { useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button, cx } from "../../components/ui";
import {
  IconChevronLeft,
  IconDiff,
  IconFolder,
  IconFolderOpen,
  IconImage,
  IconPalette,
  IconPlus,
  IconSearch,
  IconTrash,
  IconX,
} from "../../components/icons";
import { IntoSidebarSlot } from "../sidebar-slot/SidebarSlot";
import { ContextMenu, useContextMenu } from "../../components/ContextMenu";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import type { CreativeParams } from "@pi-desktop/shared";
import type { CreativeAsset, CreativeComparison, CreativeJob, CreativeStorage } from "./creative-types";
import {
  categoryTree,
  flattenCategories,
  compareContextText,
  dayGroups,
  MAX_COMPARE,
  ORIGIN_LABEL_KEYS,
  type DayItem,
  isActiveJob,
  jobProgress,
  neighbour,
  queueJobs,
  toggleSelection,
  viewAssets,
  type FormReference,
  type StudioView,
} from "./creative-model";
import { useCreativeProjects, useStudioData } from "./use-creative";
import { useGridSelection } from "./use-grid-selection";
import { useAssetActions, type StudioNotice } from "./use-asset-actions";
import { AssetTile } from "./AssetTile";
import { AssetDetail } from "./AssetDetail";
import { AssetPicker } from "./AssetPicker";
import { CategoryTree, ASSET_DRAG_TYPE } from "./CategoryTree";
import { CompareView } from "./CompareView";
import { ASPECT_RATIOS, StudioPanel } from "./StudioPanel";
import { NewCreativeDialog } from "./NewCreativeDialog";
import { MoveDialog } from "./MoveDialog";
import { setAssetDragImage } from "./drag-image";
import { CanvasView } from "./canvas/CanvasView";
import { CanvasNav } from "./canvas/CanvasNav";
import { useCanvasList } from "./canvas/use-canvas";
import {
  addAttachment,
  attachmentsText,
  hasViewContext,
  makeNonce,
  threadAttachment,
  viewContextText,
  type CanvasAttachment,
  type CanvasViewState,
} from "./canvas/canvas-model";
import type { StudioChatExtra } from "./StudioChat";
import type { CanvasThread } from "@pi-desktop/shared";
import "./creative.css";

/*
  mc-agent creative studio (docs/mc-agent/creative-studio.md):
  - sidebar: creative projects, where files are stored, and the library's
    views (all, comparisons) and category tree;
  - left panel: 直出 (prompt → image model → a category) or 对话 (a compact
    conversation that can draw with code or call the image model);
  - main: the selected view as a grid (drag tiles onto a category to move
    them), or a comparison; the generation queue at the bottom.
  Selection is for comparing and bulk actions; references are their own list.
*/

const GROUP_KEY = "mc.creative.group";

function readStoredGroup(): string | null {
  try {
    return localStorage.getItem(GROUP_KEY);
  } catch {
    return null;
  }
}

function storeGroup(id: string) {
  try {
    localStorage.setItem(GROUP_KEY, id);
  } catch {
    // Remembering the project is a convenience only.
  }
}

const RATIO_KEY = "mc.creative.aspectRatio";
const RESOLUTION_KEY = "mc.creative.resolution";

function readStored(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeStored(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Remembering the choice is a convenience only.
  }
}

function readRatio(): string {
  try {
    const stored = localStorage.getItem(RATIO_KEY) ?? "";
    return (ASPECT_RATIOS as readonly string[]).includes(stored) ? stored : "";
  } catch {
    return "";
  }
}

function storeRatio(ratio: string) {
  try {
    localStorage.setItem(RATIO_KEY, ratio);
  } catch {
    // Remembering the shape is a convenience only.
  }
}

function JobStatusLabel({ job }: { job: CreativeJob }) {
  const { t } = useTranslation();
  return <span className={cx("mc-creative-status", `is-${job.status}`)}>{t(`mcProject.creativeJob_${job.status}`)}</span>;
}

/** The storage errors host-core marks (mc_creative::STORAGE_*), else null. */
function storageProblemOf(failure: unknown): "unlinked" | "unavailable" | null {
  const message = failure instanceof Error ? failure.message : String(failure);
  if (message.includes("STORAGE_UNLINKED")) return "unlinked";
  if (message.includes("STORAGE_UNAVAILABLE")) return "unavailable";
  return null;
}

function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

export function CreativePage() {
  const { t, i18n } = useTranslation();
  const setPage = useAppStore((state) => state.setPage);
  const showProjectInSidebar = useAppStore((state) => state.showProjectInSidebar);
  const { groups, purposes, loaded, reload: reloadProjects } = useCreativeProjects();
  const { contextMenu, openContextMenu, closeContextMenu } = useContextMenu();
  const [groupId, setGroupId] = useState<string | null>(readStoredGroup);
  const [view, setView] = useState<StudioView>({ kind: "all" });
  const [query, setQuery] = useState("");
  const [references, setReferences] = useState<FormReference[]>([]);
  const [prompt, setPrompt] = useState("");
  const [targetCategory, setTargetCategory] = useState("");
  const [aspectRatio, setAspectRatio] = useState(readRatio);
  const [resolution, setResolution] = useState(() => readStored(RESOLUTION_KEY, "1k"));
  const [detailId, setDetailId] = useState<string | null>(null);
  // The comparison being worked on in 对比集; kept while other views are open.
  const [comparing, setComparing] = useState<{ ids: string[]; comparison: CreativeComparison | null }>({
    ids: [],
    comparison: null,
  });
  const [creating, setCreating] = useState(false);
  const [picking, setPicking] = useState(false);
  // A message under the header; an undoable action carries its undo.
  const [notice, setNotice] = useState<StudioNotice>(null);
  const [moving, setMoving] = useState<string[] | null>(null);
  // Images on their way to a category (0 when nothing is dragged).
  const [assetDrag, setAssetDrag] = useState(0);
  const [dragging, setDragging] = useState(false);
  // The canvas (docs/mc-agent/creative-canvas.md): what it shows the chat,
  // what waits to go with the next message, and a request to send now.
  const [canvasState, setCanvasState] = useState<CanvasViewState | null>(null);
  const [canvasContextOff, setCanvasContextOff] = useState(false);
  const [attachments, setAttachments] = useState<CanvasAttachment[]>([]);
  const [chatRequest, setChatRequest] = useState<{ id: number; text: string } | null>(null);

  const creativeGroups = groups.filter((group) => purposes[group.id] === "creative");
  const group = groups.find((candidate) => candidate.id === groupId) ?? null;
  const isCreative = !!group && purposes[group.id] === "creative";
  const studioGroupId = group && isCreative ? group.id : null;

  // Open the remembered project, else the first creative one.
  useEffect(() => {
    if (!loaded || group) return;
    setGroupId(creativeGroups[0]?.id ?? null);
  }, [loaded, group, creativeGroups]);

  useEffect(() => {
    if (groupId) storeGroup(groupId);
    setSelection([]);
    setReferences([]);
    setComparing({ ids: [], comparison: null });
    setDetailId(null);
    setView({ kind: "all" });
    setTargetCategory("");
    setAttachments([]);
    setChatRequest(null);
  }, [groupId]);

  // A creative project is an ordinary project: keep it in the main sidebar's
  // project list too (without switching away from the studio).
  useEffect(() => {
    if (group && isCreative && group.primaryPath) showProjectInSidebar({ path: group.primaryPath, name: group.name });
  }, [group, isCreative, showProjectInSidebar]);

  // Where the project keeps its files: one of its folders' creative/.
  const [storage, setStorage] = useState<CreativeStorage | null>(null);
  // Why there is no location: a chosen folder left the project or is offline.
  const [storageProblem, setStorageProblem] = useState<"unlinked" | "unavailable" | null>(null);
  useEffect(() => {
    setStorage(null);
    setStorageProblem(null);
    if (!studioGroupId) return;
    void api.creative.call("creative.storage", { groupId: studioGroupId }).then(
      (answer) => setStorage(answer.storage),
      (failure: unknown) => setStorageProblem(storageProblemOf(failure)),
    );
  }, [studioGroupId]);

  const { assets, jobs, comparisons, categories, error, reload } = useStudioData(studioGroupId);
  const { canvases, reload: reloadCanvases } = useCanvasList(studioGroupId);
  const tree = useMemo(() => categoryTree(categories), [categories]);
  const flat = useMemo(() => flattenCategories(tree), [tree]);
  const assetById = useMemo(() => new Map(assets.map((asset) => [asset.id, asset])), [assets]);
  const queue = useMemo(() => queueJobs(jobs), [jobs]);

  // Generating while a category is open files the results there.
  useEffect(() => {
    if (view.kind === "category") setTargetCategory(view.path);
    if (view.kind === "uncategorized") setTargetCategory("");
  }, [view]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const listed = viewAssets(assets, view);
    if (!needle) return listed;
    const prompts = new Map(jobs.map((job) => [job.id, (job.snapshot.prompt ?? "").toLowerCase()]));
    return listed.filter(
      (asset) =>
        asset.title.toLowerCase().includes(needle) || (asset.jobId ? prompts.get(asset.jobId)?.includes(needle) : false),
    );
  }, [assets, jobs, view, query]);
  const groupsForGrid = useMemo(
    () => dayGroups(visible, jobs, view.kind === "all" && !query.trim()),
    [visible, jobs, view, query],
  );

  // The grid's visible order, for ⇧-click runs, arrows and the preview.
  const order = useMemo(
    () =>
      view.kind === "comparisons"
        ? []
        : groupsForGrid.flatMap((entry) => entry.items.flatMap((item) => (item.kind === "asset" ? [item.asset.id] : []))),
    [groupsForGrid, view],
  );

  const viewKey = view.kind === "category" ? `category:${view.path}` : view.kind;
  const grid = useGridSelection({ order, viewKey, disabled: view.kind === "comparisons" });
  const { selection, setSelection, setAnchor, focusId, setFocusId, marquee, scrollRef, selectTile, startMarquee } = grid;

  const projectPath = useMemo(() => {
    if (!group) return null;
    return (storage && group.roots.find((root) => root.path === storage.folder)?.path) ?? group.roots[0]?.path ?? null;
  }, [group, storage]);

  /** 今天 / 昨天 / a local date. */
  const dayLabel = (day: string) => {
    const [year, month, date] = day.split("-").map(Number);
    const at = new Date(year!, month! - 1, date!);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diff = Math.round((today.getTime() - at.getTime()) / 86_400_000);
    if (diff === 0) return t("mcProject.creativeToday");
    if (diff === 1) return t("mcProject.creativeYesterday");
    return at.toLocaleDateString(i18n.language, {
      year: at.getFullYear() === today.getFullYear() ? undefined : "numeric",
      month: "long",
      day: "numeric",
      weekday: diff < 7 ? "short" : undefined,
    });
  };

  /** Hover caption: what made the image, and with what. */
  const caption = (item: Extract<DayItem, { kind: "asset" }>) => {
    const job = item.job;
    const origin = t(ORIGIN_LABEL_KEYS[item.asset.origin] ?? "mcProject.creativeOriginImport");
    if (!job || job.entry === "code") return { title: item.asset.title, meta: origin };
    return { title: job.snapshot.prompt || item.asset.title, meta: [origin, job.modelId].filter(Boolean).join(" · ") };
  };

  const fail = (failure: unknown) => setNotice(failure instanceof Error ? failure.message : String(failure));

  const markCreative = async () => {
    if (!group) return;
    await api.creative.call("creative.setPurpose", { groupId: group.id, purpose: "creative" });
    await reloadProjects();
  };

  const currentCategory = view.kind === "category" ? view.path : "";

  const { importFiles, moveAssets, removeFromLibrary, deleteFiles } = useAssetActions({
    groupId: studioGroupId,
    assetById,
    category: currentCategory,
    reload,
    setNotice,
    onGone: (ids) => {
      setSelection((current) => current.filter((id) => !ids.includes(id)));
      setReferences((current) => current.filter((entry) => !ids.includes(entry.assetId)));
    },
  });

  const onDropFiles = (event: DragEvent) => {
    if (event.dataTransfer.types.includes(ASSET_DRAG_TYPE)) return;
    event.preventDefault();
    setDragging(false);
    const paths = [...event.dataTransfer.files]
      .map((file) => window.piDesktop?.getDroppedFilePath?.(file) ?? null)
      .filter((path): path is string => !!path);
    void importFiles(paths).catch(fail);
  };

  const addReferences = (ids: string[]) =>
    setReferences((current) => [
      ...current,
      ...ids.filter((id) => !current.some((entry) => entry.assetId === id)).map((id) => ({ assetId: id, role: "reference" as const })),
    ]);

  /** Right-click on a tile: acts on the selection when the tile is in it, else on the tile alone. */
  const tileMenu = (event: MouseEvent<HTMLElement>, asset: CreativeAsset) => {
    const ids = selection.includes(asset.id) ? selection : [asset.id];
    if (!selection.includes(asset.id)) {
      setSelection([asset.id]);
      setAnchor(asset.id);
    }
    setFocusId(asset.id);
    const chosen = ids.map((id) => assetById.get(id)).filter((entry): entry is CreativeAsset => !!entry);
    const one = chosen.length === 1 ? chosen[0] : null;
    openContextMenu(event, {
      label: one ? one.title : t("mcProject.creativeSelected", { count: chosen.length }),
      items: [
        ...(one
          ? [
              { id: "open", label: t("mcProject.creativeOpen"), onSelect: () => setDetailId(one.id) },
              {
                id: "reveal",
                label: t("mcProject.creativeReveal"),
                disabled: !one.fileExists,
                onSelect: () => void api.creative.reveal(one.groupId, one.id).catch(fail),
              },
              {
                id: "copy",
                label: t("mcProject.creativeCopyImage"),
                disabled: !one.fileExists,
                onSelect: () =>
                  void api.creative.copyImage(one.groupId, one.id).then(
                    ({ ok }) => setNotice(ok ? t("mcProject.creativeCopied") : t("mcProject.creativeCopyFailed")),
                    fail,
                  ),
              },
            ]
          : []),
        {
          id: "reference",
          label: t("mcProject.creativeUseAsReference"),
          separatorBefore: !!one,
          onSelect: () => {
            addReferences(ids);
            setNotice(t("mcProject.creativeAddedAsReference"));
          },
        },
        ...(ids.length <= MAX_COMPARE
          ? [{ id: "compare", label: t("mcProject.creativeCompare"), onSelect: () => openCompare(ids) }]
          : []),
        { id: "move", label: t("mcProject.creativeMoveToEllipsis"), onSelect: () => setMoving(ids) },
        {
          id: "remove",
          label: t("mcProject.creativeRemoveSelected"),
          separatorBefore: true,
          onSelect: () => void removeFromLibrary(ids).catch(fail),
        },
        { id: "delete", label: t("mcProject.creativeDeleteFileEllipsis"), danger: true, onSelect: () => void deleteFiles(ids) },
      ],
    });
  };

  /** Right-click on empty space in the grid. */
  const backgroundMenu = (event: MouseEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest(".mc-creative-tile")) return;
    openContextMenu(event, {
      label: t("mcProject.creativeLibrary"),
      items: [
        {
          id: "import",
          label: t("mcProject.creativeImport"),
          onSelect: () =>
            void api.creative.pickAndImport(studioGroupId!, currentCategory).then(({ assets: added }) => {
              if (added.length) setNotice(t("mcProject.creativeImported", { count: added.length }));
              return reload();
            }, fail),
        },
        { id: "all", label: t("mcProject.creativeSelectAll"), disabled: !order.length, onSelect: () => setSelection([...order]) },
        ...(storage
          ? [
              {
                id: "reveal-folder",
                label: t("mcProject.creativeRevealFolder"),
                onSelect: () => void api.creative.revealStorage(studioGroupId!).catch(fail),
              },
            ]
          : []),
      ],
    });
  };

  /*
    Keyboard, as in photo libraries: ⌘A all, Esc clear, arrows move, Space or
    Enter previews, Delete removes from the library (undoable), ⌘Delete
    deletes the files. In the preview, ← → step through the grid. Typing in a
    field, a dialog or another page is left alone.
  */
  const keys = useRef<(event: KeyboardEvent) => void>(() => undefined);
  keys.current = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest("input, textarea, select, [contenteditable=true], [role=dialog]:not(.mc-creative-detail-layer)")) return;
    if (!scrollRef.current?.offsetParent && !detailId) return;
    if (picking || creating || moving || view.kind === "comparisons" || view.kind === "canvas" || contextMenu) return;
    const mod = event.metaKey || event.ctrlKey;
    if (detailId) {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        const next = neighbour(order, detailId, event.key === "ArrowLeft" ? -1 : 1);
        if (next) {
          event.preventDefault();
          // The selection follows, so closing the preview lands on this image.
          setDetailId(next);
          setFocusId(next);
          setSelection([next]);
          setAnchor(next);
        }
      }
      return;
    }
    if (grid.navigateKey(event)) return;
    const focus = grid.keyTarget;
    if ((event.key === " " || event.key === "Enter") && focus) {
      event.preventDefault();
      setDetailId(focus);
      return;
    }
    if ((event.key === "Backspace" || event.key === "Delete") && selection.length) {
      event.preventDefault();
      if (mod) void deleteFiles(selection);
      else void removeFromLibrary(selection).catch(fail);
    }
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => keys.current(event);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // In 对比集, the chat is told which images are being compared, in panel order.
  const compareContext = useMemo(() => {
    if (view.kind !== "comparisons") return "";
    const compared = comparing.ids.map((id) => assetById.get(id)).filter((asset): asset is CreativeAsset => !!asset);
    return compareContextText(compared, t("mcProject.creativeChatCompareIntro"));
  }, [view.kind, comparing.ids, assetById, t]);
  const compareCount = view.kind === "comparisons" ? comparing.ids.filter((id) => assetById.has(id)).length : 0;

  // On the canvas, each message carries what is visible and selected, unless
  // the chip is dismissed (until the selection changes), plus what was queued.
  const canvasSelection = canvasState ? `${canvasState.canvasId}:${canvasState.selected.map((node) => node.address).join(",")}` : "";
  useEffect(() => setCanvasContextOff(false), [canvasSelection]);
  const canvasContextOn = view.kind === "canvas" && !canvasContextOff && hasViewContext(canvasState);
  const attachmentLabel = (item: CanvasAttachment) =>
    item.kind === "thread"
      ? t("mcProject.canvasChipThread", { text: (item.messages[0]?.text ?? "").slice(0, 24) })
      : item.kind === "note"
        ? t("mcProject.canvasChipNote", { text: item.text.slice(0, 24) })
        : t("mcProject.canvasChipErrors", { board: item.boardId });
  const chatExtra: StudioChatExtra | undefined = studioGroupId
    ? {
        chips: [
          ...(canvasContextOn && canvasState
            ? [
                {
                  key: "canvas-view",
                  label: canvasState.selected.length
                    ? t("mcProject.canvasChatSelected", { count: canvasState.selected.length })
                    : t("mcProject.canvasChatVisible", { count: canvasState.visibleBoards.length }),
                  onRemove: () => setCanvasContextOff(true),
                },
              ]
            : []),
          ...attachments.map((item) => ({
            key: item.key,
            label: attachmentLabel(item),
            onRemove: () => setAttachments((list) => list.filter((entry) => entry.key !== item.key)),
          })),
        ],
        text: () =>
          [canvasContextOn && canvasState ? viewContextText(canvasState, makeNonce()) : "", attachmentsText(attachments, makeNonce())]
            .filter(Boolean)
            .join("\n\n"),
        // Threads go to the conversation that receives them; only it may answer.
        beforeSend: async (sessionId) => {
          for (const item of attachments) {
            if (item.kind !== "thread") continue;
            await api.creative.call("creative.canvasComments.assign", {
              groupId: studioGroupId,
              canvasId: item.canvasId,
              threadId: item.threadId,
              sessionId,
            });
          }
        },
        afterSend: () => setAttachments([]),
        request: chatRequest,
      }
    : undefined;
  const sendThread = (thread: CanvasThread, queue: boolean) => {
    if (view.kind !== "canvas") return;
    setAttachments((list) => addAttachment(list, threadAttachment(view.canvasId, thread)));
    if (!queue) setChatRequest({ id: Date.now(), text: t("mcProject.canvasHandleThread") });
  };

  /** Open 对比集 with these images as a new comparison. */
  const openCompare = (ids: string[]) => {
    setComparing({ ids: ids.slice(0, MAX_COMPARE), comparison: null });
    setView({ kind: "comparisons" });
  };

  const generate = async (input: {
    prompt: string;
    count: number;
    references: FormReference[];
    model: { providerId: string; modelId: string };
    category: string;
    aspectRatio: string;
    resolution: string;
  }) => {
    if (!studioGroupId) return;
    const { aspectRatio: ratio, resolution: size, ...rest } = input;
    await api.creative.generate({
      groupId: studioGroupId,
      ...rest,
      params: {
        count: input.count,
        ...(ratio ? { aspectRatio: ratio } : {}),
        ...(size && size !== "1k" ? { resolution: size } : {}),
      },
    });
    await reload();
  };

  const regenerate = (job: CreativeJob) => {
    setDetailId(null);
    setPrompt(job.snapshot.prompt ?? "");
    setReferences((job.snapshot.references ?? []).filter((reference) => assetById.has(reference.assetId)));
    const category = (job.snapshot as { category?: string }).category;
    if (typeof category === "string") setTargetCategory(category);
    const ratio = job.snapshot.params?.aspectRatio;
    const restored = typeof ratio === "string" && (ASPECT_RATIOS as readonly string[]).includes(ratio) ? ratio : "";
    setAspectRatio(restored);
    storeRatio(restored);
    const size = job.snapshot.params?.resolution;
    const restoredSize = typeof size === "string" ? size : "1k";
    setResolution(restoredSize);
    writeStored(RESOLUTION_KEY, restoredSize);
  };

  const saveComparison = async (ids: string[], existing: CreativeComparison | null, input: { title: string; note: string; chosen: string | null }) => {
    if (!studioGroupId) return;
    const { comparison } = await api.creative.call("creative.comparisons.save", {
      groupId: studioGroupId,
      ...(existing ? { comparisonId: existing.id } : {}),
      comparison: { ...input, assetIds: ids },
    });
    setComparing({ ids, comparison });
    setNotice(t("mcProject.creativeCompareSaved"));
    await reload();
  };

  /**
   * Store later images under `folder`'s `creative/`; a folder picked from disk
   * joins the project. Nothing already saved moves: earlier files and their
   * records stay where they are.
   */
  const changeStorage = async (folder: string, add: boolean) => {
    if (!studioGroupId) return;
    try {
      const answer = add
        ? await api.creative.call("creative.useWorkspace", {
            groupId: studioGroupId,
            folder,
            add: true,
          })
        : await api.creative.call("creative.setStorage", {
            groupId: studioGroupId,
            folder,
          });
      setStorage(answer.storage);
      setStorageProblem(null);
      setNotice(t("mcProject.creativeStorageChanged", { path: answer.storage.base }));
      if (add) await reloadProjects();
      await reload();
    } catch (failure) {
      fail(failure);
    }
  };

  /** Where new files go: one of the project's folders, or another picked from disk. */
  const storageMenu = (event: MouseEvent<HTMLElement>) => {
    if (!group) return;
    openContextMenu(event, {
      label: t("mcProject.creativeStorageChangeTitle"),
      items: [
        ...group.roots.map((root) => ({
          id: root.path,
          label: `${root.kind === "resources" ? t("mcProject.creativeStorageResources") : folderName(root.path)}/creative${
            root.path === storage?.folder ? ` · ${t("mcProject.creativeStorageCurrent")}` : ""
          }`,
          disabled: root.path === storage?.folder,
          onSelect: () => void changeStorage(root.path, false),
        })),
        {
          id: "pick",
          label: t("mcProject.creativeStoragePick"),
          separatorBefore: true,
          onSelect: () =>
            void api.pickProjectFolders().then(({ folders }) => {
              if (folders[0]) void changeStorage(folders[0], true);
            }, fail),
        },
      ],
    });
  };

  const categoryCall = async <M extends "creative.categories.create" | "creative.categories.rename" | "creative.categories.delete">(
    method: M,
    params: Omit<CreativeParams<M>, "groupId">,
  ) => {
    if (!studioGroupId) return;
    // Refusals reach the caller: the name field keeps the input and says why.
    await api.creative.call(method, { groupId: studioGroupId, ...params } as CreativeParams<M>);
    await reload();
  };

  const viewItem = (target: StudioView, icon: ReactNode, label: string, count: number) => (
    <button
      type="button"
      className={cx("settings-nav-item", view.kind === target.kind && "active")}
      onClick={() => setView(target)}
    >
      <span className="settings-nav-icon">{icon}</span>
      <span className="settings-nav-label">{label}</span>
      <span className="mc-plugins-nav-count">{count}</span>
    </button>
  );

  const viewTitle =
    view.kind === "category"
      ? view.path.split("/").join(" / ")
      : view.kind === "uncategorized"
        ? t("mcProject.creativeUncategorized")
        : view.kind === "comparisons"
          ? t("mcProject.creativeSectionComparisons")
          : t("mcProject.creativeViewAll");

  const sidebar = (
    <IntoSidebarSlot>
      <aside className="settings-nav sidebar-surface mc-creative-nav" aria-label={t("mcProject.creativeTitle")}>
        <div className="settings-nav-top drag">
          <div className="settings-search-wrap no-drag">
            <IconSearch size={14} />
            <input
              className="settings-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("mcProject.creativeSearch")}
              aria-label={t("mcProject.creativeSearch")}
              spellCheck={false}
            />
          </div>
        </div>
        <div className="settings-nav-scroll no-drag">
          <div className="settings-nav-group">
            <div className="settings-nav-group-label">{t("mcProject.creativeProjects")}</div>
            {creativeGroups.map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                className={cx("settings-nav-item", candidate.id === groupId && "active")}
                onClick={() => setGroupId(candidate.id)}
              >
                <span className="settings-nav-icon">
                  <IconPalette size={14} />
                </span>
                <span className="settings-nav-label">{candidate.name}</span>
              </button>
            ))}
            {group && !isCreative ? (
              <button type="button" className="settings-nav-item active">
                <span className="settings-nav-icon">
                  <IconFolder size={14} />
                </span>
                <span className="settings-nav-label">{group.name}</span>
              </button>
            ) : null}
            <button type="button" className="settings-nav-item" onClick={() => setCreating(true)}>
              <span className="settings-nav-icon">
                <IconPlus size={14} />
              </span>
              <span className="settings-nav-label">{t("mcProject.creativeNewProject")}</span>
            </button>
          </div>
          {studioGroupId && group ? (
            <>
              <div className="settings-nav-group">
                <div className="settings-nav-group-label">{group.name}</div>
                {storage ? (
                  <div className="settings-nav-item mc-creative-storage">
                    <button
                      type="button"
                      className="mc-creative-storage-path"
                      title={t("mcProject.creativeStorageReveal", { path: storage.base })}
                      onClick={() => void api.creative.revealStorage(group.id).catch(fail)}
                    >
                      <span className="settings-nav-icon">
                        <IconFolderOpen size={14} />
                      </span>
                      <span className="settings-nav-label">
                        <span className="mc-creative-muted">{t("mcProject.creativeStorage")}</span>
                        {storage.kind === "resources" ? t("mcProject.creativeStorageResources") : folderName(storage.folder)}/creative
                      </span>
                    </button>
                    <button
                      type="button"
                      className="mc-creative-storage-change"
                      title={t("mcProject.creativeStorageChangeTitle")}
                      aria-label={t("mcProject.creativeStorageChangeTitle")}
                      onClick={storageMenu}
                    >
                      {t("mcProject.creativeStorageChange")}
                    </button>
                  </div>
                ) : storageProblem ? (
                  <div className="settings-nav-item mc-creative-storage mc-creative-storage-problem" role="alert">
                    <span className="settings-nav-label">
                      <span className="mc-creative-muted">{t("mcProject.creativeStorage")}</span>
                      {t(storageProblem === "unlinked" ? "mcProject.creativeStorageUnlinked" : "mcProject.creativeStorageUnavailable")}
                    </span>
                    <button type="button" className="mc-creative-storage-change" onClick={storageMenu}>
                      {t("mcProject.creativeStorageChoose")}
                    </button>
                  </div>
                ) : null}
                {viewItem({ kind: "all" }, <IconImage size={14} />, t("mcProject.creativeViewAll"), assets.length)}
                {viewItem({ kind: "comparisons" }, <IconDiff size={14} />, t("mcProject.creativeSectionComparisons"), comparisons.length)}
              </div>
              <CanvasNav
                canvases={canvases}
                activeId={view.kind === "canvas" ? view.canvasId : null}
                onOpen={(canvasId) => setView({ kind: "canvas", canvasId })}
                onCreate={async (title) => {
                  const { canvas } = await api.creative.call("creative.canvas.create", { groupId: studioGroupId, title });
                  await reloadCanvases();
                  setView({ kind: "canvas", canvasId: canvas.id });
                }}
                onRename={async (canvasId, title) => {
                  await api.creative.call("creative.canvas.rename", { groupId: studioGroupId, canvasId, title });
                  await reloadCanvases();
                }}
                onDelete={(canvas) => {
                  if (!window.confirm(t("mcProject.canvasDeleteCanvasConfirm", { title: canvas.title, path: canvas.path }))) return;
                  void api.creative
                    .call("creative.canvas.delete", { groupId: studioGroupId, canvasId: canvas.id })
                    .then(async () => {
                      await reloadCanvases();
                      if (view.kind === "canvas" && view.canvasId === canvas.id) setView({ kind: "all" });
                    })
                    .catch(fail);
                }}
              />
              <CategoryTree
                nodes={tree}
                view={view}
                uncategorizedCount={assets.filter((asset) => !asset.category).length}
                onView={setView}
                onCreate={(path) => categoryCall("creative.categories.create", { path })}
                onRename={async (from, to) => {
                  await categoryCall("creative.categories.rename", { from, to });
                  if (view.kind === "category" && (view.path === from || view.path.startsWith(`${from}/`))) {
                    setView({ kind: "category", path: to + view.path.slice(from.length) });
                  }
                }}
                onDelete={async (path) => {
                  try {
                    await categoryCall("creative.categories.delete", { path });
                  } catch (failure) {
                    fail(failure);
                    return;
                  }
                  if (view.kind === "category" && (view.path === path || view.path.startsWith(`${path}/`))) {
                    setView({ kind: "all" });
                  }
                }}
                onDropAssets={(ids, category) => {
                  setAssetDrag(0);
                  void moveAssets(ids, category).catch(fail);
                }}
                dragCount={assetDrag}
              />
            </>
          ) : null}
        </div>
        <div className="settings-nav-footer">
          <button type="button" className="settings-back no-drag" onClick={() => setPage("chat")}>
            <IconChevronLeft size={15} />
            <span>{t("settings.backToApp")}</span>
          </button>
        </div>
      </aside>
    </IntoSidebarSlot>
  );

  return (
    <div className={cx("mc-creative mc-slot-page", !studioGroupId && "is-wide")}>
      {sidebar}
      {studioGroupId ? (
        <StudioPanel
          groupId={studioGroupId}
          projectPath={projectPath}
          prompt={prompt}
          onPrompt={setPrompt}
          references={references}
          onReferences={setReferences}
          onAddReference={() => setPicking(true)}
          categories={tree}
          category={targetCategory}
          onCategory={setTargetCategory}
          aspectRatio={aspectRatio}
          onAspectRatio={(ratio) => {
            setAspectRatio(ratio);
            storeRatio(ratio);
          }}
          resolution={resolution}
          onResolution={(value) => {
            setResolution(value);
            writeStored(RESOLUTION_KEY, value);
          }}
          onGenerate={generate}
          chatContext={compareContext}
          chatContextCount={compareCount}
          chatExtra={chatExtra}
        />
      ) : null}
      <section
        className={cx("mc-creative-main", dragging && "is-dragging")}
        onDragOver={(event) => {
          if (!studioGroupId || event.dataTransfer.types.includes(ASSET_DRAG_TYPE)) return;
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDropFiles}
      >
        {!loaded ? null : !group ? (
          <div className="mc-creative-empty">
            <span className="mc-creative-empty-icon" aria-hidden>
              <IconPalette size={26} />
            </span>
            <h2>{t("mcProject.creativeEmptyTitle")}</h2>
            <p>{t("mcProject.creativeEmptyBody")}</p>
            <Button variant="primary" onClick={() => setCreating(true)}>
              <IconPlus size={14} />
              {t("mcProject.creativeNewProject")}
            </Button>
          </div>
        ) : !isCreative ? (
          <div className="mc-creative-empty">
            <h2>{group.name}</h2>
            <p>{t("mcProject.creativeNotCreative")}</p>
            <Button variant="primary" onClick={() => void markCreative()}>
              {t("mcProject.creativeMarkCreative")}
            </Button>
          </div>
        ) : view.kind === "canvas" ? (
          <>
            <header className="mc-creative-head">
              <h1 className="page-title">
                {canvases.find((canvas) => canvas.id === view.canvasId)?.title ?? t("mcProject.canvasSection")}
              </h1>
              <div className="mc-creative-head-actions">
                <span className="mc-creative-muted">{t("mcProject.canvasHeadHint")}</span>
              </div>
            </header>
            <CanvasView
              key={view.canvasId}
              groupId={studioGroupId!}
              canvasId={view.canvasId}
              assetExists={(assetId) => (assets.length ? assetById.has(assetId) : undefined)}
              onViewState={setCanvasState}
              onAttach={(item) => setAttachments((list) => addAttachment(list, item))}
              onSendThread={sendThread}
            />
          </>
        ) : view.kind === "comparisons" ? (
          <CompareView
            ids={comparing.ids}
            library={assets}
            categories={categories}
            comparison={comparing.comparison}
            saved={comparisons}
            onOpen={(comparison) =>
              setComparing(comparison ? { ids: comparison.assetIds, comparison } : { ids: [], comparison: null })
            }
            onChange={(ids) => setComparing((current) => ({ ...current, ids }))}
            onSave={(input) => saveComparison(comparing.ids, comparing.comparison, input)}
          />
        ) : (
          <>
            <header className="mc-creative-head">
              <h1 className="page-title">{viewTitle}</h1>
              <div className="mc-creative-head-actions">
                {selection.length ? (
                  <>
                    <span className="mc-creative-muted">{t("mcProject.creativeSelected", { count: selection.length })}</span>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={selection.length > MAX_COMPARE}
                      onClick={() => openCompare(selection.slice(0, MAX_COMPARE))}
                    >
                      <IconDiff size={13} />
                      {t("mcProject.creativeCompare")}
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => addReferences(selection)}>
                      {t("mcProject.creativeUseAsReference")}
                    </Button>
                    <select
                      className="mc-creative-select"
                      value=""
                      aria-label={t("mcProject.creativeMoveTo")}
                      onChange={(event) => {
                        const value = event.target.value;
                        if (value === "") return;
                        void moveAssets(selection, value === "\u0000" ? "" : value).catch(fail);
                      }}
                    >
                      <option value="">{t("mcProject.creativeMoveTo")}</option>
                      <option value={"\u0000"}>{t("mcProject.creativeUncategorized")}</option>
                      {flat.map((node) => (
                        <option key={node.path} value={node.path}>
                          {"　".repeat(node.path.split("/").length - 1)}
                          {node.name}
                        </option>
                      ))}
                    </select>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void removeFromLibrary(selection).catch(fail)}
                    >
                      {t("mcProject.creativeRemoveSelected")}
                    </Button>
                    <Button size="sm" variant="ghost" className="mc-creative-danger" onClick={() => void deleteFiles(selection)}>
                      <IconTrash size={13} />
                      {t("mcProject.creativeDeleteFile")}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setSelection([])}>
                      <IconX size={13} />
                      {t("mcProject.creativeClearSelection")}
                    </Button>
                  </>
                ) : null}
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    void api.creative
                      .pickAndImport(studioGroupId!, currentCategory)
                      .then(({ assets: added }) => {
                        if (added.length) setNotice(t("mcProject.creativeImported", { count: added.length }));
                        return reload();
                      }, fail)
                  }
                >
                  <IconFolderOpen size={13} />
                  {t("mcProject.creativeImport")}
                </Button>
              </div>
            </header>
            {notice ? (
              <div className="mc-creative-notice" role="status">
                <span>{typeof notice === "string" ? notice : notice.text}</span>
                {typeof notice === "string" ? null : (
                  <button type="button" className="mc-creative-link" onClick={() => void notice.undo().catch(fail)}>
                    {t("mcProject.creativeUndo")}
                  </button>
                )}
                <button type="button" className="mc-creative-icon-button" aria-label={t("mcProject.creativeClose")} onClick={() => setNotice(null)}>
                  <IconX size={13} />
                </button>
              </div>
            ) : null}
            {error ? <p className="mc-creative-error">{error}</p> : null}

            <div
              className="mc-creative-scroll"
              ref={scrollRef}
              role="listbox"
              aria-multiselectable="true"
              aria-label={t("mcProject.creativeLibrary")}
              onPointerDown={startMarquee}
              onContextMenu={backgroundMenu}
            >
              {marquee ? <div className="mc-creative-marquee" style={marquee} aria-hidden /> : null}
              {groupsForGrid.length ? (
                groupsForGrid.map((entry) => (
                  <section key={entry.day} className="mc-creative-batch">
                    <div className="mc-creative-batch-head">
                      <span className="mc-creative-batch-prompt">{dayLabel(entry.day)}</span>
                      <span className="mc-creative-muted">
                        {t("mcProject.creativeImagesCount", { count: entry.items.filter((item) => item.kind === "asset").length })}
                      </span>
                    </div>
                    <div className="mc-creative-grid">
                      {entry.items.map((item) => {
                        if (item.kind === "missing") {
                          return (
                            <div key={item.key} className={cx("mc-creative-tile", "is-missing")} title={item.job.snapshot.prompt}>
                              <span className="mc-creative-tile-missing">
                                {item.status === "pending" || isActiveJob(item.job)
                                  ? t("mcProject.creativeGenerating")
                                  : item.error || t("mcProject.creativeJob_failed")}
                              </span>
                            </div>
                          );
                        }
                        const asset = item.asset;
                        return (
                        <AssetTile
                          key={asset.id}
                          asset={asset}
                          caption={caption(item)}
                          selectedIndex={selection.indexOf(asset.id) + 1}
                          focused={focusId === asset.id}
                          onSelect={(event) => selectTile(asset.id, event)}
                          onToggle={() => {
                            setSelection((current) => toggleSelection(current, asset.id));
                            setAnchor(asset.id);
                            setFocusId(asset.id);
                          }}
                          onOpen={() => {
                            setFocusId(asset.id);
                            setDetailId(asset.id);
                          }}
                          onContextMenu={(event) => tileMenu(event, asset)}
                          onDragEnd={() => setAssetDrag(0)}
                          onDragStart={(event) => {
                            // Dragging a selected tile carries the whole selection;
                            // an unselected one is selected first, as in Finder.
                            const ids = selection.includes(asset.id) ? selection : [asset.id];
                            if (!selection.includes(asset.id)) {
                              setSelection(ids);
                              setAnchor(asset.id);
                            }
                            setAssetDragImage(event.nativeEvent, ids, t("mcProject.creativeImagesCount", { count: ids.length }));
                            setAssetDrag(ids.length);
                            event.dataTransfer.setData(ASSET_DRAG_TYPE, JSON.stringify(ids));
                            event.dataTransfer.effectAllowed = "move";
                          }}
                        />
                        );
                      })}
                    </div>
                  </section>
                ))
              ) : (
                <div className="mc-creative-empty mc-creative-pad">
                  <p>{view.kind === "all" ? t("mcProject.creativeNoResults") : t("mcProject.creativeNothingHere")}</p>
                  <p className="mc-creative-muted">{t("mcProject.creativeDropHint")}</p>
                </div>
              )}
            </div>

            {queue.length ? (
              <footer className="mc-creative-queue" aria-label={t("mcProject.creativeQueue")}>
                {queue.map((job) => {
                  const progress = jobProgress(job);
                  return (
                    <div key={job.id} className="mc-creative-queue-item">
                      <JobStatusLabel job={job} />
                      <span className="mc-creative-queue-prompt" title={job.snapshot.prompt}>
                        {job.entry === "code" ? t("mcProject.creativeCodeDrawing") : job.snapshot.prompt}
                      </span>
                      <span className="mc-creative-muted">
                        {progress.done}/{progress.total}
                      </span>
                      {isActiveJob(job) ? (
                        <button type="button" className="mc-creative-link" onClick={() => void api.creative.cancel(job.id)}>
                          {t("mcProject.creativeCancel")}
                        </button>
                      ) : (job.status === "failed" || job.status === "partial" || job.status === "interrupted") && job.entry !== "code" ? (
                        <button type="button" className="mc-creative-link" onClick={() => regenerate(job)}>
                          {t("mcProject.creativeRetry")}
                        </button>
                      ) : null}
                    </div>
                  );
                })}
              </footer>
            ) : null}
          </>
        )}
      </section>

      <ContextMenu state={contextMenu} onClose={closeContextMenu} />

      {moving ? (
        <MoveDialog
          count={moving.length}
          categories={flat}
          current={(() => {
            const shared = new Set(moving.map((id) => assetById.get(id)?.category ?? ""));
            return shared.size === 1 ? [...shared][0]! : null;
          })()}
          onClose={() => setMoving(null)}
          onMove={(category) => {
            const ids = moving;
            setMoving(null);
            void moveAssets(ids, category).catch(fail);
          }}
        />
      ) : null}

      {creating ? (
        <NewCreativeDialog
          groups={groups}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            void reloadProjects().then(() => setGroupId(id));
          }}
        />
      ) : null}

      {picking && studioGroupId ? (
        <AssetPicker
          assets={assets}
          categories={categories}
          exclude={references.map((entry) => entry.assetId)}
          onClose={() => setPicking(false)}
          onPick={(ids) => {
            addReferences(ids);
            setPicking(false);
          }}
        />
      ) : null}

      {detailId && studioGroupId ? (
        <AssetDetail
          groupId={studioGroupId}
          assetId={detailId}
          onClose={() => setDetailId(null)}
          onOpenAsset={setDetailId}
          onUseAsReference={(asset) => {
            addReferences([asset.id]);
            setNotice(t("mcProject.creativeAddedAsReference"));
          }}
          onRegenerate={regenerate}
          onAddToCompare={(asset) => {
            setSelection((current) => (current.includes(asset.id) ? current : [...current, asset.id]));
            setDetailId(null);
          }}
          onChanged={() => void reload()}
        />
      ) : null}
    </div>
  );
}
