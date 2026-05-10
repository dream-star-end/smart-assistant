# V3 commercial 代码评审 checklist

针对 `packages/commercial/`(尤其是 `ws/userChatBridge.ts`、`ws/sessionRepoBindBridge.ts` 等高频热路径)的强制评审项。新增/修改这些文件时,Codex review 必须显式回答下列问题。

复盘触发版本:**v1.0.119**(2026-05-09 wedge 真根因 = `tryAutoRebindFlush` finally 同步递归)。

---

## 1. finally / catch 块里的同步递归

任何 `finally` / `catch` 中再次调用本函数(或同一闭包中的其他函数,形成同步重入)的代码,**必须有"取得进展"门控**,否则可能在某种状态下变 V8 microtask 死循环。

**反 pattern**(v1.0.118 实际触发的 wedge):

```ts
const tryFlush = (): void => {
  if (mapSize === 0) return;
  if (inFlight) return;
  inFlight = true;
  ;(async () => {
    try {
      const matched = await doWork();
      // ... 用 matched 更新 map
    } finally {
      inFlight = false;
      if (mapSize > 0) tryFlush();   // ⚠️ 危险:doWork 可能 0 命中,size 不变,死循环
    }
  })();
};
```

**正 pattern**(v1.0.119 修复):

```ts
;(async () => {
  // progressMade 必须在 IIFE 内部声明 — 每次调用都是全新的本地变量,
  // 默认 false。throw / abort 路径都不会污染下次 flush 的判断。
  let progressMade = false;
  try {
    const matched = await doWork();
    if (matched.length > 0) progressMade = true;
    // ...
  } finally {
    inFlight = false;
    if (progressMade && mapSize > 0) tryFlush();
  }
})();
```

**反例**(变量提到 IIFE 外):若把 `let progressMade` 提到外层闭包级别,多个并发 flush 会共享/覆盖,门控失效。务必每次 IIFE 新建。

**等价兜底方案**:用 `setImmediate(tryFlush)` 而不是同步调,把控制还给 event loop;或用 generation counter — 进入时记 `gen0`,finally 里只在 `gen0 !== currentGen`(外部信号已到达)时再触发。

**必问问题**:
- 这个 finally 自调有 progress / generation / setImmediate 门控吗?
- 如果异步操作 0 命中(返回 [], throw, no-op),会不会立即重入?
- 微任务(`Promise.resolve()`、`async/await`)和 setImmediate 在 V8 调度上不一样:微任务会饿死 timers/IO,setImmediate 不会。同步递归本质就是微任务无限链。

---

## 2. "还有事可做" ≠ "应该立刻再做一次"

`map.size > 0` / `queue.length > 0` / `flag === true` 这种"状态判断"不能当成"该再触发一轮"的事件信号。

事件驱动架构里,**只有外部事件**(新 hello、新 fetch、新消息)才能改变内部状态——**没有外部事件,内部状态变化也是没有的**。所以 finally 里再判 size > 0 试图"兜底"是错的,因为本轮没消化 = 状态没变 = 再调还是 no-op。

正确做法:

- caller 触发(hello/fetch 等事件路径里调一次 `tryFlush()`),flush 自身不做 finally 兜底
- 如果一定要兜底,加 progress 门控 + delay(setImmediate / setTimeout)给 event loop 喘息空间

**必问问题**:
- finally 里的"再调一次"是为了消化什么?这个状态在没有新外部事件下能变吗?
- 如果不能变,这次再调就是无意义的(且有死循环风险);改为 caller 触发。

---

## 3. async IIFE finally 里的 closure 状态

`;(async () => { try {} finally {} })()` 模式里,`try` 块的 await 结果只在 `try` scope 可见。要让 finally 看到"是否取得进展",必须在 `try` 外声明变量(`let progressMade = false;` 在 IIFE 顶部),`try` 里赋值,`finally` 里读。

**必问问题**:
- finally 用到的状态变量声明在哪?有没有作用域陷阱?
- 异步抛错路径下这些变量的默认值是否安全?(progressMade 默认 false → finally 不再触发,正确)

---

## 4. 重入保护标志 + 同步重入的组合

`autoRebindFlushInFlight = true / false` 这种重入保护,如果 flush 内部最后一行又同步调自己:

- 进入第二次时,`autoRebindFlushInFlight` 已被 finally 重置为 `false`
- 第二次能进 → 又 await → 又 finally → 又重置 → 又调...
- 重入保护**完全失效**

**必问问题**:
- 重入保护 flag 是否能防住同步递归?(基本上防不住,只能防"同 tick 多个外部 caller")
- 真要防同步递归,要么不递归(改 caller 触发),要么 setImmediate 让 flag 释放和下一次进入分开 tick。

---

## 5. wedge / spin 检测 SOP

任何对 hot path 的改动 PR 描述里必须回答:

- 这次改动是否引入了"无 await 网络/文件 IO 但仍在 await"的微任务循环?
- 如果引入,哪个边界条件会让它退化成 0 命中无限重入?
- 如果上线后出 wedge,如何用 `kill -USR1 $PID` + Node inspector + Profiler.start 抓到栈?(参考 memory `v3_wedge_runaway_microtask.md` 的 `/tmp/inspect-wedge.js` workflow)

---

## 6. Codex review 时的提示词

提交 commercial/ws 改动给 Codex 时,prompt 里加一段:

> 本仓 finally / catch 中存在同步递归 / 自调用模式时,确认是否有 progress/generation/setImmediate 门控防 V8 microtask 死循环(参考 docs/v3/code-review-checklist.md §1)。
> 状态判断(map.size、queue.length)不能当事件触发器,确认 finally 里的"再触发"是否真的需要 — 如不必要,改为 caller 触发更稳。
