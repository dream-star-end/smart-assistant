# @openclaude/channel-feishu — **stub,当前未接线**

33 行占位实现。截至 2026-07-26:

- 全仓**零 importer**(`packages/commercial`、`gateway`、`cli` 都不引用);
- 不在任何 `tsconfig` 的 `references` 里;
- 零测试 —— 这是**正确的**,不要为它补覆盖率。

留在 workspaces 里只是为了保留占位与依赖声明。要么接线要么退役,下一轮定夺;
在那之前请不要按"活跃包"对待(不必进 CI、不必补测试、不必跟随重构)。

现役 channel 是 `packages/channels/wechat`(企微 iLink),它由 `npm run test:channels`
在 CI 里守着。
