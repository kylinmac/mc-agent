import { afterEach, expect, it, vi } from "vitest";
import { AgentSidecar, type SidecarHostLink } from "./agent-sidecar.js";

// A real stdio child forwards requested calls over the production reverse RPC.
const child = `const rl=require('node:readline').createInterface({input:process.stdin});
const pending=new Map(); rl.on('line',line=>{const m=JSON.parse(line);
if(m.method==='probe'){pending.set('r'+m.id,m.id);console.log(JSON.stringify({id:'r'+m.id,method:'host.proxy',params:m.params}));}
else if(pending.has(m.id)){console.log(JSON.stringify({...m,id:pending.get(m.id)}));pending.delete(m.id);}});`;
const sidecars: AgentSidecar[] = [];
afterEach(async () => {
  await Promise.all(sidecars.splice(0).map((sidecar) => sidecar.dispose()));
});
function harness(toolName = "WorkPanelAction", allowed = true, childSource = child, esm = false) {
  const sidecar = new AgentSidecar({
    launch: { command: process.execPath, args: [...(esm ? ["--input-type=module"] : []), "-e", childSource] },
    onStderr: () => {},
  });
  sidecars.push(sidecar);
  const calls: string[] = [];
  const host: SidecarHostLink = {
    async call<T>(method: string): Promise<T> {
      calls.push(method);
      return { ok: allowed, content: allowed ? { authorized: true } : "denied" } as T;
    },
    onNotification: () => () => {},
    onExit: () => () => {},
  };
  sidecar.setHost(host);
  const execute = (mode = "agent", toolCallId = "i") =>
    sidecar.call<{ ok: boolean }>("probe", {
      method: "tools.execute",
      params: {
        sessionId: "s",
        toolCallId,
        mode,
        toolName: toolName,
        args: { tabId: "terminal:test", action: "input", text: "echo fixture" },
      },
    });
  return { sidecar, calls, execute };
}


it.each(["WorkPanelList", "WorkPanelRead", "WorkPanelAction"])("gates %s before touching desktop state", async tool => {
  const { sidecar, calls, execute } = harness(tool);
  sidecar.setLocalTool(tool, async () => { calls.push("desktop"); return { ok: true, content: {} }; });
  expect((await execute()).ok).toBe(true);
  expect(calls).toEqual(["tools.execute", "desktop"]);
});
it("denial never reaches a terminal or plugin panel", async () => {
  const { sidecar, execute } = harness("WorkPanelAction", false);
  const action = vi.fn(); sidecar.setLocalTool("WorkPanelAction", action);
  expect((await execute()).ok).toBe(false); expect(action).not.toHaveBeenCalled();
});
it("Plan permits inspection but refuses actions even with a permissive host", async () => {
  const denied = harness("WorkPanelAction");
  const action = vi.fn(); denied.sidecar.setLocalTool("WorkPanelAction", action);
  expect((await denied.execute("plan")).ok).toBe(false); expect(action).not.toHaveBeenCalled();
  const read = harness("WorkPanelRead");
  read.sidecar.setLocalTool("WorkPanelRead", async () => ({ ok: true, content: {} }));
  expect((await read.execute("plan")).ok).toBe(true);
});
