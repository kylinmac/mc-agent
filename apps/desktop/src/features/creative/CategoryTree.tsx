import { useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cx } from "../../components/ui";
import { ContextMenu, useContextMenu } from "../../components/ContextMenu";
import { IconChevronDown, IconChevronRight, IconFolder, IconPlus } from "../../components/icons";
import type { CategoryNode, StudioView } from "./creative-model";

/*
  mc-agent creative studio: the category tree in the sidebar. Categories are
  folders under `creative/`; they nest, and images are moved between them by
  dragging tiles onto a row. A row creates children (+), renames on
  double-click, and has a context menu.
*/

export const ASSET_DRAG_TYPE = "application/x-mc-creative-assets";

function draggedIds(event: DragEvent): string[] | null {
  if (!event.dataTransfer.types.includes(ASSET_DRAG_TYPE)) return null;
  try {
    const ids = JSON.parse(event.dataTransfer.getData(ASSET_DRAG_TYPE)) as unknown;
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function NameInput({
  initial,
  placeholder,
  onDone,
}: {
  initial: string;
  placeholder: string;
  onDone: (value: string | null) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <input
      autoFocus
      className="mc-creative-input mc-creative-tree-input"
      value={value}
      placeholder={placeholder}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => onDone(value.trim() ? value.trim() : null)}
      onKeyDown={(event) => {
        if (event.key === "Escape") onDone(null);
        if (event.key === "Enter" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          onDone(value.trim() ? value.trim() : null);
        }
      }}
    />
  );
}

export function CategoryTree({
  nodes,
  view,
  uncategorizedCount,
  onView,
  onCreate,
  onRename,
  onDelete,
  onDropAssets,
  dragCount = 0,
}: {
  nodes: CategoryNode[];
  view: StudioView;
  uncategorizedCount: number;
  onView: (view: StudioView) => void;
  onCreate: (path: string) => Promise<void>;
  onRename: (from: string, to: string) => Promise<void>;
  onDelete: (path: string) => Promise<void>;
  /** Images dropped on a category ("" for uncategorized). */
  onDropAssets: (ids: string[], category: string) => void;
  /** Images being dragged from the grid right now (0 when none). */
  dragCount?: number;
}) {
  const { t } = useTranslation();
  const { contextMenu, openContextMenu, closeContextMenu } = useContextMenu();
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  // The parent a new category is being typed under ("" for top level).
  const [adding, setAdding] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  // Hovering a collapsed category while dragging opens it after a moment.
  const expandTimer = useRef<{ path: string; timer: number } | null>(null);
  const cancelExpand = () => {
    if (expandTimer.current) window.clearTimeout(expandTimer.current.timer);
    expandTimer.current = null;
  };
  useEffect(() => {
    if (!dragCount) {
      setDropTarget(null);
      cancelExpand();
    }
  }, [dragCount]);
  useEffect(() => cancelExpand, []);

  const dropProps = (category: string) => ({
    onDragOver: (event: DragEvent) => {
      if (!event.dataTransfer.types.includes(ASSET_DRAG_TYPE)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      setDropTarget(category);
      if (category && collapsed.has(category) && expandTimer.current?.path !== category) {
        cancelExpand();
        expandTimer.current = {
          path: category,
          timer: window.setTimeout(() => {
            setCollapsed((current) => new Set([...current].filter((path) => path !== category)));
            expandTimer.current = null;
          }, 600),
        };
      }
    },
    onDragLeave: (event: DragEvent) => {
      // Moving onto the row's own children is not leaving it.
      if (event.relatedTarget instanceof Node && (event.currentTarget as Node).contains(event.relatedTarget)) return;
      setDropTarget((current) => (current === category ? null : current));
      if (expandTimer.current?.path === category) cancelExpand();
    },
    onDrop: (event: DragEvent) => {
      const ids = draggedIds(event);
      setDropTarget(null);
      cancelExpand();
      if (!ids?.length) return;
      event.preventDefault();
      onDropAssets(ids, category);
    },
  });

  const startAdd = (parent: string) => {
    if (parent) setCollapsed((current) => new Set([...current].filter((path) => path !== parent)));
    setAdding(parent);
  };

  const row = (node: CategoryNode, depth: number): ReactNode => {
    const open = !collapsed.has(node.path);
    const active = view.kind === "category" && view.path === node.path;
    const parent = node.path.includes("/") ? node.path.slice(0, node.path.lastIndexOf("/")) : "";
    return (
      <div key={node.path}>
        {renaming === node.path ? (
          <div className="mc-creative-tree-edit" style={{ paddingLeft: 8 + depth * 14 }}>
            <NameInput
              initial={node.name}
              placeholder={t("mcProject.creativeCategoryName")}
              onDone={(value) => {
                setRenaming(null);
                if (value && value !== node.name) void onRename(node.path, parent ? `${parent}/${value}` : value);
              }}
            />
          </div>
        ) : (
          <div
            role="button"
            tabIndex={0}
            className={cx("settings-nav-item mc-creative-tree-row", active && "active", dropTarget === node.path && "is-drop")}
            style={{ paddingLeft: 10 + depth * 14 }}
            onClick={() => onView({ kind: "category", path: node.path })}
            onDoubleClick={() => setRenaming(node.path)}
            onKeyDown={(event) => {
              if (event.key === "Enter") onView({ kind: "category", path: node.path });
              if (event.key === "F2") setRenaming(node.path);
            }}
            onContextMenu={(event) =>
              openContextMenu(event, {
                label: node.path,
                items: [
                  { id: "add", label: t("mcProject.creativeCategoryAddChild"), onSelect: () => startAdd(node.path) },
                  { id: "rename", label: t("mcProject.creativeCategoryRename"), onSelect: () => setRenaming(node.path) },
                  {
                    id: "delete",
                    label: t("mcProject.creativeCategoryDelete"),
                    danger: true,
                    separatorBefore: true,
                    onSelect: () => {
                      if (window.confirm(t("mcProject.creativeCategoryDeleteConfirm", { name: node.path }))) {
                        void onDelete(node.path);
                      }
                    },
                  },
                ],
              })
            }
            {...dropProps(node.path)}
          >
            {node.children.length ? (
            <button
              type="button"
              className="mc-creative-tree-toggle"
              aria-label={open ? t("mcProject.creativeCollapse") : t("mcProject.creativeExpand")}
              style={{ left: depth * 14 }}
              onClick={(event) => {
                event.stopPropagation();
                setCollapsed((current) => {
                  const next = new Set(current);
                  if (next.has(node.path)) next.delete(node.path);
                  else next.add(node.path);
                  return next;
                });
              }}
            >
              {open ? <IconChevronDown size={10} /> : <IconChevronRight size={10} />}
            </button>
            ) : null}
            <span className="settings-nav-icon">
              <IconFolder size={14} />
            </span>
            <span className="settings-nav-label">{node.name}</span>
            <button
              type="button"
              className="mc-creative-tree-add"
              aria-label={t("mcProject.creativeCategoryAddChild")}
              title={t("mcProject.creativeCategoryAddChild")}
              onClick={(event) => {
                event.stopPropagation();
                startAdd(node.path);
              }}
            >
              <IconPlus size={12} />
            </button>
            {dropTarget === node.path ? (
              <span className="mc-creative-tree-drop-label">{t("mcProject.creativeDropHere")}</span>
            ) : (
              <span className="mc-plugins-nav-count">{node.total}</span>
            )}
          </div>
        )}
        {open ? node.children.map((child) => row(child, depth + 1)) : null}
        {adding === node.path ? (
          <div className="mc-creative-tree-edit" style={{ paddingLeft: 8 + (depth + 1) * 14 }}>
            <NameInput
              initial=""
              placeholder={t("mcProject.creativeCategoryName")}
              onDone={(value) => {
                setAdding(null);
                if (value) void onCreate(`${node.path}/${value}`);
              }}
            />
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <div className={cx("settings-nav-group mc-creative-tree", dragCount > 0 && "is-drag-active")}>
      <div className="settings-nav-group-label mc-creative-tree-head">
        <span className={cx(dragCount > 0 && "mc-creative-tree-hint")} role={dragCount > 0 ? "status" : undefined}>
          {dragCount > 0 ? t("mcProject.creativeDragHint", { count: dragCount }) : t("mcProject.creativeCategories")}
        </span>
        <button
          type="button"
          className="mc-creative-tree-add is-visible"
          aria-label={t("mcProject.creativeCategoryAdd")}
          title={t("mcProject.creativeCategoryAdd")}
          onClick={() => startAdd("")}
        >
          <IconPlus size={12} />
        </button>
      </div>
      <div
        role="button"
        tabIndex={0}
        className={cx("settings-nav-item mc-creative-tree-row", view.kind === "uncategorized" && "active", dropTarget === "" && "is-drop")}
        onClick={() => onView({ kind: "uncategorized" })}
        onKeyDown={(event) => {
          if (event.key === "Enter") onView({ kind: "uncategorized" });
        }}
        {...dropProps("")}
      >
        <span className="settings-nav-icon">
          <IconFolder size={14} />
        </span>
        <span className="settings-nav-label">{t("mcProject.creativeUncategorized")}</span>
        {dropTarget === "" ? (
          <span className="mc-creative-tree-drop-label">{t("mcProject.creativeDropHere")}</span>
        ) : (
          <span className="mc-plugins-nav-count">{uncategorizedCount}</span>
        )}
      </div>
      {nodes.map((node) => row(node, 0))}
      {adding === "" ? (
        <div className="mc-creative-tree-edit" style={{ paddingLeft: 8 }}>
          <NameInput
            initial=""
            placeholder={t("mcProject.creativeCategoryNameHint")}
            onDone={(value) => {
              setAdding(null);
              if (value) void onCreate(value);
            }}
          />
        </div>
      ) : null}
      {!nodes.length && adding === null ? (
        <p className="mc-creative-muted mc-creative-tree-empty">{t("mcProject.creativeCategoriesEmpty")}</p>
      ) : null}
      <ContextMenu state={contextMenu} onClose={closeContextMenu} />
    </div>
  );
}
