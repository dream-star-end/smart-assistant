// controlListener 单元测试(RFC-v5-dual-master-cohort D3)——不依赖 PG。
//
// 用真实 loopback 高位端口 + 打桩 desiredWatch(可控 fake:current/onChange/set)驱动:
//   ① desired==self → start() 后 VIP + 私有口都 bound(http.get 双端口返回 'ok')
//   ② desired 翻走 → VIP 优雅 close(端口 ECONNREFUSED),私有口仍 bound
//   ③ desired 翻回 → VIP 重 bind
//   ④ EADDRINUSE:占住 VIP 口 → start() 不抛(私有口起来)、vipBound 暂 false;释放占位 → 重试周期后 vipBound=true
//   ⑤ 私有口 fail-loud:占住私有口 → start() reject
//
// 节点纪律:所有 server close、所有 http.get 消费/destroy、所有 timer unref,避免 pending handle。
//
// Run: npx tsx --test packages/commercial/src/__tests__/controlListener.test.ts

import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { createControlListener, privatePortForSlot, DEFAULT_VIP } from "../deploy/controlListener.js";
import type { ControlListener } from "../deploy/controlListener.js";
import type { DesiredSnapshot, DesiredWatch, Slot } from "../deploy/deployState.js";

// ── 可控 fake desiredWatch ─────────────────────────────────────────────────────
type FakeWatch = DesiredWatch & { set(next: DesiredSnapshot): void };

function snapshot(desiredControlSlot: Slot): DesiredSnapshot {
  return {
    desiredLeaderSlot: "A",
    desiredControlSlot,
    activeSlot: "A",
    phase: "stable",
    generation: 1,
  };
}

function makeFakeWatch(initial: Slot): FakeWatch {
  let snap = snapshot(initial);
  const subs = new Set<(s: DesiredSnapshot) => void>();
  return {
    current: () => snap,
    waitReady: async () => snap,
    refreshNow: async () => snap,
    onChange: (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    stop: () => {},
    set: (next) => {
      snap = next;
      for (const cb of [...subs]) cb(snap);
    },
  };
}

const okHandler = (_req: http.IncomingMessage, res: http.ServerResponse): void => {
  res.statusCode = 200;
  res.end("ok");
};

// ── 工具 ──────────────────────────────────────────────────────────────────────
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof (t as { unref?: () => void }).unref === "function") (t as { unref: () => void }).unref();
  });
}

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 2000, stepMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await cond()) return;
    if (Date.now() > deadline) throw new Error("waitFor 超时");
    await sleep(stepMs);
  }
}

/** http.get 一次,消费 body;成功 resolve {statusCode, body},失败 reject(带 code)。 */
function httpGet(port: number, host = "127.0.0.1"): Promise<{ statusCode?: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host, port, timeout: 1000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => {
        body += c;
      });
      res.on("end", () => resolve({ statusCode: res.statusCode, body }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("http.get timeout")));
  });
}

/** 轮询直到端口连接被拒(ECONNREFUSED);期间连上则消费响应继续等。 */
async function waitForConnRefused(port: number, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await httpGet(port);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ECONNREFUSED") return;
    }
    if (Date.now() > deadline) throw new Error(`端口 ${port} 仍在接受连接(超时 ${timeoutMs}ms)`);
    await sleep(20);
  }
}

function occupyPort(port: number, host = "127.0.0.1"): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(port, host, () => resolve(s));
  });
}

