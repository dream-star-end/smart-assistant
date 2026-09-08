import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { createMemoryAuthSession } from "../../lib/authSession";
import { ToastProvider, TooltipProvider } from "../ui";
import { MemoryPanel } from "./MemoryPanel";

const profile = { profileId: "explicit-profile", legacyAgentId: "old-resource", canonicalAgentId: "current-agent", localPersonaPath: "agents/old-resource/CLAUDE.md", localSkillStorageId: "old-resource" };
const projection = { schema: 1, userId: "3", profiles: [{ profile, readiness: "ready" }] };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function fixture(options: { projection?: unknown; readiness?: string; failRead?: boolean; failMarket?: boolean; failSave?: number; mismatch?: boolean; rejectAck?: boolean } = {}) {
  const auth = createMemoryAuthSession(() => {}, "token");
  let local = "本地原始手册\n原文";
  const market = "市场底线原文";
  const requests: { path: string; method: string; body: string }[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input), method = init?.method ?? "GET", body = String(init?.body ?? "");
    requests.push({ path, method, body });
    if (path === "/api/agents") return json({ agents: [{id:"butler"},{id:"personal-butler"}], ...(Object.hasOwn(options, "projection") ? {identityCompat: options.projection} : {identityCompat: {...projection, profiles:[{profile,readiness:options.readiness ?? "ready"}]}}) });
    if (path === "/api/auth/refresh") return json({error:{code:"INVALID_REFRESH",message:"登录已过期"}},401);
    if (path === "/api/agents/old-resource/persona") {
      if (method === "PUT") {
        if (options.failSave) return json({error:"本地手册保存被拒绝"},options.failSave);
        if (options.rejectAck) return json({ok:false});
        local = options.mismatch ? "另一份内容" : JSON.parse(body).text;
        return json({ok:true,path:"/fixture/local"});
      }
      if (options.failRead) return json({error:"本地手册读取失败"},500);
      return json({text:local,path:"/fixture/local"});
    }
    if (path === "/api/agents/current-agent/persona") return options.failMarket ? json({error:"市场暂不可读"},404) : json({text:market,path:"/fixture/market"});
    if (path.endsWith("/memory/memory")) return json({kind:"index",text:"",files:[],version:"v1"});
    if (path.endsWith("/auto-dream-report")) return json({status:"idle",pendingSessions:0});
    return json({error:"not found"},404);
  });
  vi.stubGlobal("fetch", fetcher);
  const renderManual = (id = "current-agent") => render(<TooltipProvider><ToastProvider><MemoryPanel auth={auth} agentId={id} agents={[{id,name:id}]}/></ToastProvider></TooltipProvider>);
  const open = async () => { renderManual(); fireEvent.click(await screen.findByRole("button", { name: "本实例运行手册" })); return await screen.findByRole("textbox", { name:"本地运行手册正文" }); };
  return { auth, requests, fetcher, renderManual, open, local: () => local, market };
}

test("explicit arbitrary IDs work: read, edit, save, read back; market source has no edit control", async () => {
  const f = fixture(); const editor = await f.open();
  expect(editor).toHaveValue(f.local());
  expect(screen.getByLabelText("市场底线（只读）")).toHaveTextContent(f.market);
  expect(screen.getAllByRole("textbox")).toHaveLength(1);
  fireEvent.change(editor,{target:{value:"新的运行手册\n保留换行"}});
  fireEvent.click(screen.getByRole("button",{name:"保存本地手册"}));
  await screen.findByText("本地手册已保存并核对");
  expect(f.local()).toBe("新的运行手册\n保留换行");
  expect(f.requests.filter(r=>r.method==="PUT")).toEqual([{path:"/api/agents/old-resource/persona",method:"PUT",body:JSON.stringify({text:"新的运行手册\n保留换行"})}]);
  expect(f.requests.filter(r=>r.path==="/api/agents/old-resource/persona"&&r.method==="GET")).toHaveLength(2);
  expect(screen.getByRole("button",{name:"保存本地手册"})).toBeDisabled();
});

test.each([undefined, {schema:1,userId:"3",profiles:[]}])("unregistered duplicate slugs never invent a manual entry (%j)", async value => {
  const f=fixture({projection:value}); f.renderManual("personal-butler");
  await waitFor(()=>expect(screen.queryByTestId("identity-manual-loading")).not.toBeInTheDocument());
  expect(screen.queryByRole("button",{name:"本实例运行手册"})).not.toBeInTheDocument();
  expect(f.requests.filter(r=>r.path.endsWith("/persona"))).toHaveLength(0);
});

