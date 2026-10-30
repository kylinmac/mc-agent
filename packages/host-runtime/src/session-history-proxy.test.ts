import { afterEach, expect, it } from "vitest";
import { AgentSidecar, type SidecarHostLink } from "./agent-sidecar.js";

// `probe` turns into a reverse host.proxy call; every other method answers at once.
const child = `const rl=require('node:readline').createInterface({input:process.stdin});
const pending=new Map(); rl.on('line',line=>{const m=JSON.parse(line);
if(m.method==='probe'){pending.set('r'+m.id,m.id);console.log(JSON.stringify({id:'r'+m.id,method:'host.proxy',params:m.params}));}
else if(pending.has(m.id)){console.log(JSON.stringify({...m,id:pending.get(m.id)}));pending.delete(m.id);}
else if(m.method){console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{accepted:true}}));}});`;
const sidecars: AgentSidecar[] = [];
afterEach(async () => {
  await Promise.all(sidecars.splice(0).map((sidecar) => sidecar.dispose()));
});

function harness() {
  const sidecar = new AgentSidecar({
    launch: { command: process.execPath, args: ["-e", child] },
    onStderr: () => {},
  });
  sidecars.push(sidecar);
  const forwarded: Array<{ method: string; params: unknown }> = [];
  const host: SidecarHostLink = {
    async call<T>(method: string, params?: unknown): Promise<T> {
      forwarded.push({ method, params });
      return { status: "ok", messages: [] } as T;
    },
    onNotification: () => () => {},
    onExit: () => () => {},
  };
  sidecar.setHost(host);
  const read = (sessionId: string) =>
    sidecar.call<{ status?: string; code?: number }>("probe", {
      method: "session.historyRead",
      params: { sessionId, limit: 5 },
    });
  return { sidecar, forwarded, read };
}

it("admits history reads only for sessions launched into this sidecar", async () => {
  const { sidecar, forwarded, read } = harness();
  await expect(read("s1")).rejects.toMatchObject({ data: { errorCode: "SESSION_NOT_BOUND" } });
  expect(forwarded).toEqual([]);

  await sidecar.call("agent.prompt", { sessionId: "s1", text: "hi" });
  await expect(read("s1")).resolves.toMatchObject({ status: "ok" });
  await expect(read("s2")).rejects.toMatchObject({ data: { errorCode: "SESSION_NOT_BOUND" } });
  expect(forwarded.map((call) => call.method)).toEqual(["session.historyRead"]);

  await sidecar.call("agent.disposeSession", { sessionId: "s1" });
  await expect(read("s1")).rejects.toMatchObject({ data: { errorCode: "SESSION_NOT_BOUND" } });
  expect(forwarded).toHaveLength(1);
});

it("leaves other session reads unchanged", async () => {
  const { sidecar, forwarded } = harness();
  await sidecar.call("probe", { method: "session.get", params: { id: "any" } });
  expect(forwarded.map((call) => call.method)).toEqual(["session.get"]);
});
