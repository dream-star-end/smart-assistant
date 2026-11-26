---
name: scientific-deep-audit
description: 零硬伤科研深审（物理硬伤、数学推导、公式代码等价性、四层正交深审、反例仲裁与零回归封版）：在论文、技术报告与数值仿真代码交付前，运行机器确定性净室底座（SymPy/Octave/pint/hypothesis/SSOT/调用链影响面扫描）+ 正交物理域切片蜂群 + 真跨家族盲审红队 + `oc-review verify` 反例法庭与 Chao1 残余风险停机闸门，根治"修1破2"与纯多模型投票集体误判。用户要求"科研深审/查物理硬伤/公式代码对齐/零回归封版/scientific-deep-audit"时使用。
tags: [research, scientific-audit, physics, verification, multi-model, swarm]
---

# scientific-deep-audit 零硬伤科研深审

面对长篇物理/数学报告与多文件仿真代码，单靠人工或同家族大模型"多看几遍"无法压低残余硬伤率。本技能通过**机器确定性底座 + 正交切片 + 真跨家族红队 + 反例仲裁法庭**四层防线，将隐蔽物理错误与增量补丁回归压至可量化停机线。

## 核心原则（反直觉铁律）

1. **同家族大蜂群误差强相关，纯投票会集体改错论文**：
   同一模型家族共享先验盲区，有效独立审查数 $N_{\text{eff}} = \frac{k}{1+(k-1)\rho} < 2$（$\rho \approx 0.6\text{--}0.9$）。即便是不同模型，读纯文本时仍存在共模误判风险；**禁止靠多模型多数票直接改写公式或物理结论**，数学/物理争端必须由符号计算或矩阵数值实证一锤定音。
2. **约 50% 新 P0 来自增量补丁次生回归，必须前移到修改期拦死**：
   只改某处系数或新增门控参数（如 `opt` / `el_sd`），最易引发"半拉子修复"（生产调用链未传参静默退回旧模型、解析雅可比/逆过程漏同步、正文与代码常数漂移、与旋转链产生双重扣除）。每次修改必须同步跑 **SSOT 单源真值对账** 与 **补丁影响面全量调用链扫描**。
3. **零反例不立项（Witness-Only Arbitration）**：
   任何物理、数学、数值或代码一致性 `P0/P1` 问题，必须附带可执行的 `repro_script`（`.py` 或 `.m`）。见证脚本必须**正常 `exit 0`** 并通过 `OC_WITNESS_VERDICT_FILE` 或 stdout 哨兵行 `OC_WITNESS_VERDICT: {"status":"confirmed"|"refuted","summary":"..."}`（可直接调用 `cleanroom_verify_template.emit_witness_verdict`）显式给出裁决；**严禁凭退出码 1 判证伪**——任何非零退出、崩溃、缺依赖或无裁决输出一律保留 `unverified`，绝不降级 P0，无机器证人不改论文。

---

## 五步深审工作流

### Step 0：基线冻结与静态预检
1. **SHA-256 基线冻结**：对待审稿件与核心代码文件计算 `sha256sum` 并留痕，防止审改并行期间版本漂移。
2. **保真公式提取（严禁裸抽纯文本丢公式）**：
   - 大型 `.docx` 先用 `oc-docx extract <file.docx> --toc` 建目录索引，再按 `--section` 分片并用 `oc-docx extract <file.docx> --latex` 无损还原 OMML 公式为 LaTeX 与表格结构。
3. **静态门禁清零**：
   - `oc-docx check <file.docx> --expect-formulas`（清零占位符、断号引用、OMML 异常）；
   - `oc-cite verify`（核验 DOI 与题录接地，阻断张冠李戴）；
   - `oc-stylecheck <file.docx>`（学术语体体检）。

### Step 1：第一层——机器确定性底座（Cleanroom Engine）
优先调用或基于自带模板 `scripts/cleanroom_verify_template.py`（`--mode` 或导入函数）构建项目净室验证脚本（`.m` 代码同时可用 `octave --no-gui --quiet` 实跑对比）：
1. **符号推导与 $SO(3)$ 不变量检查**（`check_so3_invariants`）：用 SymPy/NumPy 校验旋转矩阵正交性 $R^T R = I$ 与手性 $\det(R) = +1$，阻断多级旋转链双重扣除或左手系反射错误。
2. **解析雅可比 vs 中心/复步差分**（`check_jacobian_parity`）：逐行核验解析雅可比与数值中心差分（公差 $< 10^{-8}$），捕获漏改偏导数分支。
3. **量纲与误差传播核验**（`check_dimensions`）：利用 `pint` 检查方程左右量纲一致性（缺包时自动 `SKIP` 不崩溃），可配合 `uncertainties` 核验协方差/标准差传播。
4. **非零非对称大参数差分 Fuzzing**（`check_nonzero_roundtrip`）：结合 `hypothesis` / 随机非零大参数（拒绝 `0` 或 `[1,1,1]` 退化输入）检验正反演闭环 $f^{-1}(f(x)) \approx x$，确保不会在缺省参数下静默退回旧模型。
5. **SSOT 表格/JSON 数值对账**（`check_ssot_numbers`）：将 Markdown/正文报告数值与 `metrics.json` 或 CSV 单源真值自动对账，捕获常数漂移（如 `0.8881` vs `0.6745`）与 **RMS / 方差混淆**。
6. **补丁影响面调用链与门控穿透扫描**（`check_callsite_impact`）：给定被修改函数或门控字段（如 `opt`、`el_sd`），扫描全仓生产调用点，高亮漏传新参数的调用位置。

