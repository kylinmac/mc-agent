import { describe, expect, it } from "vitest";
import {
  checkRunScriptToolAccess,
  clampRunScriptTimeout,
  isRunScriptDiscoverableTool,
  RUN_SCRIPT_DEFAULT_TIMEOUT_MS,
  RUN_SCRIPT_MAX_TIMEOUT_MS,
  RUN_SCRIPT_MIN_TIMEOUT_MS,
  RUN_SCRIPT_TOOL_NAME,
} from "./mc-run-script.js";

describe("mc-run-script", () => {
  it("allows unconditional read-only tools", () => {
    for (const name of [
      "Read",
      "Glob",
      "Grep",
      "CanvasRead",
      "WorkPanelList",
      "WorkPanelRead",
      "ContextHistory",
      "ProjectHistory",
      "ProjectTemplates",
      "ResolveRef",
    ]) {
      expect(checkRunScriptToolAccess(name)).toEqual({ allowed: true });
      expect(isRunScriptDiscoverableTool(name)).toBe(true);
    }
  });

  it("gates ProjectTasks and ProjectResources to read-only actions only", () => {
    expect(checkRunScriptToolAccess("ProjectTasks", { action: "list" })).toEqual({ allowed: true });
    expect(checkRunScriptToolAccess("ProjectTasks", { action: "get" })).toEqual({ allowed: true });
    expect(checkRunScriptToolAccess("ProjectTasks", { action: "create" }).allowed).toBe(false);
    expect(checkRunScriptToolAccess("ProjectTasks", {}).allowed).toBe(false);

    expect(checkRunScriptToolAccess("ProjectResources", { action: "list" })).toEqual({ allowed: true });
    expect(checkRunScriptToolAccess("ProjectResources", { action: "overview" })).toEqual({ allowed: true });
    expect(checkRunScriptToolAccess("ProjectResources", { action: "read" })).toEqual({ allowed: true });
    expect(checkRunScriptToolAccess("ProjectResources", { action: "confirm" }).allowed).toBe(false);
  });

  it("rejects mutating, shell, interactive, delegation, unknown, and recursive tools", () => {
    for (const name of [
      "Write",
      "Edit",
      "Bash",
      "Task",
      "SubagentRun",
      "AskUserQuestion",
      "CreateProject",
      "ProposeAlchemyArtifact",
      RUN_SCRIPT_TOOL_NAME,
      "mcp__github__create_issue",
      "",
    ]) {
      const res = checkRunScriptToolAccess(name);
      expect(res.allowed).toBe(false);
      if (!res.allowed) expect(res.reason.length).toBeGreaterThan(0);
    }
  });

  it("clamps timeout within safe bounds", () => {
    expect(clampRunScriptTimeout(undefined)).toBe(RUN_SCRIPT_DEFAULT_TIMEOUT_MS);
    expect(clampRunScriptTimeout(Number.NaN)).toBe(RUN_SCRIPT_DEFAULT_TIMEOUT_MS);
    expect(clampRunScriptTimeout(50)).toBe(RUN_SCRIPT_MIN_TIMEOUT_MS);
    expect(clampRunScriptTimeout(999_999)).toBe(RUN_SCRIPT_MAX_TIMEOUT_MS);
    expect(clampRunScriptTimeout(12_345.6)).toBe(12_346);
  });
});
