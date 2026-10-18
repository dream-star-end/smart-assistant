import assert from "node:assert/strict";

type Body = Record<string, unknown>;
type Turn = { snapshotJsonl: string; stdinJsonl: string };

/** OCV5-499: a deferred-tools announcement follows the unanswered delegate goal.
 * Use the pinned candidate's mapper, without starting a CLI or model request. */
export function provePendingUser(api: { compile: (body: Body) => Turn }): string {
  const user = (content: unknown) => ({ role: "user", content });
  const text = (value: string) => ({ type: "text", text: value });
  const goal = "[委派任务]\n目标: 返回 α-499\n上下文: 保留第二行";
  const reminder = "<system-reminder><available-deferred-tools>Read</available-deferred-tools></system-reminder>";
  const body = (messages: unknown[]): Body => ({ model: "box-api-claude-haiku-5-5",
    stream: true, max_tokens: 128, messages });
  const current = (turn: Turn): unknown => JSON.parse(turn.stdinJsonl).message.content;
  const input = body([user(goal), { role: "system", content: "platform rules" }, user([text(reminder)])]);
  const before = structuredClone(input);
  const fresh = api.compile(input);
  assert.equal(fresh.snapshotJsonl, "", "PENDING_USER_GOAL_BECAME_HISTORY");
  assert.deepEqual(current(fresh), [text(goal), text(reminder)], "PENDING_USER_GOAL_MISSING");
  assert.deepEqual(input, before, "PENDING_USER_CANONICAL_CHANGED");
  for (const content of [goal, [text(goal), text("context")]]) {
    const single = api.compile(body([user(content)]));
    assert.deepEqual(current(single), content, "PENDING_USER_SINGLE_REWRITTEN");
    assert.equal(single.snapshotJsonl, "");
  }
  const call = { type: "tool_use", id: "call_completed", name: "Read", input: {} };
  const result = { type: "tool_result", tool_use_id: call.id, content: "complete" };
  const completed = api.compile(body([user("read"), { role: "assistant", content: [call] },
    user([result]), user(goal), user(reminder)]));
  assert.deepEqual(current(completed), [text(goal), text(reminder)], "PENDING_USER_TOOL_BOUNDARY");
  const history = completed.snapshotJsonl.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(history.length, 3);
  assert.equal(history[1].message.content[0].id, history[2].message.content[0].tool_use_id);
  assert.match(history[1].message.content[0].id, /^toolu_oc[a-f0-9]{32}$/);
  assert.throws(() => api.compile(body([user("read"), { role: "assistant", content: [call] }, user([result])])));
  for (const content of [[text(goal), { type: "image", source: {} }], [text(goal), null]]) {
    assert.throws(() => api.compile(body([user(content), user(reminder)])),
      "PENDING_USER_UNSUPPORTED_BLOCK_DROPPED");
  }
  return "[ocv5-499-pending-user] PASS — the full delegated goal and late tool announcement reach the same current stdin without changing canonical bytes or completed tool history";
}
