---
name: ths
description: 同花顺行情插件：用户问 A 股行情、股价、涨跌、K 线、分时、技术指标（MA/MACD/RSI/KDJ/BOLL）、选股、板块、指数、涨幅榜/排行、龙虎榜、个股资讯、公司大事、F10/财务、自选股，或要登录同花顺同步云自选时使用。命令 `ths`（只读行情，无交易）。
---

# 同花顺行情（插件 · ths）

命令 `ths` 已在 PATH 上（纯 Python 标准库，零依赖）。数据来自同花顺公开 Web 接口，**只读、无交易功能**。
对用户统称「同花顺插件」；设置入口是「管理中心 → 插件 → 同花顺行情」。

## 先选命令

| 用户想要 | 命令 |
|---|---|
| 某只 / 几只股票现价、涨跌、盘口 | `ths quote 600519 000001` |
| K 线（日 / 周 / 月 / 分钟，前复权） | `ths kline 600519 --period day --count 60`（period: day week month 60m 30m 15m 5m） |
| 今天的分时走势 | `ths intraday 600519` |
| 技术指标 MA / MACD / RSI / KDJ / BOLL | `ths indicators 600519 --count 30`（插件本地计算；**用它，不要自己拿 K 线手算**） |
| 指数、板块的走势 | 上面三条的目标也可以是指数 `1A0001`、板块代码 `881121` 或板块名 `半导体`；`ths quote 1A0001` 查指数 |
| 只知道名字 | `ths search 茅台` |
| 按条件选股 | `ths screen "市盈率低于 10 的银行股" --limit 20` |
| 涨幅 / 跌幅 / 成交额 / 换手排行 | `ths rank --by change --limit 20`（by: change fall amount turnover volume fund fundout） |
| 板块 | `ths sector quote 半导体`、`ths sector stocks 半导体 --limit 30`、`ths sector list --type industry` |
| 龙虎榜名单 | `ths lhb --limit 30` |
| 资讯 | `ths news --source cjzx --limit 10`（cjzx hk hgt whfx global） |
| 公司资料、财务诊断 | `ths f10 600519`；深度（三表核心指标近 4 期含同比 + 十大股东）加 `--deep`，全量科目再加 `--all` |
| 公司大事（披露时间、股东大会、业绩、回购、分红、解禁） | `ths events 600519 --limit 10` |
| 拿不准接口是否正常 | `ths doctor`（各通道健康检查）；`ths commands` 列出全部命令 |
| 自选股 | `ths watchlist list`、`ths watchlist add 600519`、`ths watchlist remove 600519` |
| 云自选（需登录） | `ths watchlist sync`（云 → 本地）、`ths watchlist push`（本地 → 云，**先问用户**） |

代码可写 `600519`、`sh600519`、`600519.SH`；北交所 `920xxx` 也能按代码查（但 `search` 可能搜不到北交所股票）。
默认输出 JSON；出错时 stderr 是 `{"error": …, "code": …}`、退出码非 0。`code` 是 `INVALID_CODE`（代码不对）、`NOT_FOUND`、
`NETWORK` / `UPSTREAM` / `RATE_LIMIT`（接口临时不可用：等几秒重试一次，仍失败就跑 `ths doctor` 并如实告诉用户）。
结果有短期缓存（行情 20 秒、K 线 2–30 分钟、财报 6 小时）；用户明确要最新数据又怀疑缓存时，命令前加 `THS_NO_CACHE=1`。
自己读 JSON 想省 token 时可加 `--compact`（单行）或 `--fields code,price,change_pct`（只留这些字段）；这两个只影响 JSON，加了 `--ui` 就不要再加。

## 给用户看结果：用 `--ui`，原样贴

在网页对话里（系统提示里有 Intelligent UI 协议时），展示行情 **一律加 `--ui`**：`ths quote 600519 --ui`。
输出就是一个或几个 ```ui 代码块（行情卡、K 线、分时、股票列表、表格等），里面的数据与 JSON 输出同源。

- **把这些代码块原样放进回答**，一个字符都不要改：不改数字、不删行、不重新排版、不自己拼 ui 块。
- 块里已经有全部数据，你的分析就基于它；分析写在块外面，简短说明结论即可，不要把数字再抄一遍成表格。
- 多个命令的块可以按顺序放在一起（例如先行情卡，再分时，再 K 线）。
- `indicators --ui` 是一组指标卡加四张折线图（均线、布林带、MACD、RSI 与 KDJ）；用户只问某一个指标时，可以只贴指标卡和相关的那张图，但贴出来的块仍然一字不改。
- `events --ui` 是时间线，`doctor --ui` 是检查结果表。
- 没有 Intelligent UI 协议时（如微信、定时任务），不要贴 ui 块：用不带 `--ui` 的 JSON 自己写简洁的 Markdown 表格。

## 先看状态再下结论

- 输出里的 `status` / `update_time`：非交易时段是最近收盘数据，要说明「收盘价」而不是「现价」。
- K 线和指标都是**前复权**价格，与当时的实际成交价可能不同，引用历史价格时说明「前复权」。
- 科创板盘后固定价格交易时（`update_time` 15:30），行情价可能与日 K 收盘价不同，这不是数据错误。
- 只有买一 / 卖一一档盘口；五档、逐笔、Level-2 都没有，**不要假装有**。
- `rank` / `sector stocks` / `screen` 是问财 NLP 解析加行情重排的**近似榜单**，引用时说明来源；`rank --by fund|fundout` 只有名次、**没有资金金额**。
- `lhb` 只有名单，上榜原因、营业部、买卖金额都拿不到，不要编造。
- 拿不到的数据就直说拿不到；绝不补数、估算后当成真实数据。不预测股价，不给买卖建议。

## 登录同花顺（只有云自选需要）

行情、K 线、选股都**不需要登录**。用户要同步云自选时：

1. 向用户要手机号，执行 `ths login send-code --phone <手机号> --ui`，把输出的步骤卡贴给用户。
2. 输出 `captcha_required` 时，滑块验证由你完成，不要让用户操作：用 Read 查看 `bg_image`（340×195），
   找拼图缺口主体的左边缘，`x ≈ 左缘 − 4`，`y` 不用传；然后
   `ths login send-code --phone <手机号> --captcha-x <x> --ui`。没通过会提示流程已重置，换张新图重来（最多试 3 次，仍不行就请用户稍后再试）。
3. 返回 `code_sent` 后，把输出的提醒贴给用户：**验证码 3–5 分钟内有效，收到马上发来**。
4. 用户发来验证码立即执行 `ths login verify --code <验证码> --ui`；`ths login status --ui` 看状态，`ths login logout` 退出。

手机号只用于这次登录，不要复述完整号码；登录信息只保存在用户自己的容器里（`~/.ths_auth.json`，0600），**绝不输出其中的 password**。

## 插件被停用时

`ths` 输出 `插件「同花顺行情」已停用…` 并退出码 3：告诉用户可在「管理中心 → 插件」打开「同花顺行情」，不要绕过（不要直接运行脚本文件）。

## 声明

数据来自同花顺未公开的 Web 接口，仅供个人学习研究，可能随时变更或失效；不提供交易，不构成投资建议。
上游：https://github.com/dream-star-end/ths-plugin（MIT，见 references/LICENSE.md、references/UPSTREAM.md）。
