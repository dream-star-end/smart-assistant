# v5 教程与产品同步契约

教程不是一套独立手册，而是产品能力注册表的一个投影。以下规则由 CI 强制执行。

## 单一权威

- `src/lib/productCapabilities.ts`：一等用户能力、稳定 ID、标题、分类、真实目的地和权限要求。
- `src/lib/tutorialCatalog.ts`：与能力 ID 一一对应的正文、步骤、注意事项、媒体和关联教程。
- `data-product-feature={PRODUCT_CAPABILITIES.<key>.id}`：真实可操作入口或对应功能内容。
- `data-product-entry-scope`：顶层入口区域。范围内新增的原生交互或 `Button` / `IconButton` /
  `Switch` 必须标注 `data-product-feature`；纯关闭、退出等非能力控件标 `data-product-control`。
- `tutorial-sync.json`：经人工确认后的语义快照；`tutorial-sync-history.jsonl`：带序号与前向哈希链的
  追加式接受审计；`tutorial-sync-history-head.json`：当前历史的条数与字节/头记录锚点。CI 会同时
  校验内部哈希链、历史锚点、最后一项对应当前快照，以及当前文件必须以 PR/推送前的 Git 基线历史
  为完整字节前缀；删除、截断、改写或错序都会失败。

稳定 ID 会进入分享 URL 和 localStorage。发布后只改标题，不改 ID；能力下线时必须同时删除
注册表、教程、入口标记与关联引用，并在接受快照时逐项显式确认：

```bash
npm run tutorials:accept -- --retire <稳定-id> --note "说明下线原因与替代入口"
```

多个能力下线时重复传入 `--retire <稳定-id>`。普通 `accept` 不能静默删除能力，`--source-only`
也不能接受能力新增、下线，或标题、分类、别名、CTA、权限等注册表语义变化。

## 日常修改流程

1. 改功能入口/功能内容时，使用既有能力 ID；新增一等能力先登记 `PRODUCT_CAPABILITIES`。
2. 同步更新对应教程正文或媒体，并提高 `contentVersion` 或媒体 `version`。
3. 运行测试和只读门禁：

   ```bash
   npm run check:tutorials
   npm run test:web-react
   ```

4. 人工在真实界面核对后接受新快照（CI 永不自动改写）：

   ```bash
   npm run tutorials:accept -- --note "说明功能变化与教程如何对应"
   ```

5. 若只是重命名局部变量或等价重构、用户行为完全未变，可显式接受源变化：

   ```bash
   npm run tutorials:accept -- --source-only --note "说明为何用户行为与教程均未变化"
   ```

   该模式仍会写入 JSONL 审计记录，不应被用来绕过真实教程更新。

## 媒体更新

`npm run tutorials:media` 从 `tutorial-capture.html` 的确定性舞台生成 9 组本地媒体。舞台复用
生产 Sidebar、ChatHeader、Composer、AgentPicker、RepoPill、Tabs 等组件，不读取生产账号或网络数据，
也不进入线上构建入口。生成后：

1. 人工播放并核对相关截图/视频；
2. 提高 `TUTORIAL_MEDIA.<key>.version`；
3. 运行 `npm run check:tutorials`；
4. 用普通 `tutorials:accept` 接受。

门禁会核验本地路径、WebP/WebM 文件头、VP8、`960×540`、`2–12 s` 时长、单组和总大小预算、
能力注册表（标题、分类、别名、CTA、权限）、正文、真实入口与媒体哈希及版本同步。线上教程视频
不自动播放，失败时回退到同一组 WebP 海报，并尊重浏览器的减少动态效果设置。

## CI

- `check:v5` 首步运行 `check:tutorials`。
- GitHub Actions 既有必需检查 `web-react` 同样先运行该只读门禁，再跑 Vitest。
- 门禁发现新入口未登记、注册表/教程/目标集合不一致、语义快照漂移或媒体不合规时直接失败。
