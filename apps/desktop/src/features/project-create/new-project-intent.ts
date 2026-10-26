import { create } from "zustand";
import { NEW_PROJECT_SKILL_ID } from "@pi-desktop/shared";

/*
  mc-agent (MC-ADR-0023): the home composer's way into conversational project
  creation. Typing something that reads like "make me a project" suggests it;
  the other entry points arm it directly. Sending in that mode prefixes the
  built-in skill, which the send path turns into an explicit Skill call.
*/

export const NEW_PROJECT_PREFIX = `/skill:${NEW_PROJECT_SKILL_ID} `;

// A verb that starts something, then the project: "新建…项目", "做一个…项目".
// "我在做的项目" or "build this project" stay quiet.
const ZH_INTENT = /(新建|创建|搭建|新开)[^。！？\n]{0,24}?(项目|工程)|(建|做|搭|开|起|弄|整)(一个|个|一套|套)[^。！？\n]{0,24}?(项目|工程)/;
const EN_INTENT = /\b(create|start|set ?up|scaffold|make|build)\s+(me\s+)?(a|an)\s+[^.!?\n]{0,30}?\bproject\b/i;

/** Whether a home draft reads like a request to start a new project. */
export function looksLikeNewProject(text: string): boolean {
  const value = text.trim();
  if (value.length < 4 || value.length > 2000 || value.startsWith("/")) return false;
  return ZH_INTENT.test(value) || EN_INTENT.test(value);
}

type IntentState = {
  /** The next home send creates a project (an entry point armed it). */
  armed: boolean;
  /** The suggestion was dismissed for this exact draft. */
  dismissedFor: string | null;
  arm: () => void;
  disarm: () => void;
  dismiss: (draft: string) => void;
};

export const useNewProjectIntent = create<IntentState>((set) => ({
  armed: false,
  dismissedFor: null,
  arm: () => set({ armed: true, dismissedFor: null }),
  disarm: () => set({ armed: false }),
  dismiss: (draft) => set({ dismissedFor: draft.trim() }),
}));
