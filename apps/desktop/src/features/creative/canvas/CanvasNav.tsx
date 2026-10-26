import { useState } from "react";
import { useTranslation } from "react-i18next";
import { cx } from "../../../components/ui";
import { IconPlus, IconSquare } from "../../../components/icons";
import { ContextMenu, useContextMenu } from "../../../components/ContextMenu";
import type { CanvasSummary } from "@pi-desktop/shared";
import { NameInput } from "../CategoryTree";

/** The studio sidebar's canvases: open, create, rename and delete. */
export function CanvasNav({
  canvases,
  activeId,
  onOpen,
  onCreate,
  onRename,
  onDelete,
}: {
  canvases: CanvasSummary[];
  activeId: string | null;
  onOpen: (canvasId: string) => void;
  onCreate: (title: string) => Promise<void>;
  onRename: (canvasId: string, title: string) => Promise<void>;
  onDelete: (canvas: CanvasSummary) => void;
}) {
  const { t } = useTranslation();
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const { contextMenu: menu, openContextMenu, closeContextMenu } = useContextMenu();
  const noProblem = () => null;
  return (
    <div className="settings-nav-group mc-creative-tree">
      <div className="settings-nav-group-label mc-creative-tree-head">
        <span>{t("mcProject.canvasSection")}</span>
        <button
          type="button"
          className="mc-creative-tree-add is-visible"
          aria-label={t("mcProject.canvasNew")}
          title={t("mcProject.canvasNew")}
          onClick={() => setAdding(true)}
        >
          <IconPlus size={12} />
        </button>
      </div>
      {canvases.map((canvas) =>
        renaming === canvas.id ? (
          <div key={canvas.id} className="mc-creative-tree-edit" style={{ paddingLeft: 8 }}>
            <NameInput
              initial={canvas.title}
              placeholder={t("mcProject.canvasTitleHint")}
              refused={t("mcProject.canvasNameRefused")}
              check={noProblem}
              onSubmit={async (title) => {
                await onRename(canvas.id, title);
                setRenaming(null);
              }}
              onCancel={() => setRenaming(null)}
            />
          </div>
        ) : (
          <button
            key={canvas.id}
            type="button"
            className={cx("settings-nav-item", activeId === canvas.id && "active")}
            title={canvas.path}
            onClick={() => onOpen(canvas.id)}
            onDoubleClick={() => setRenaming(canvas.id)}
            onKeyDown={(event) => {
              if (event.key === "F2") setRenaming(canvas.id);
            }}
            onContextMenu={(event) =>
              openContextMenu(event, {
                label: canvas.title,
                items: [
                  { id: "open", label: t("mcProject.creativeOpen"), onSelect: () => onOpen(canvas.id) },
                  { id: "rename", label: t("mcProject.canvasRename"), onSelect: () => setRenaming(canvas.id) },
                  {
                    id: "delete",
                    label: t("mcProject.canvasDeleteCanvas"),
                    danger: true,
                    separatorBefore: true,
                    onSelect: () => onDelete(canvas),
                  },
                ],
              })
            }
          >
            <span className="settings-nav-icon">
              <IconSquare size={13} />
            </span>
            <span className="settings-nav-label">{canvas.title}</span>
            <span className="mc-plugins-nav-count">{canvas.boards}</span>
          </button>
        ),
      )}
      {adding ? (
        <div className="mc-creative-tree-edit" style={{ paddingLeft: 8 }}>
          <NameInput
            initial=""
            placeholder={t("mcProject.canvasTitleHint")}
            refused={t("mcProject.canvasNameRefused")}
            check={noProblem}
            onSubmit={async (title) => {
              await onCreate(title);
              setAdding(false);
            }}
            onCancel={() => setAdding(false)}
          />
        </div>
      ) : null}
      <ContextMenu state={menu} onClose={closeContextMenu} />
    </div>
  );
}