function closeServer(s: net.Server | http.Server): Promise<void> {
  return new Promise((resolve) => {
    try {
      s.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

async function freePortPair(): Promise<[number, number]> {
  const reservations = await Promise.all([occupyPort(0), occupyPort(0)]);
  const ports = reservations.map((server) => (server.address() as net.AddressInfo).port);
  await Promise.all(reservations.map(closeServer));
  return [ports[0]!, ports[1]!];
}

// ── 资源登记(afterEach 兜底关闭)────────────────────────────────────────────────
let listener: ControlListener | null = null;
const openServers = new Set<net.Server | http.Server>();

afterEach(async () => {
  if (listener) {
    try {
      await listener.close();
    } catch {
      /* ignore */
    }
    listener = null;
  }
  for (const s of [...openServers]) {
    await closeServer(s);
    openServers.delete(s);
  }
});

describe("controlListener 常量导出", () => {
  it("privatePortForSlot 静态映射 + DEFAULT_VIP", () => {
    assert.equal(privatePortForSlot("A"), 18896);
    assert.equal(privatePortForSlot("B"), 18897);
    assert.equal(DEFAULT_VIP.host, "127.0.0.1");
    assert.equal(DEFAULT_VIP.port, 18894);
  });
});

describe("controlListener bind / VIP 生命周期", () => {
  it("① desired==self → start 后 VIP + 私有口都 bound 且返回 ok", async () => {
    const [vipPort, privatePort] = await freePortPair();
    const vip = { host: "127.0.0.1", port: vipPort };
    const priv = { host: "127.0.0.1", port: privatePort };
    const watch = makeFakeWatch("A");
    listener = createControlListener({ slot: "A", desiredWatch: watch, handler: okHandler, vip, privateAddr: priv });
    await listener.start();

    const st = listener.status();
    assert.equal(st.privateBound, true);
    assert.equal(st.vipBound, true);
    assert.equal(st.vipDesired, true);

    assert.equal((await httpGet(vip.port)).body, "ok");
    assert.equal((await httpGet(priv.port)).body, "ok");
  });

  it("② desired 翻走 → VIP 优雅 close,私有口仍 bound", async () => {
    const [vipPort, privatePort] = await freePortPair();
    const vip = { host: "127.0.0.1", port: vipPort };
    const priv = { host: "127.0.0.1", port: privatePort };
    const watch = makeFakeWatch("A");
    listener = createControlListener({ slot: "A", desiredWatch: watch, handler: okHandler, vip, privateAddr: priv });
    await listener.start();
    assert.equal(listener.status().vipBound, true);

    // 翻到 B → 触发 releaseVip。
    watch.set(snapshot("B"));
    await waitFor(() => listener!.status().vipBound === false);
    await waitForConnRefused(vip.port);

    assert.equal(listener.status().vipBound, false);
    assert.equal(listener.status().privateBound, true);
    assert.equal(listener.status().vipDesired, false);
    // 私有口不受影响。
    assert.equal((await httpGet(priv.port)).body, "ok");
  });

  it("③ desired 翻回 self → VIP 重 bind", async () => {
    const [vipPort, privatePort] = await freePortPair();
    const vip = { host: "127.0.0.1", port: vipPort };
    const priv = { host: "127.0.0.1", port: privatePort };
    const watch = makeFakeWatch("A");
    listener = createControlListener({ slot: "A", desiredWatch: watch, handler: okHandler, vip, privateAddr: priv });
    await listener.start();
    assert.equal(listener.status().vipBound, true);

    watch.set(snapshot("B"));
    await waitFor(() => listener!.status().vipBound === false);
    await waitForConnRefused(vip.port);

    watch.set(snapshot("A"));
    await waitFor(() => listener!.status().vipBound === true);
    assert.equal((await httpGet(vip.port)).body, "ok");
  });

  it("④ EADDRINUSE:占住 VIP 口 → start 不抛、vipBound 暂 false;释放后重试周期内 bound", async () => {
    const [vipPort, privatePort] = await freePortPair();
    const vip = { host: "127.0.0.1", port: vipPort };
    const priv = { host: "127.0.0.1", port: privatePort };
    const blocker = await occupyPort(vip.port);
    openServers.add(blocker);

    const watch = makeFakeWatch("A");
    listener = createControlListener({
      slot: "A",
      desiredWatch: watch,
      handler: okHandler,
      vip,
      privateAddr: priv,
      eaddrInUseRetryMs: 100,
    });
    // VIP 被占 → start 不抛(私有口起来),vipBound 暂 false。
    await listener.start();
    assert.equal(listener.status().privateBound, true);
    assert.equal(listener.status().vipBound, false);
    assert.equal(listener.status().vipDesired, true);

    // 释放占位 → 交接窗重试周期后 VIP 拿下。
    await closeServer(blocker);
    openServers.delete(blocker);
    await waitFor(() => listener!.status().vipBound === true, 3000);
    assert.equal((await httpGet(vip.port)).body, "ok");
  });

  it("⑥ bind pending(EADDRINUSE 重试中)时 desired 翻走 → releaseVip 取消在途 bind,释放端口后不 bind(BLOCKER 3)", async () => {
    const [vipPort, privatePort] = await freePortPair();
    const vip = { host: "127.0.0.1", port: vipPort };
    const priv = { host: "127.0.0.1", port: privatePort };
    // 占住 VIP 口 → start() 走 EADDRINUSE 重试路径(bind pending)。
    const blocker = await occupyPort(vip.port);
    openServers.add(blocker);

    const watch = makeFakeWatch("A");
    listener = createControlListener({
      slot: "A",
      desiredWatch: watch,
      handler: okHandler,
      vip,
      privateAddr: priv,
      eaddrInUseRetryMs: 80,
    });
    await listener.start();
    assert.equal(listener.status().vipBound, false); // EADDRINUSE,重试中

    // desired 翻走(A→B):releaseVip 应 ++epoch 取消在途 bind 重试链。
    watch.set(snapshot("B"));
    await waitFor(() => listener!.status().vipDesired === false);

    // 释放占位端口:即使 VIP 口现在空了,因 desired 已=B(且 epoch 已变),绝不 bind。
    await closeServer(blocker);
    openServers.delete(blocker);
    await sleep(300); // 跨过数个重试周期
    assert.equal(listener.status().vipBound, false, "desired 翻走后即使端口空出也不得 bind");
    // 端口应仍可被他人占用(证明 controlListener 没抢它)。
    const reoccupy = await occupyPort(vip.port);
    openServers.add(reoccupy);
    assert.ok(reoccupy.listening, "VIP 口应仍空闲(controlListener 未误 bind)");
  });

  it("⑤ 私有口 fail-loud:占住私有口 → start reject", async () => {
    const [vipPort, privatePort] = await freePortPair();
    const vip = { host: "127.0.0.1", port: vipPort };
    const priv = { host: "127.0.0.1", port: privatePort };
    const blocker = await occupyPort(priv.port);
    openServers.add(blocker);

    const watch = makeFakeWatch("A");
    listener = createControlListener({ slot: "A", desiredWatch: watch, handler: okHandler, vip, privateAddr: priv });
    await assert.rejects(() => listener!.start(), /私有口 bind/);
    // start 失败后无残留 server,close 应安全。
    assert.equal(listener.status().privateBound, false);
    assert.equal(listener.status().vipBound, false);
  });
});
