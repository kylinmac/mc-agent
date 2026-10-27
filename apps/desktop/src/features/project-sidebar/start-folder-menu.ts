import { chooseStartFolder } from "../project-workbench/start-folder.ts";
import type { ProjectFolderIndex } from "./project-merge.ts";

/*
  mc-agent (#41): the folders a new task of a sidebar project can start in.
  A project with several folders (resource folder, workspaces, reference
  folders) asks where to start instead of always using its first folder; the
  folder picked last for the project (R1.5) is the selected one.
*/

export type StartFolderChoice = {
  groupId: string;
  path: string;
  label: string;
  selected: boolean;
};

/** Empty when the project has a single folder or is not a known project group. */
export function projectStartFolderChoices(
  index: ProjectFolderIndex,
  key: string,
  remembered: (groupId: string) => string | null,
): StartFolderChoice[] {
  const info = index.get(key);
  if (!info) return [];
  const members = info.memberKeys
    .map((memberKey) => index.get(memberKey))
    .filter((member): member is NonNullable<typeof member> => member?.groupId === info.groupId);
  if (members.length < 2) return [];
  const primary = members[0].path;
  const current = chooseStartFolder(members, primary, remembered(info.groupId));
  return members.map((member) => ({
    groupId: info.groupId,
    path: member.path,
    label: member.label,
    selected: member.path === current,
  }));
}
