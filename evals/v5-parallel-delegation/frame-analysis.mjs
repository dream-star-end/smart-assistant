function walk(value, visit, insideDelegate = false) {
  if (!value || typeof value !== "object") return;
  const nested = insideDelegate || value.kind === "delegate_progress";
  visit(value, nested);
  if (Array.isArray(value)) {
    for (const child of value) walk(child, visit, nested);
  } else {
    for (const child of Object.values(value)) walk(child, visit, nested);
  }
}

function normalizeTool(name, input) {
  if (/^codex:mcpToolCall$/i.test(name)) {
    const tool = input?.tool ?? input?.name ?? "";
    const server = input?.server ?? "";
    let args = input?.arguments ?? {};
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        args = {};
      }
    }
    return { name: `${server}:${tool}`, input: args };
  }
  return { name, input };
}

export function analyzeFrames(frames, peerId) {
  const tools = new Map();
  const results = new Map();
  const delegateRuns = new Map();
  let sentRouting = null;
  let rootTokens = 0;
  let rootCostUsd = 0;
  let answerText = "";
  const childTokens = new Map();
  let retries = 0;
  const resourceFailures = [];
  const scopedFrames = frames.filter((frame) => {
    const payload = frame.payload;
    if (payload?.peer?.id === peerId) return true;
    return frame.direction === "sent" &&
      payload?.type === "inbound.message" &&
      payload?.peer?.id === peerId;
  });
  for (const frame of scopedFrames) {
    const payload = frame.payload;
    if (frame.direction === "sent" && payload?.type === "inbound.message") sentRouting = payload;
    const serialized = JSON.stringify(payload);
    if (
      /oom|queue[_ -]?(?:timeout|full)|resource gate timeout|abnormal retry|too many concurrent delegations|delegate resource pressure|排队.*(?:超时|已满)|已等待.*资源仍紧张/i.test(
        serialized,
      )
    ) {
      resourceFailures.push(serialized.slice(0, 500));
    }
    if (payload?.type === "outbound.turn_usage" && Number.isFinite(payload.usage?.totalTokens)) {
      rootTokens = Math.max(rootTokens, Number(payload.usage.totalTokens));
    }
    if (payload?.type === "outbound.message" && payload.isFinal === true) {
      const value = payload.meta?.totalCost ?? payload.meta?.cost;
      if (Number.isFinite(value)) rootCostUsd = Math.max(rootCostUsd, Number(value));
    }
    if (payload?.type === "outbound.message") {
      for (const block of payload.blocks ?? []) {
        if (block?.kind === "text" && typeof block.text === "string") answerText += block.text;
      }
    }
    walk(payload, (node, insideDelegate) => {
      const rawName = node.toolName ?? node.name;
      if (node.kind === "tool_use" && typeof rawName === "string" && node.partial !== true) {
        const rawInput = node.inputJson ?? node.input ?? node.args ?? {};
        const normalized = normalizeTool(rawName, rawInput);
        const id = node.blockId ?? node.toolUseId ?? `${normalized.name}:${JSON.stringify(normalized.input)}`;
        tools.set(id, {
          name: normalized.name,
          input: normalized.input,
          nested: insideDelegate || Boolean(node.parentToolUseId),
        });
      }
      if (node.kind === "tool_result") {
        const id = node.toolUseBlockId ?? node.toolUseId ?? node.blockId?.replace(/:result$/, "");
        if (typeof id === "string") results.set(id, { isError: Boolean(node.isError) });
      }
      if (node.kind === "delegate_progress" && typeof node.runId === "string") {
        const current = delegateRuns.get(node.runId) ?? {
          run_id: node.runId,
          agent_id: node.agentId ?? null,
          queued_at: null,
          started_at: null,
          finished_at: null,
          is_error: false,
        };
        if (node.phase === "start") {
          if (/排队中|queued|waiting for (?:a )?(?:delegate|resource)/i.test(String(node.text ?? ""))) {
            current.queued_at ??= frame.at;
          } else {
            current.started_at ??= frame.at;
          }
        }
        if (node.phase === "done" || node.phase === "error") {
          current.finished_at = frame.at;
          current.is_error ||= node.phase === "error" || node.isError === true;
          if (current.is_error) {
            resourceFailures.push(
              `delegate run ${node.runId} failed: ${JSON.stringify(node).slice(0, 400)}`,
            );
          }
        }
        delegateRuns.set(node.runId, current);
        if (
          node.phase === "usage" &&
          typeof node.usageRunId === "string" &&
          Number.isFinite(node.usage?.totalTokens)
        ) {
          childTokens.set(
            node.usageRunId,
            Math.max(childTokens.get(node.usageRunId) ?? 0, Number(node.usage.totalTokens)),
          );
        }
      }
      if (
        node.kind === "turn_status" &&
        (node.status === "retrying" || node.phase?.status === "retrying")
      ) retries++;
    });
  }

  let delegateTasksCalls = 0;
  let delegateTaskCalls = 0;
  let delegateTasksErrors = 0;
  let maxShards = 0;
  let nestedDelegateCalls = 0;
  let backgroundBashFanout = 0;
  let nativeAgentCalls = 0;
  for (const tool of tools.values()) {
    if (/delegate_tasks$/.test(tool.name)) {
      delegateTasksCalls++;
      const tasks = tool.input?.tasks;
      if (Array.isArray(tasks)) maxShards = Math.max(maxShards, tasks.length);
      if (tool.nested) nestedDelegateCalls++;
    } else if (/delegate_task$/.test(tool.name)) {
      delegateTaskCalls++;
      if (tool.nested) nestedDelegateCalls++;
    }
    if (/bash/i.test(tool.name)) {
      const command = String(tool.input?.command ?? tool.input?.cmd ?? "");
      if (/(?<!&)&(?!&)|\bxargs\s+[^;\n]*-[Pp]\b|\b(?:gnu\s+)?parallel\b|\bnohup\b/.test(command)) {
        backgroundBashFanout++;
      }
    }
    if (
      /^(?:Agent|Task|spawn_agent|Codex:multiAgent|collabAgentToolCall)$/i.test(tool.name) ||
      /(?:^|:)multiAgent$/i.test(tool.name)
    ) nativeAgentCalls++;
  }
  for (const [id, tool] of tools) {
    if (/delegate_tasks$/.test(tool.name) && results.get(id)?.isError !== false) {
      delegateTasksErrors++;
    }
  }

  const timeline = [...delegateRuns.values()]
    .filter((run) => Number.isFinite(run.started_at))
    .flatMap((run) => [
      { at: run.started_at, delta: 1 },
      ...(Number.isFinite(run.finished_at) ? [{ at: run.finished_at, delta: -1 }] : []),
    ])
    .sort((a, b) => a.at - b.at || a.delta - b.delta);
  let active = 0;
  let maxConcurrentDelegates = 0;
  for (const point of timeline) {
    active += point.delta;
    maxConcurrentDelegates = Math.max(maxConcurrentDelegates, active);
  }

  return {
    sentRouting,
    answerText: answerText.trim(),
    tokens: rootTokens + [...childTokens.values()].reduce((sum, value) => sum + value, 0),
    rootTokens,
    childTokens: Object.fromEntries(childTokens),
    costUsd: rootCostUsd,
    resourceFailures,
    retries,
    delegateRuns: [...delegateRuns.values()],
    behavior: {
      delegate_tasks_calls: delegateTasksCalls,
      delegate_task_calls: delegateTaskCalls,
      delegate_tasks_errors: delegateTasksErrors,
      max_shards: maxShards,
      max_concurrent_delegates: maxConcurrentDelegates,
      delegate_runs_started: [...delegateRuns.values()].filter((run) => run.started_at !== null).length,
      delegate_runs_queued: [...delegateRuns.values()].filter((run) => run.queued_at !== null).length,
      delegate_runs_completed: [...delegateRuns.values()].filter(
        (run) => run.finished_at !== null && run.is_error === false,
      ).length,
      delegate_runs_errors: [...delegateRuns.values()].filter((run) => run.is_error === true).length,
      delegate_runs_incomplete: [...delegateRuns.values()].filter(
        (run) => run.started_at !== null && run.finished_at === null,
      ).length,
      nested_delegate_calls: nestedDelegateCalls,
      background_bash_fanout: backgroundBashFanout,
      native_agent_calls: nativeAgentCalls,
    },
  };
}