test("registered legacy resource is not presented as a second execution identity", async () => {
  const f=fixture(); f.renderManual("old-resource");
  await waitFor(()=>expect(screen.queryByTestId("identity-manual-loading")).not.toBeInTheDocument());
  expect(screen.queryByRole("button",{name:"本实例运行手册"})).not.toBeInTheDocument();
  expect(f.requests.filter(r=>r.path.endsWith("/persona"))).toHaveLength(0);
});

test("unavailable execution still permits the explicitly registered local resource edit",async()=>{
  const f=fixture({readiness:"unavailable",failMarket:true}); const editor=await f.open();
  expect(screen.getByText(/智能体当前不可执行/)).toBeInTheDocument();
  expect(screen.getByText("市场暂不可读")).toBeInTheDocument();
  fireEvent.change(editor,{target:{value:"停用期间更新本地手册"}}); fireEvent.click(screen.getByRole("button",{name:"保存本地手册"}));
  await screen.findByText("本地手册已保存并核对"); expect(f.local()).toBe("停用期间更新本地手册");
});

test.each([409,500,401])("save failure %i never changes resource or reports success",async status=>{
  const f=fixture({failSave:status}); const editor=await f.open();
  fireEvent.change(editor,{target:{value:"不能保存"}}); fireEvent.click(screen.getByRole("button",{name:"保存本地手册"}));
  await waitFor(()=>expect(f.requests.some(r=>r.method==="PUT")).toBe(true));
  if(status===401) await waitFor(()=>expect(f.auth.snapshot().epoch).toBe(1));
  else await screen.findByText("本地手册保存被拒绝");
  expect(f.local()).toBe("本地原始手册\n原文"); expect(screen.queryByText("本地手册已保存并核对")).not.toBeInTheDocument();
});

test("failed initial read cannot present a blank overwrite form",async()=>{
  const f=fixture({failRead:true}); f.renderManual(); fireEvent.click(await screen.findByRole("button",{name:"本实例运行手册"}));
  await screen.findByText("本地手册读取失败"); expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  expect(screen.queryByRole("button",{name:"保存本地手册"})).not.toBeInTheDocument(); expect(f.requests.some(r=>r.method==="PUT")).toBe(false);
});

test.each([{mismatch:true},{rejectAck:true}])("success requires acknowledgement and matching readback %j",async options=>{
  const f=fixture(options); const editor=await f.open(); fireEvent.change(editor,{target:{value:"提交文本"}}); fireEvent.click(screen.getByRole("button",{name:"保存本地手册"}));
  await screen.findByText("保存未能确认，请重新读取本地手册后再试"); expect(screen.queryByText("本地手册已保存并核对")).not.toBeInTheDocument();
});

test("auth identity change cannot write an already loaded draft into the new account",async()=>{
  const f=fixture(); const editor=await f.open(); fireEvent.change(editor,{target:{value:"旧账号草稿"}});
  act(()=>{const epoch=f.auth.beginIdentity();f.auth.commitToken(epoch,"new-account-token");});
  fireEvent.click(screen.getByRole("button",{name:"保存本地手册"}));
  expect(f.requests.some(r=>r.method==="PUT")).toBe(false); expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
});

test("auth changes during a save cannot produce a success notification or read under the new identity",async()=>{
  const f=fixture(); const editor=await f.open(); let resolveSave!:(response:Response)=>void;
  const original=f.fetcher.getMockImplementation()!;
  f.fetcher.mockImplementation((input,init)=>init?.method==="PUT"?new Promise(resolve=>{resolveSave=resolve;}):original(input,init));
  fireEvent.change(editor,{target:{value:"旧账号草稿"}}); fireEvent.click(screen.getByRole("button",{name:"保存本地手册"}));
  await act(async()=>{const epoch=f.auth.beginIdentity();f.auth.commitToken(epoch,"new-account-token");resolveSave(json({ok:true}));});
  expect(screen.queryByText("本地手册已保存并核对")).not.toBeInTheDocument();
  expect(f.requests.filter(r=>r.path==="/api/agents/old-resource/persona")).toHaveLength(1);
});


test("invalid registration data fails closed rather than exposing any persona write", async () => {
  const f=fixture({projection:{...projection,profiles:[{profile:{...profile,legacyAgentId:"../unsafe"},readiness:"ready"}]}});
  f.renderManual(); await screen.findByText("无法读取本实例手册的注册信息");
  expect(screen.queryByRole("button",{name:"本实例运行手册"})).not.toBeInTheDocument(); expect(f.requests.filter(r=>r.path.endsWith("/persona"))).toHaveLength(0);
});
