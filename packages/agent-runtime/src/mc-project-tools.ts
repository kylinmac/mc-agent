import { Type } from "@earendil-works/pi-ai";
import {
  CREATE_PROJECT_TOOL_NAME,
  PROJECT_DRAFT_DESCRIPTION_MAX,
  PROJECT_DRAFT_FOLDERS_MAX,
  PROJECT_DRAFT_PROMPT_MAX,
  PROJECT_PROPOSAL_FOLDER_MAX,
  PROJECT_PROPOSAL_NAME_MAX,
  PROJECT_PROPOSAL_NOTE_MAX,
  PROJECT_PROPOSAL_TEMPLATES_MAX,
  PROJECT_TEMPLATES_TOOL_NAME,
} from "@pi-desktop/shared";

/**
 * mc-agent (MC-ADR-0023): create a project from the conversation. Electron
 * main serves both tools (host-local); `CreateProject` shows the proposal as
 * a card and waits for the user, so it never writes before they confirm.
 */
export { CREATE_PROJECT_TOOL_NAME, PROJECT_TEMPLATES_TOOL_NAME };

export const projectTemplatesDescription = [
  "List what a new mc-agent project can start from: the resource-folder templates (name, description, folders with what belongs in each), the system prompt templates, and suggested parent folders (where the user's existing projects live, then the home folder).",
  "Call it before CreateProject to rank templates and pick a location.",
].join(" ");

export const projectTemplatesParameters = {};

export const createProjectDescription = [
  "Propose a new project to the user. The desktop shows it as a card where the user confirms or edits the location, picks a template, and presses Create; nothing is written before that. Returns what the user decided.",
  "The project is the folder `parent/folder` (created when missing; an existing non-empty folder is used as it is, its files untouched). With a template the project also gets a resource folder under the mc-agent home.",
  "Rank up to three existing templates in `templates`, best first; pass one when it clearly fits, none when nothing does. To offer a new template instead, pass `draft` (English folder names, one-line notes, optional system prompt rules); by default it is used only for this project.",
  "Outcomes: `created` (done; tell the user briefly), `draft-requested` (the user wants a new template: draft one and call again with `draft`), `revise` (the user wants changes: ask or wait for them, then call again), `failed` (report the step and message).",
].join(" ");

export const createProjectParameters = {
  name: Type.String({ minLength: 1, maxLength: PROJECT_PROPOSAL_NAME_MAX, description: "Project name shown in the sidebar, in the user's language." }),
  parent: Type.String({ minLength: 1, description: "Absolute folder (or starting with ~) that will contain the project folder." }),
  folder: Type.String({ minLength: 1, maxLength: PROJECT_PROPOSAL_FOLDER_MAX, description: "Name of the project folder inside parent, e.g. ledger-miniapp." }),
  templates: Type.Optional(
    Type.Array(Type.String(), {
      maxItems: PROJECT_PROPOSAL_TEMPLATES_MAX,
      description: "Existing resource template names from ProjectTemplates, best match first.",
    }),
  ),
  draft: Type.Optional(
    Type.Object(
      {
        name: Type.String({ minLength: 1, maxLength: 80, description: "Template name, e.g. video." }),
        description: Type.String({ maxLength: PROJECT_DRAFT_DESCRIPTION_MAX, description: "One line: what kind of project it is for." }),
        folders: Type.Array(
          Type.Object({
            path: Type.String({ description: "Relative folder path, `/`-separated, English, e.g. assets/voice." }),
            description: Type.String({ maxLength: PROJECT_DRAFT_DESCRIPTION_MAX, description: "One line: what belongs in it." }),
          }),
          { minItems: 1, maxItems: PROJECT_DRAFT_FOLDERS_MAX },
        ),
        systemPrompt: Type.Optional(
          Type.String({ maxLength: PROJECT_DRAFT_PROMPT_MAX, description: "Extra system prompt rules for this project's conversations." }),
        ),
      },
      { description: "A new resource-folder template, when no existing one fits." },
    ),
  ),
  promptTemplateId: Type.Optional(Type.String({ description: "Id of an existing system prompt template for the project." })),
  note: Type.Optional(Type.String({ maxLength: PROJECT_PROPOSAL_NOTE_MAX, description: "One short sentence on why this template and location." })),
};
