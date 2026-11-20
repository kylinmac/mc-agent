/**
 * mc-agent (R39 / R41): Alchemy `ResolveRef`, `ProposeAlchemyArtifact`,
 * renderer save flow, and bundled `programmatic-tools` / `alchemy` skills.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { register } from "node:module";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const {
  createAlchemyProposalBroker,
  createProposeAlchemyTool,
  createResolveRefTool,
  alchemyProposalDecisionOf,
} = await import("../electron/main/mc-alchemy.ts");
const { builtinSkills, loadBuiltinSkillBody } = await import("../electron/main/builtin-skills.ts");
const { saveAlchemyArtifact } = await import("../src/features/alchemy/save-from-proposal.ts");
const { ALCHEMY_SKILL_ID, PROGRAMMATIC_TOOLS_SKILL_ID } = await import("@pi-desktop/shared");

test("ResolveRef resolves workspace, resource, prompt, skill, session, and memory URIs and blocks symlink escape", async () => {
  const root = await mkdtemp(join(tmpdir(), "mc-alchemy-test-"));
  const workspaceDir = join(root, "workspace");
  const resourceDir = join(root, "resources");
  const outsideFile = join(root, "secret.txt");
  try {
    await mkdir(join(workspaceDir, "src"), { recursive: true });
    await mkdir(join(resourceDir, "rules"), { recursive: true });
    await writeFile(join(workspaceDir, "src", "app.ts"), "export const answer = 42;\n", "utf8");
    await writeFile(join(resourceDir, "rules", "check.md"), "# Review rules\nKeep it concise.\n", "utf8");
    await writeFile(outsideFile, "TOP_SECRET", "utf8");
    await symlink(outsideFile, join(workspaceDir, "escape.txt"));

    const host = {
      async call(method, params) {
        if (method === "session.get") {
          return { session: { projectPath: workspaceDir } };
        }
        if (method === "project.group.context") {
          return {
            context: {
              groupId: "grp-1",
              roots: [
                { path: workspaceDir, kind: "workspace" },
                { path: resourceDir, kind: "resources" },
              ],
            },
          };
        }
        if (method === "mcPrompts.get") {
          return {
            config: {
              templates: [{ id: "tpl-1", name: "Arch Review", persona: "", append: "Check boundaries." }],
            },
          };
        }
        if (method === "skills.read") {
          return {
            skill: {
              id: params.id,
              name: "Weekly Report",
              description: "Generate weekly report",
              body: "1. Summarize commits.",
              path: join(workspaceDir, ".agents/skills/weekly.md"),
            },
          };
        }
        if (method === "session.projectHistory") {
          return { sessionId: params.targetSessionId, messages: [{ role: "user", text: "Ship R41" }] };
        }
        if (method === "project.group.memory.get") {
          return {
            memory: {
              content: "",
              entries: [{ id: "m1", title: "Rule", content: "Never bypass host-core" }],
            },
          };
        }
        throw new Error(`Unexpected RPC: ${method}`);
      },
    };

    const resolveRef = createResolveRefTool(() => host);
    const ac = new AbortController();

    const ws = await resolveRef({ sessionId: "s1", args: { uri: "mc://workspace/src/app.ts" }, signal: ac.signal });
    assert.equal(ws.ok, true);
    assert.match(ws.content.content, /answer = 42/);

    const resFile = await resolveRef({ sessionId: "s1", args: { uri: "mc://resource/rules/check.md" }, signal: ac.signal });
    assert.equal(resFile.ok, true);
    assert.match(resFile.content.content, /Keep it concise/);

    const escaped = await resolveRef({ sessionId: "s1", args: { uri: "mc://workspace/escape.txt" }, signal: ac.signal });
    assert.equal(escaped.ok, false);
    assert.equal(escaped.errorCode, "FORBIDDEN");

    const traversal = await resolveRef({ sessionId: "s1", args: { uri: "mc://workspace/../secret.txt" }, signal: ac.signal });
    assert.equal(traversal.ok, false);
    assert.equal(traversal.errorCode, "INVALID_ARGUMENT");

    const prompt = await resolveRef({ sessionId: "s1", args: { uri: "mc://prompt/tpl-1" }, signal: ac.signal });
    assert.equal(prompt.ok, true);
    assert.match(prompt.content.content, /Check boundaries/);

    const skill = await resolveRef({ sessionId: "s1", args: { uri: "mc://skill/weekly" }, signal: ac.signal });
    assert.equal(skill.ok, true);
    assert.match(skill.content.content, /Summarize commits/);

    const sess = await resolveRef({ sessionId: "s1", args: { uri: "mc://session/prev-1" }, signal: ac.signal });
    assert.equal(sess.ok, true);
    assert.match(sess.content.content, /Ship R41/);

    const mem = await resolveRef({ sessionId: "s1", args: { uri: "mc://memory" }, signal: ac.signal });
    assert.equal(mem.ok, true);
    assert.match(mem.content.content, /Never bypass host-core/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ProposeAlchemyArtifact parks proposal until resolved and cleans up on abort", async () => {
  const broker = createAlchemyProposalBroker();
  const host = {
    async call(method) {
      if (method === "session.get") return { session: { projectPath: "/repo/app" } };
      throw new Error(`Unexpected RPC: ${method}`);
    },
  };
  const proposeTool = createProposeAlchemyTool(() => host, broker);

  const snapshots = [];
  const unsubscribe = broker.subscribe((list) => snapshots.push(list.length));

  const ac = new AbortController();
  const pending = proposeTool({
    sessionId: "sess-1",
    args: {
      kind: "skill",
      name: "月度资料核查",
      description: "按核查口径检查月度资料",
      body: "先调 ResolveRef 读取 mc://resource/rules.md",
      refs: ["mc://resource/rules.md"],
      suggestedTrigger: "用月度资料核查处理这批文件",
    },
    signal: ac.signal,
  });

  // Wait one tick for session.get to settle and broker.propose to enqueue.
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(broker.list().length, 1);
  const [queued] = broker.list();
  assert.equal(queued.projectPath, "/repo/app");
  assert.equal(queued.scope, "project");

  const ok = broker.resolve(
    queued.requestId,
    alchemyProposalDecisionOf({
      outcome: "saved",
      kind: "skill",
      id: "monthly-check",
      name: "月度资料核查",
      scope: "project",
      ref: "mc://skill/monthly-check",
    }),
  );
  assert.equal(ok, true);
  assert.equal(broker.list().length, 0);

  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.content.outcome, "saved");
  assert.equal(result.content.ref, "mc://skill/monthly-check");

  // Abort cleans up pending proposal without leaving ghosts.
  const ac2 = new AbortController();
  const abortedCall = proposeTool({
    sessionId: "sess-1",
    args: {
      kind: "prompt-template",
      name: "评审模板",
      description: "",
      body: "先看边界再看测试。",
    },
    signal: ac2.signal,
  });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(broker.list().length, 1);
  ac2.abort();
  const abortedResult = await abortedCall;
  assert.equal(broker.list().length, 0);
  assert.equal(abortedResult.content.outcome, "canceled");

  unsubscribe();
  assert.ok(snapshots.includes(1));
});

test("saveAlchemyArtifact persists skills and appends prompt templates without overwriting existing ones", async () => {
  const createdSkills = [];
  let savedConfig = null;
  const deps = {
    createUserSkill: async (skill) => {
      createdSkills.push(skill);
      return {
        skill: {
          id: "review-flow",
          name: skill.name ?? "Review Flow",
          description: skill.description ?? "",
          level: skill.level ?? "project",
          path: "/repo/.agents/skills/review-flow.md",
          enabled: true,
        },
      };
    },
    getSystemPromptConfig: async () => ({
      config: {
        templates: [{ id: "existing", name: "Existing", persona: "", append: "Keep me" }],
        modelRules: [],
        projectRules: [],
      },
    }),
    setSystemPromptConfig: async (config) => {
      savedConfig = config;
      return { config };
    },
    newId: () => "alchemy-fixed-id",
  };

  const skillRes = await saveAlchemyArtifact(
    {
      kind: "skill",
      name: "Review Flow",
      description: "Run structured code review",
      body: "Check tests and boundaries.",
      scope: "project",
      projectPath: "/repo",
    },
    deps,
  );
  assert.equal(skillRes.outcome, "saved");
  assert.equal(skillRes.ref, "mc://skill/review-flow");
  assert.equal(createdSkills[0].level, "project");
  assert.equal(createdSkills[0].projectPath, "/repo");

  const globalSkillRes = await saveAlchemyArtifact(
    {
      kind: "skill",
      name: "Global Review",
      description: "Global checklist",
      body: "Always check edge cases.",
      scope: "global",
      projectPath: "/repo",
    },
    deps,
  );
  assert.equal(globalSkillRes.outcome, "saved");
  assert.equal(globalSkillRes.scope, "global");
  assert.equal(createdSkills[1].level, "global");
  assert.equal(createdSkills[1].projectPath, undefined);

  const tplRes = await saveAlchemyArtifact(
    {
      kind: "prompt-template",
      name: "Strict Reviewer",
      description: "Architecture checks",
      body: "Always verify IPC boundaries.",
      scope: "global",
    },
    deps,
  );
  assert.equal(tplRes.outcome, "saved");
  assert.equal(tplRes.ref, "mc://prompt/alchemy-fixed-id");
  assert.equal(savedConfig.templates.length, 2);
  assert.equal(savedConfig.templates[0].id, "existing");
  assert.equal(savedConfig.templates[1].id, "alchemy-fixed-id");
  assert.match(savedConfig.templates[1].append, /Always verify IPC boundaries/);
});

test("bundled skills expose programmatic-tools everywhere and alchemy on local sessions", () => {
  const localIds = builtinSkills({ remote: false }).map((s) => s.id);
  assert.ok(localIds.includes(PROGRAMMATIC_TOOLS_SKILL_ID));
  assert.ok(localIds.includes(ALCHEMY_SKILL_ID));

  const remoteIds = builtinSkills({ remote: true }).map((s) => s.id);
  assert.ok(remoteIds.includes(PROGRAMMATIC_TOOLS_SKILL_ID));
  assert.ok(!remoteIds.includes(ALCHEMY_SKILL_ID));

  assert.match(loadBuiltinSkillBody(PROGRAMMATIC_TOOLS_SKILL_ID)?.body ?? "", /RunScript/);
  assert.match(loadBuiltinSkillBody(ALCHEMY_SKILL_ID)?.body ?? "", /ProposeAlchemyArtifact/);
});
