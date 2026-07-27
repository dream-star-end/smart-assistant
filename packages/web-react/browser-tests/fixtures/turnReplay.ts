/**
 * 一整轮真实 WS 帧序列(单一权威 fixture)。
 *
 * 为什么存在(2026-07 时间线重构逃逸实证):#147→#158 三天内 11 个连续修复全部落在
 * **WS 帧 → reducer → 虚拟列表 → 卡片渲染** 这条链上,而当时的覆盖是
 *   - jsdom 单测只喂 reducer 已经消化过的 `ChatMessage` 行;
 *   - browser-tests 只用手写 stub message 直接挂 MessageRenderer。
 * 链条中间那段(**真 wire 帧经真 ChatSocket 消化后驱动真 DOM**)无人守 —— 帧字段名
 * 漂一个、reducer 归并键改一处、虚拟条目键变一次,两侧都照绿。
 *
 * 这里的帧按 gateway 真实出站形状写(见 packages/protocol/src/frames.ts 的
 * OutboundMessage / OutboundContentBlock),并由 src/lib/chat/replayFrames.contract.test.ts
 * 用 protocol 的 typebox schema **逐帧校验** —— fixture 不允许是"看起来像"的幻想 JSON,
 * 与 protocol 漂移即红。
 *
 * 覆盖的一轮真实形状:relay 就绪 → 受理 ACK → thinking 流式 → Bash tool_use(partial)
 * → tool_output_tail 快照 → tool_result → assistant 正文两段 delta → isFinal 终帧。
 */

/** 会话 peer id(harness 与 run.mjs 共用,断言里出现的键都由它派生)。 */
export const REPLAY_SESSION_ID = "browser-replay-session";
export const REPLAY_AGENT_ID = "main";
export const REPLAY_SESSION_KEY = `agent:main:webchat:dm:${REPLAY_SESSION_ID}`;

/** 用户可见的精确文本标记(run.mjs 按这些串做 DOM 断言,勿改成同义词)。 */
export const REPLAY_MARKERS = {
  userText: "REPLAY_USER_QUESTION",
  thinking: "REPLAY_THINKING_BODY",
  toolCommand: "printf REPLAY_TOOL_ARG",
  toolTail: "REPLAY_TOOL_TAIL_SNAPSHOT",
  toolOutput: "REPLAY_TOOL_FINAL_OUTPUT",
  answerHead: "REPLAY_ANSWER_HEAD",
  answerTail: "REPLAY_ANSWER_TAIL",
  wideCode: "REPLAY_WIDE_CODE_LINE",
} as const;

const peer = { id: REPLAY_SESSION_ID, kind: "dm" as const };

/** server 侧铸的稳定行 id(前端与 tape 共识键;换格式会让归并键漂移)。 */
const TURN = `srv-${REPLAY_SESSION_ID}-${REPLAY_AGENT_ID}-t1`;
const TOOL_BLOCK_ID = "blk-replay-bash-1";

/**
 * assistant 终帧正文。故意含一段**超宽不可折行**代码块:真实回答里代码块就是这样,
 * 它保证 T21 的时间线是在"有宽内容"的条件下收敛的(宽内容必须留在自己的滚动容器里,
 * 不能把时间线撑宽)。整页横向溢出的断言在 T25,那条用例有自己的整页 harness。
 */
const ANSWER_TAIL_MARKDOWN = [
  REPLAY_MARKERS.answerTail,
  "",
  "```bash",
  `${REPLAY_MARKERS.wideCode} ${"x".repeat(400)}`,
  "```",
].join("\n");

/**
 * 一帧出站 wire(gateway → 浏览器)。用 unknown 记形状:browser-tests 不进 tsc -b,
 * 真正的形状门是 replayFrames.contract.test.ts 的 typebox 校验。
 */
export type ReplayFrame = Record<string, unknown>;

/** 受理前的就绪信号 —— 没有它,offline 队列不会排空,一帧都发不出去。 */
export const relayReadyFrame: ReplayFrame = { type: "sys.relay_ready", peer };

/** 受理 ACK(带 clientMessageId,由 harness 在真实发送后回填)。 */
export function admittedAckFrame(clientMessageId: string): ReplayFrame {
  return {
    type: "outbound.ack",
    admitted: true,
    peer,
    clientMessageId,
    idempotencyKey: `web:${clientMessageId}:0`,
  };
}

/**
 * 该轮的 outbound.message 序列(顺序即 wire 顺序,frameSeq 严格单调 —— 非单调会被
 * acceptFrameSeq 当重复帧丢掉,这一点本身就是被守的不变量)。
 */
export function replayTurnFrames(clientMessageId: string): ReplayFrame[] {
  const base = {
    type: "outbound.message",
    sessionKey: REPLAY_SESSION_KEY,
    channel: "webchat",
    peer,
    clientMessageId,
  };
  return [
    {
      ...base,
      frameSeq: 1,
      blocks: [
        { kind: "thinking", text: REPLAY_MARKERS.thinking, messageId: `${TURN}-thinking` },
      ],
      isFinal: false,
    },
    {
      ...base,
      frameSeq: 2,
      blocks: [
        {
          kind: "tool_use",
          blockId: TOOL_BLOCK_ID,
          toolName: "Bash",
          inputPreview: REPLAY_MARKERS.toolCommand,
          inputJson: { command: REPLAY_MARKERS.toolCommand },
          partial: false,
          messageId: `${TURN}-tool-${TOOL_BLOCK_ID}`,
        },
      ],
      isFinal: false,
    },
    {
      ...base,
      frameSeq: 3,
      blocks: [
        {
          kind: "tool_output_tail",
          toolUseBlockId: TOOL_BLOCK_ID,
          tail: REPLAY_MARKERS.toolTail,
          totalBytes: REPLAY_MARKERS.toolTail.length,
          truncatedHead: false,
        },
      ],
      isFinal: false,
    },
    {
      ...base,
      frameSeq: 4,
      blocks: [
        {
          kind: "tool_result",
          blockId: "blk-replay-bash-1-result",
          toolUseBlockId: TOOL_BLOCK_ID,
          toolName: "Bash",
          isError: false,
          output: REPLAY_MARKERS.toolOutput,
        },
      ],
      isFinal: false,
    },
    {
      ...base,
      frameSeq: 5,
      blocks: [{ kind: "text", text: REPLAY_MARKERS.answerHead, messageId: TURN }],
      isFinal: false,
    },
    {
      ...base,
      frameSeq: 6,
      blocks: [{ kind: "text", text: `\n\n${ANSWER_TAIL_MARKDOWN}`, messageId: TURN }],
      isFinal: true,
      meta: { turn: 1, totalTokens: 1234, stopReason: "end_turn" },
    },
  ];
}

/**
 * 时间线条目的**期望顺序**(用户行 → 思考 → 工具 → 回答)。
 * run.mjs 按 `data-chat-virtual-key` 的顺序核对:归并/排序回归会立刻错位。
 */
export const EXPECTED_TIMELINE_ROLES = ["user", "thinking", "tool", "assistant"] as const;
