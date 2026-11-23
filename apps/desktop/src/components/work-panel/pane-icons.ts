import type { ComponentType } from "react";
import { IconBrowser, IconTerminal, IconActivity, IconGlobe, IconFolder, IconDiff, IconPlug, type IconProps } from "../icons";
import type { PaneId } from "../../lib/work-panel/work-panes-model";

export const PANE_ICONS: Record<PaneId, ComponentType<IconProps>> = {
  canvas: IconBrowser,
  terminal: IconTerminal,
  background: IconActivity,
  browser: IconGlobe,
  files: IconFolder,
  review: IconDiff,
  other: IconPlug,
};