### Step 2：第二层——正交物理域切片蜂群
按物理边界与代码模块划分为**零交集**切片并行只读审查（可调用内置剧本 `/swarm-playbook scientific-deep-audit`）：
- **切片 A（物理假设与旋转/量纲链）**：坐标系定义、守恒律、边界条件、多级变换是否双重扣除；
- **切片 B（数学推导与数值稳定性）**：矩阵恒等式、雅可比、奇异点、正反演可逆性；
- **切片 C（公式↔代码↔表格一致性）**：符号定义、数值常数、统计口径（RMS/RMSE/方差/置信度）全链路对齐；
- **切片 D（补丁影响面与次生回归）**：全量生产调用链、可选开关默认值与降级路径。
- **硬约束**：每条 `P0/P1` finding 必须附 `repro_script`（`.py` 或 `.m` 相对路径，位于评审目录 `scriptRoot` 内）。脚本必须正常 `exit 0` 并通过 `OC_WITNESS_VERDICT_FILE` / stdout `OC_WITNESS_VERDICT: {"status":"confirmed"|"refuted","summary":"...","finding_digest":"<OC_WITNESS_FINDING_DIGEST>"}` 明确裁决（可用 `cleanroom_verify_template.emit_witness_verdict`，自动附带 `finding_digest`）；评审 JSON 中作者自填的 `verified_by_machine` 仅作展示，绝不影响仲裁闸门。

### Step 3：第三层——真跨家族强档盲审红队
1. 使用 `delegate_tasks`（同一批不超过 4 路）并行委派 **四大家族强档模型**进行只读盲审，输出落盘至 `/home/agent/.openclaude/generated/review-<ts>/reviews-<family>.json`（遵循 `oc-review schema`，显式填写 `model_family` 与 `repro_script`）：
   - 推荐异构强档组合：`gpt-6.2-astra`（OpenAI/GPT） + `antigravity-gemini-4-neon`（Google/Gemini） + `grok-build`（xAI/Grok） + `deepseek-v4-flash`（DeepSeek）；同家族强档替补：`gpt-6.2-sol`（GPT）、`antigravity-gemini-4-carbon`（Gemini）。
2. **上游 500/429 自动替补表**（全部限定于四大家族强档池，遇故障立即切换备选，禁止原地反复重试烧光轮次配额，亦不得降级到弱档/非四大家族模型）：

| 主选模型 | 故障类型 | 第一替补（同家族强档优先） | 第二替补（跨家族强档互替） |
| :--- | :--- | :--- | :--- |
| `gpt-6.2-astra` | 429 / 超时 / 不可用 | `gpt-6.2-sol` | `antigravity-gemini-4-neon` / `grok-build` / `deepseek-v4-flash` |
| `antigravity-gemini-4-neon` | 500 / 429 / 上游熔断 | `antigravity-gemini-4-carbon` | `gpt-6.2-astra` / `grok-build` / `deepseek-v4-flash` |
| `grok-build` | 429 / 超时 | — | `gpt-6.2-sol` / `antigravity-gemini-4-carbon` / `deepseek-v4-flash` |
| `deepseek-v4-flash` | 429 / 超时 | — | `gpt-6.2-astra` / `antigravity-gemini-4-neon` / `grok-build` |

