import type { WebContents } from "electron";

// Host override also covers newer marketplace copies of the file manager.
export const FILE_SEARCH_CONTRAST_CSS = `
.cm-editor .cm-panel.cm-search .cm-textfield,
.cm-editor .cm-panel.cm-search .cm-button {
  background: #fff !important;
  color: #000 !important;
  -webkit-text-fill-color: #000 !important;
  caret-color: #000 !important;
  color-scheme: light !important;
}
.cm-editor .cm-panel.cm-search .cm-textfield::placeholder {
  color: #000 !important;
  -webkit-text-fill-color: #000 !important;
  opacity: 1 !important;
}
`;

export function installFileSearchContrast(contents: Pick<WebContents, "on" | "insertCSS" | "isDestroyed">, pluginId: string): void {
  if (pluginId !== "pi.file-manager") return;
  contents.on("dom-ready", () => {
    void contents.insertCSS(FILE_SEARCH_CONTRAST_CSS, { cssOrigin: "user" }).catch(error => {
      if (!contents.isDestroyed()) console.warn("File search contrast could not be applied", error);
    });
  });
}
