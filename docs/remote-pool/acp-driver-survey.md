# Remote Pool ACP & Multi-Engine Driver Survey (`OCV5-749` / `AC-9`)

> Scope: V5 selfhost remote execution pool (`remote-driver-v4`) architectural boundary, official Agent Client Protocol (ACP) evaluation, and 4-engine (`cc`, `codex`, `Grok`, `Antigravity`) capability matrix.
> Non-scope: Grok and Antigravity are **not** implemented as remote pool drivers in `OCV5-749`; unverified remote pool properties are explicitly marked **`未核实`**.

---

## 1. Official ACP Specification Assessment

Evaluated against the official Agent Client Protocol specifications:

- Protocol Overview: <https://agentclientprotocol.com/protocol/overview>
- Tool Calls (`v1`): <https://agentclientprotocol.com/protocol/v1/tool-calls>
- Session Setup (`v1`): <https://agentclientprotocol.com/protocol/v1/session-setup>

### 1.1 What ACP Standardizes

ACP defines a JSON-RPC 2.0 stdio transport between an editor/client and an agent subprocess:

1. **Lifecycle & Session RPCs**: `initialize`, `session/new`, `session/load` (and optional capability-gated `session/resume`), `session/prompt`, and `session/cancel`.
2. **Presentation Notifications**: `session/update` streaming `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, and plan updates.
3. **Optional Client Capabilities**: `fs` (`fs/read_text_file`, `fs/write_text_file`) and `terminal` (`terminal/create`, etc.) declared by the client during `initialize`.

### 1.2 Why ACP Cannot Replace Per-Engine 5-Duty Drivers ("No Policy-Free Universal Driver")

OpenClaude's remote service pool runs untrusted model turns on shared multi-session remote nodes (`box@node`), while real side-effecting tools execute **exclusively inside the user's container** via CCB tool host. Under this threat model, ACP alone cannot serve as a policy-free universal remote driver for four protocol-level reasons:

1. **Omitting client `fs`/`terminal` capabilities does NOT disable native agent tools**:
   Per ACP `overview` and `v1/tool-calls`, agents execute their own built-in tools directly unless vendor-specific CLI flags, config lockdowns, and catalog overrides disable them at the source (e.g., `--tools ""` + `--strict-mcp-config` on Claude Code; `--strict-config` + 17 `--disable <feature>` flags + 5-field `models.json` `POLICY` override on Codex).
2. **ACP `tool_call` notifications are advisory UI updates, not authorization proofs**:
   Per ACP `v1/tool-calls`, reporting tool calls via `session/update` is `SHOULD`, `kind` is a coarse UI category (`read` / `edit` / `execute` / `other` — cf. `packages/gateway/src/engine/grokAdapter.ts:264-273`), and `rawInput` may be omitted or partially populated. OpenClaude's `observationGate` requires exact `callId`, `ocbridge` tool alias, and `remoteCanonicalSha256(arguments)` parity between the native stdout observation and the independent `AF_UNIX` fixed-MCP request.
3. **ACP does not standardize `toolCallId -> MCP _meta` correlation**:
   Claude Code passes `_meta["claudecode/toolUseId"]` (`scripts/agent-remote/drivers/cc.py`), whereas Codex passes `_meta.callId` + `_meta.threadId` + `_meta["x-codex-turn-metadata"].turn_id` (`scripts/agent-remote/drivers/codex.py`). Any future ACP CLI must be empirically verified to propagate an unforgeable per-call ID into fixed MCP `tools/call`.
4. **Session replay & billing semantics are outside ACP's guarantee**:
   `session/load` replays prior conversation history via `session/update` notifications (`v1/session-setup`), which would re-authorize historical tool calls if fed into `observationGate` without vendor-aware replay fencing. Furthermore, ACP does not define ledger-grade cumulative vs. per-turn token counters (`cacheRead`, `cacheWrite`, reasoning-token inclusion).

**Architectural Decision**: Keep native protocol & source-ban knowledge isolated inside each engine's 5-duty Python driver (`launch_spec`, `decode`, `encode`, `probe`, `usage_policy` under `scripts/agent-remote/drivers/`). Shared JSON-RPC / ACP framing helpers should only be extracted into a driver support module when a **second** real ACP-speaking remote CLI passes P0 verification.

---

## 2. Four-Engine Remote Driver Capability Matrix (`cc`, `codex`, `Grok`, `Antigravity`)

| Dimension | `cc` (Claude Code `2.1.316`) | `codex` (OpenAI Codex `0.167.0`) | `Grok` (`grok-native` / `grok` CLI) | `Antigravity` (`antigravity` CLI `1.3.x` / `1.4.x`) |
| :--- | :--- | :--- | :--- | :--- |
| **1. Wire Protocol / ACP Version & Launch Mode** | **Non-ACP** Claude NDJSON + `oc-bridge` Hook plugin via `host.py` + root-scoped `tmux` (`TMUX_TMPDIR=<root>/tmux`). Never `-p`/`--print` for user turns (`drivers/cc.py:78-235`). | **Non-ACP** Codex JSON-RPC 2.0 `app-server --strict-config --listen stdio://` (`drivers/codex.py:115-209`). | Local adapter uses `--output-format streaming-json` (`grokAdapter.ts:685-695`) with ACP-style `kind`/`toolName` fields (`grokAdapter.ts:264-273`). Remote interactive/daemon mode: **`未核实`**. | **Non-ACP** headless NDJSON stream-json (`{"event":"user",...}` on stdin) routed through master `CLOUD_CODE_URL` OAuth swap relay (`antigravityAdapter.ts:7-24`). Remote node pool mode: **`未核实`**. |
| **2. Live Model Capability Probe (Zero Binary Scan / Fallback)** | **Verified (`PASS`)**: `claude -p --input-format stream-json --output-format stream-json --verbose --tools "" --setting-sources ""` + `control_request{subtype:"initialize"}` -> `control_response.response.models` (`drivers/cc.py:585-721`). | **Verified (`PASS`)**: `codex app-server --strict-config` -> `initialize` + `account/read` + cursor-paginated `model/list` (`drivers/codex.py:591-755`). | Local fast catalog uses HTTP `GROK_MODELS_LIST_URL` (`grokAdapter.ts:648,674-676`). Remote CLI-observed model/effort probe without API key exposure: **`未核实`**. | Models mapped statically via `antigravityCliModelId` (`antigravityAdapter.ts:37`); live CLI-observed per-account model/quota probe on remote node: **`未核实`**. |
| **3. `toolCallId -> Fixed MCP` Correlation** | **Verified (`PASS`)**: Native `assistant` `tool_use.id` (`mcp__ocbridge__<tN>`) <-> MCP `params._meta["claudecode/toolUseId"]` (`drivers/cc.py:333-369,465-497`). | **Verified (`PASS`)**: Native `item/started` `mcpToolCall.id` <-> MCP `params._meta.callId` + `threadId` + `x-codex-turn-metadata.turn_id` (`drivers/codex.py:326-370,482-514`). | **`未核实`**: Local `grokAdapter.ts:651-653` notes native Grok discovers project/compat MCPs beyond `--tools`; exact `_meta` call-ID correlation to `ocbridge` on remote node is **`未核实`**. | **`未核实`**: Local adapter normalizes built-in & MCP trajectory steps (`antigravityToolNormalize.ts`); unforgeable `_meta` call-ID propagation to remote fixed MCP is **`未核实`**. |
| **4. Native Tool Source-Ban** | **Verified (`PASS`)**: `--tools ""`, `--strict-mcp-config`, `--mcp-config <root>/mcp.json`, `--setting-sources ""`, `--disable-slash-commands`, `--allowedTools mcp__ocbridge__*`, plus `system/init` tool-list check (`drivers/cc.py:135-156,396-404`). | **Verified (`PASS`)**: `--strict-config`, 17 `--disable` flags (`shell_tool`, `unified_exec`, `multi_agent*`, `plugins`, etc.), `sandbox_mode="read-only"`, `web_search="disabled"`, config-pollution check, and 5-field `models.json` `POLICY` (`drivers/codex.py:30-98,144-191`). | Partial local evidence: `--tools` restricts model-visible builtins (`grokAdapter.ts:696-700`), `--no-subagents`, `--no-memory`, but project/compat MCP discovery still requires `HOME` isolation (`grokAdapter.ts:651-653`). Full remote zero-native-effect ban: **`未核实`**. | **`未核实`**: Local CLI has native file/command/browser capabilities (`BOUNDED_FILE_TOOLS`, `antigravityAdapter.ts:92-94`); source-level disabling of all native tools while keeping fixed MCP only is **`未核实`**. |
| **5. Token Usage Semantics & Billing Authority** | **Verified (`PASS`)**: `per_turn` (`cc-result-per-turn-v1`) from `result.usage` (`input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`); `inputIncludesCacheRead=false`, `allowCacheWrite=true` (`drivers/cc.py:64-75`). | **Verified (`PASS`)**: `cumulative` (`codex-0.167-total-v1`) from `thread/tokenUsage/updated.tokenUsage.total`; core computes `final - baseline`, subtracts `cachedInputTokens` from `inputTokens`, `reasoningOutputTokens` already inside `outputTokens`, rejects `cacheWriteInputTokens > 0` (`drivers/codex.py:100-112`). | **`未核实`**: Remote CLI stream-json token counter completeness, cache split, and multi-turn cumulative vs per-turn invariants are **`未核实`**. | Local adapter explicitly documents that CLI `result.usage` omits title-generation calls and is cumulative across resumes, so billing relies on master's HTTP relay `usageMetadata` instead (`antigravityAdapter.ts:20-24`). CLI-only receipt billing: **Not trustworthy without HTTP relay** (**`未核实`** for remote SSH pool). |
| **6. `resume` / `cancel` & Stop Proof** | **Verified (`PASS`)**: `--session-id <uuid>` / `--resume <uuid>`, `control_request{subtype:"interrupt"}`, plus `TMUX_TMPDIR` kill + systemd scope `bootId`/inode/`populated 0`/`tool.sock` proof (`core/controller.py:561-664`). | **Verified (`PASS`)**: `thread/start` & `thread/resume` + `turn/interrupt`, plus systemd scope `bootId`/inode/`populated 0`/`tool.sock` proof (`core/controller.py:561-664`). | Local `--resume <nativeId>` exists (`grokAdapter.ts:702`), process-group kill on cancel; remote replay-free `resume` & cgroup containment: **`未核实`**. | Local resume on large conversations in 1.4.0 exhibited `timeout waiting for cascade to start running` ambiguous execution (`antigravityAdapter.ts:135-140`). Remote replay-free `resume`: **`未核实`**. |
| **7. `OCV5-749` Implementation Status** | **Implemented & Conformance-Gated** (`scripts/agent-remote/drivers/cc.py`). | **Implemented & Conformance-Gated** (`scripts/agent-remote/drivers/codex.py`). | **Out of Scope (`不做`)** — requires dedicated P0 survey & source-ban proof before onboarding. | **Out of Scope (`不做`)** — coupled to master `CLOUD_CODE_URL` OAuth token-swap relay (`antigravityAdapter.ts:12-24`). |

---

## 3. Live Selfhost Node P0 Survey Baseline (`remote-driver-survey.py`)

Survey CLI entrypoint:

```bash
python3 scripts/agent-remote/remote-driver-survey.py --driver all --output <path>
```

 Live node verification records (executed in read-only / isolated `/tmp` systemd scopes without touching active user lanes or reading credential contents) are appended during Slice 5 live node verification alongside conformance evidence artifacts.