### Step 4：第四层——机器反例法庭与 Chao1 停机闸门
1. **运行机器反例法庭（`oc-review verify` 安全边界与诚实隔离契约）**：
   - **默认安全采集（推荐用于外部/未逐行审计的评审脚本）**：校验 `repro_script` 路径在 `scriptRoot` 内，计算冻结稿件版本 `--manuscript` + `findingDigest` + `scriptSha256`，全部标为 `unverified`（`exec_disabled_by_default`），**绝不执行不受信任脚本**；传 `--exec` 在无内核强制只读/断网沙箱的容器环境中亦会 fail-closed 自动退回只采集（`sandbox_unavailable_collect_only`），绝不把普通进程执行伪装成 OS 隔离：
   ```bash
   # 对外部评审员提交的未审计脚本：一律先只采集并冻结稿件版本哈希
   oc-review verify \
     --dir /home/agent/.openclaude/generated/review-<ts> \
     --script-root /home/agent/.openclaude/generated/review-<ts> \
     --manuscript /path/to/manuscript.docx
   ```
   - **经人工/净室逐行审计的本地见证执行（`--unsafe-local-exec`）**：仅当协调者已逐行审计脚本确认无越界写稿/外联操作，或脚本由协调者本人基于 `cleanroom_verify_template.py` 独立重写后，方可显式传入 `--unsafe-local-exec` 在当前用户容器内运行（提供临时 cwd、脱敏环境、有界流读取与全路径进程组 SIGKILL 回收，**不提供内核级文件系统只读或断网沙箱**）：
   ```bash
   # 仅限协调者自写净室脚本或已逐行审计脚本（无 OS 沙箱隔离）
   oc-review verify --unsafe-local-exec \
     --dir /home/agent/.openclaude/generated/review-<ts> \
     --script-root /home/agent/.openclaude/generated/review-<ts> \
     --manuscript /path/to/manuscript.docx
   ```
   产出 `verification-report.json`（含 `executionMode`、`inputDigest`、`findingDigest` 与 `scriptSha256`）：
   - **严禁凭退出码 1 判证伪**：脚本必须 `exit 0` 且输出携带匹配 `finding_digest`（来自 `OC_WITNESS_FINDING_DIGEST`）的 `OC_WITNESS_VERDICT: {"status":"confirmed"|"refuted","summary":"...","finding_digest":"..."}`（或写入 `OC_WITNESS_VERDICT_FILE`）；
   - `status === "confirmed"` → 缺陷反例成立；`status === "refuted"` → 反例被数学恒等式/仿真证伪，自动阻断多模型共识误判；
   - **任何非零退出（崩溃/缺依赖/`exit 1`/超时/stdout 截断）或缺失/错配 `finding_digest`** → 一律保留 `unverified`，**绝不降级 P0**；
   - 评审 JSON 内自填的 `verified_by_machine` 仅作展示，**唯有同时匹配 `findingDigest`（含证据、优先级、`new_evidence` 与稿件版本）+ 可信 `--script-root` 实时 `scriptSha256` 的 `--verification` 报告才能影响闸门**。
2. **跨轮账本初始化与科学深审放行闸门**：
   - **首轮必须先初始化账本**（否则 `--ledger` 指向不存在文件会中断），或首轮 `collate` 先省略 `--ledger`、复核轮次再挂 `--ledger`：
   ```bash
   oc-review ledger init --file /home/agent/.openclaude/generated/review-<ts>/decision-ledger.json

   oc-review collate \
     --dir /home/agent/.openclaude/generated/review-<ts> \
     --script-root /home/agent/.openclaude/generated/review-<ts> \
     --manuscript /path/to/manuscript.docx \
     --verification /home/agent/.openclaude/generated/review-<ts>/verification-report.json \
     --ledger /home/agent/.openclaude/generated/review-<ts>/decision-ledger.json \
     --scientific-gate
   ```
3. **量化封版停机条件（四大家族强档硬门禁）**：
   `oc-review collate --scientific-gate` 硬门禁**仅认四大家族强档池**（`gpt-6.2-astra` / `gpt-6.2-sol`、`antigravity-gemini-4-neon` / `antigravity-gemini-4-carbon`、`grok-build`、`deepseek-v4-flash`）：弱档/轻量档模型（如 `gpt-6-luna`、`antigravity-gemini-4-hydrogen`、`antigravity-orchestrator-*`、`grok-build-fast`）与非四大家族模型（Claude / GLM / Qwen / Kimi / MiniMax 等）会被记入 `excludedReviewers`，**不计入 `familyCount` 与 Chao1 捕获矩阵**（但其报出的 P0 硬伤仍按 fail-closed 铁律触发 `FIX_REQUIRED` 绝不静默吞掉）。
   仅当同时满足 **`confirmedP0=0 && unverifiedP0=0 && familyCount>=2 && chao1Residual<0.5`** 时，`gate.status` 达到 **`PASS_READY`** 方可封版交付：
   - `FIX_REQUIRED`：存在已实证 `confirmedP0` 或待核验 `unverifiedP0`，必须修稿/补证人并同步重跑 Step 1 调用链影响面回归；
   - `INSUFFICIENT_COVERAGE`：活跃 P0 已清零但有效强档独立家族数 `< 2`，需按 Step 3 四大家族强档替补表补足异构盲审；
   - `RESIDUAL_RISK_HIGH`：跨家族 Capture-Recapture 估算残余 P0 期望 $\hat{f}_0 = \frac{f_1(f_1-1)}{2(f_2+1)} \ge 0.5$，需补充定向切片复审直至收敛。

---

## 诚实边界说明

- **不替代外场实测与物理实验标定**：净室符号验证、差分 Fuzzing 与多家族盲审仅验证**理论推导自洽、量纲一致、公式与代码等价及跨介质数值零漂移**，无法验证未写进模型的物理现实偏差。
- **未实测参数显式标界**：所有未经外场实测标定的先验噪声、经验系数、环境假设与线性化适用区间，必须在报告正文及交付摘要中显式标注假设边界，严禁将"数值闭环通过"表述为"外场物理精度已验证"。
