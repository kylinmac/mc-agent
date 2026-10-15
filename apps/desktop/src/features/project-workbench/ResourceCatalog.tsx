import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ResourceItem, ResourceListing, ResourceStatus } from "@pi-desktop/shared";
import { Button } from "../../components/ui";
import { groupByCategory } from "./resource-view";

const STATUS_KEYS: Record<ResourceStatus, string> = {
  draft: "mcProject.statusDraft",
  confirmed: "mcProject.statusConfirmed",
  changed: "mcProject.statusChanged",
  deprecated: "mcProject.statusDeprecated",
  missing: "mcProject.statusMissing",
};

/*
  R3/R4 resource list: the resource folder's files by category plus
  registered workspace files and links, each with its confirmation state.
  Confirming is an explicit action; opening or registering never confirms.
*/
export function ResourceCatalog({
  listing,
  onOpen,
  onSetStatus,
  onRemove,
  onRegisterFile,
  onAddLink,
  onRefresh,
}: {
  listing: ResourceListing | null;
  onOpen: (item: ResourceItem) => void;
  onSetStatus: (item: ResourceItem, status: "draft" | "confirmed" | "deprecated") => void;
  onRemove: (item: ResourceItem) => void;
  onRegisterFile: (category: string) => void;
  onAddLink: (url: string, category: string) => void;
  onRefresh: () => void;
}) {
  const { t } = useTranslation();
  const [category, setCategory] = useState("");
  const [link, setLink] = useState("");
  if (!listing) return null;
  const groups = groupByCategory(listing.items, listing.categories);

  return (
    <div className="mc-workbench-catalog">
      <div className="mc-workbench-row">
        <span className="mc-workbench-label">{t("mcProject.resourcesListTitle")}</span>
        <Button size="sm" variant="ghost" onClick={onRefresh}>
          {t("mcProject.refresh")}
        </Button>
      </div>
      {listing.items.length === 0 ? (
        <p className="mc-workbench-muted">{t("mcProject.resourcesEmpty")}</p>
      ) : null}
      {groups
        .filter((group) => group.items.length > 0)
        .map((group) => (
          <div key={group.category || "__uncategorized"} className="mc-workbench-category">
            <div className="mc-workbench-category-title">
              {group.category || t("mcProject.uncategorized")}
            </div>
            <ul className="mc-workbench-resources">
              {group.items.map((item) => (
                <li key={item.key} className="mc-workbench-resource">
                  <button
                    type="button"
                    className="mc-workbench-link"
                    title={item.path ?? item.url}
                    disabled={item.status === "missing"}
                    onClick={() => onOpen(item)}
                  >
                    {item.title}
                  </button>
                  {item.source !== "folder" ? (
                    <span className="mc-workbench-tag">
                      {item.source === "url" ? t("mcProject.sourceLink") : t("mcProject.sourceWorkspace")}
                    </span>
                  ) : null}
                  <span className={`mc-workbench-status is-${item.status}`}>{t(STATUS_KEYS[item.status])}</span>
                  <span className="mc-workbench-actions">
                    {item.status === "draft" || item.status === "deprecated" ? (
                      <Button size="sm" variant="ghost" onClick={() => onSetStatus(item, "confirmed")}>
                        {t("mcProject.actionConfirm")}
                      </Button>
                    ) : null}
                    {item.status === "changed" ? (
                      <Button size="sm" variant="ghost" onClick={() => onSetStatus(item, "confirmed")}>
                        {t("mcProject.actionReconfirm")}
                      </Button>
                    ) : null}
                    {item.status === "confirmed" || item.status === "changed" || item.status === "deprecated" ? (
                      <Button size="sm" variant="ghost" onClick={() => onSetStatus(item, "draft")}>
                        {t("mcProject.actionDraft")}
                      </Button>
                    ) : null}
                    {item.status !== "deprecated" && item.status !== "missing" ? (
                      <Button size="sm" variant="ghost" onClick={() => onSetStatus(item, "deprecated")}>
                        {t("mcProject.actionDeprecate")}
                      </Button>
                    ) : null}
                    {item.source !== "folder" ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        title={t("mcProject.actionRemoveHint")}
                        onClick={() => onRemove(item)}
                      >
                        {t("mcProject.actionRemove")}
                      </Button>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      {listing.truncated ? <p className="mc-workbench-muted">{t("mcProject.resourcesTruncated")}</p> : null}
      <div className="mc-workbench-row">
        <label className="mc-workbench-label" htmlFor="mc-resource-category">
          {t("mcProject.categoryLabel")}
        </label>
        <select
          id="mc-resource-category"
          className="mc-workbench-select"
          value={category}
          onChange={(event) => setCategory(event.target.value)}
        >
          <option value="">{t("mcProject.uncategorized")}</option>
          {listing.categories.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <Button size="sm" variant="ghost" onClick={() => onRegisterFile(category)}>
          {t("mcProject.registerFile")}
        </Button>
        <input
          className="mc-workbench-description mc-workbench-link-input"
          aria-label={t("mcProject.addLink")}
          placeholder={t("mcProject.linkPlaceholder")}
          value={link}
          onChange={(event) => setLink(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && link.trim()) {
              onAddLink(link.trim(), category);
              setLink("");
            }
          }}
        />
        <Button
          size="sm"
          variant="ghost"
          disabled={!link.trim()}
          onClick={() => {
            onAddLink(link.trim(), category);
            setLink("");
          }}
        >
          {t("mcProject.addLink")}
        </Button>
      </div>
    </div>
  );
}
