// Pure projection of the gateway's append-only session tape into the message
// model already consumed by the Web UI. The tape remains the source of truth;
// this reducer can be rerun after any cursor page is added without losing data.

function textOf(block) {
  if (typeof block?.text === 'string') return block.text
  return block?.text == null ? '' : JSON.stringify(block.text)
}

function stableId(prefix, key) {
  return `tape-${prefix}-${String(key).replace(/[^a-zA-Z0-9_-]/g, '_')}`
}

function appendChild(group, block) {
  const children = group.childBlocks || (group.childBlocks = [])
  const text = textOf(block)
  if (block.kind === 'text' || block.kind === 'thinking') {
    if (!text) return
    const last = children[children.length - 1]
    if (last?.kind === block.kind) last.text = (last.text || '') + text
    else children.push({ kind: block.kind, text })
    return
  }
  if (block.kind === 'tool_use') {
    let tool = block.blockId
      ? children.find((item) => item.kind === 'tool_use' && item.blockId === block.blockId)
      : null
    if (!tool) {
      tool = {
        kind: 'tool_use',
        blockId: block.blockId,
        toolName: block.toolName || 'unknown',
        inputPreview: block.inputPreview || '',
        inputJson: block.inputJson ?? null,
        _partial: !!block.partial,
        _completed: false,
        output: null,
        error: false,
      }
      children.push(tool)
    } else {
      tool.inputPreview = block.inputPreview || tool.inputPreview
      if (block.inputJson != null) tool.inputJson = block.inputJson
      tool._partial = !!block.partial
    }
    return
  }
  if (block.kind === 'tool_result') {
    const useId = block.toolUseBlockId || String(block.blockId || '').replace(/:result$/, '')
    let tool = children.find((item) => item.kind === 'tool_use' && item.blockId === useId)
    if (!tool) {
      tool = {
        kind: 'tool_use',
        blockId: useId || block.blockId,
        toolName: block.toolName || 'unknown',
        inputPreview: '',
        inputJson: null,
      }
      children.push(tool)
    }
    tool._completed = true
    tool._partial = false
    tool.output = block.output ?? block.preview ?? ''
    tool.outputJson = block.outputJson ?? null
    tool.error = !!block.isError
    return
  }
  if (block.kind === 'tool_output_tail') {
    const tool = children.find(
      (item) => item.kind === 'tool_use' && item.blockId === block.toolUseBlockId,
    )
    if (tool && (tool.bashTail?.totalBytes ?? 0) <= (block.totalBytes ?? 0)) {
      tool.bashTail = {
        tail: block.tail || '',
        totalBytes: block.totalBytes || 0,
        truncatedHead: !!block.truncatedHead,
      }
    }
  }
}

export function projectSessionTape(rows) {
  const frames = [...(Array.isArray(rows) ? rows : [])].sort((a, b) => a.tapeSeq - b.tapeSeq)
  const messages = []
  const completedTurns = new Set(
    frames
      .filter((row) => row.direction === 'outbound' && row.frame?.isFinal)
      .map((row) => row.turnKey),
  )
  const byKey = new Map()
  const tools = new Map()
  const agentGroups = new Map()
  const turnState = new Map()

  const add = (key, message) => {
    const existing = byKey.get(key)
    if (existing) return existing
    byKey.set(key, message)
    messages.push(message)
    return message
  }

  for (const row of frames) {
    const frame = row?.frame || {}
    if (row.direction === 'inbound') {
      const msg = frame.clientMessage
      if (!msg || typeof msg.id !== 'string') continue
      add(`user:${msg.id}`, {
        ...msg,
        role: 'user',
        status: completedTurns.has(row.turnKey) ? 'replied' : 'sent',
        _source: 'tape',
      })
      continue
    }
    if (frame.type === 'outbound.permission_request') {
      add(`permission:${frame.requestId}`, {
        id: stableId('permission', frame.requestId || row.tapeSeq),
        role: 'permission',
        text: frame.toolName || 'unknown',
        ts: row.ts,
        requestId: frame.requestId,
        toolName: frame.toolName,
        inputPreview: frame.inputPreview || '',
        inputJson: frame.inputJson || null,
        _resolved: false,
        _source: 'tape',
      })
      continue
    }
    if (frame.type === 'outbound.permission_settled') {
      const permission = byKey.get(`permission:${frame.requestId}`)
      if (permission) {
        permission._resolved = true
        permission._behavior = frame.behavior
        permission._settledReason = frame.reason || null
        if (frame.answers && typeof frame.answers === 'object') permission._answers = frame.answers
      }
      continue
    }
    if (frame.type === 'outbound.workflow_progress') {
      const key = `workflow:${frame.taskId}`
      let workflow = byKey.get(key)
      if (!workflow && frame.stage !== 'updated') {
        workflow = add(key, {
          id: stableId('workflow', frame.taskId || row.tapeSeq),
          role: 'workflow-group',
          text: frame.workflowName || frame.description || '工作流',
          ts: row.ts,
          workflowTaskId: frame.taskId,
          workflowName: frame.workflowName,
          _wfStatus: 'running',
          _wfPhases: [],
          _wfAgents: [],
          _wfUsage: null,
          startTime: row.ts,
          _source: 'tape',
        })
      }
      if (workflow) {
        if (frame.workflowName && !workflow.workflowName) workflow.workflowName = frame.workflowName
        if (frame.usage) workflow._wfUsage = frame.usage
        if (frame.stage === 'updated' && frame.status === 'completed') {
          workflow._wfStatus = 'completed'
        }
        for (const item of Array.isArray(frame.items) ? frame.items : []) {
          if (item?.type === 'workflow_phase') {
            const existing = workflow._wfPhases.find((phase) => phase.index === item.index)
            if (existing) Object.assign(existing, item)
            else workflow._wfPhases.push({ ...item })
          } else if (item?.type === 'workflow_agent') {
            const existing = workflow._wfAgents.find((agent) => agent.index === item.index)
            if (existing) Object.assign(existing, item)
            else workflow._wfAgents.push({ ...item })
          }
        }
      }
      continue
    }
    if (frame.type !== 'outbound.message') continue
    const turn = frame.turnId || row.turnKey
    let state = turnState.get(turn)
    if (!state) {
      state = { assistantSegment: 0, thinkingSegment: 0, lastAssistant: null }
      turnState.set(turn, state)
    }
    for (const block of Array.isArray(frame.blocks) ? frame.blocks : []) {
      const parent = block.parentToolUseId && agentGroups.get(block.parentToolUseId)
      if (parent) {
        appendChild(parent, block)
        if (block.kind === 'tool_use' && /^Agent$/i.test(block.toolName || '') && block.blockId) {
          agentGroups.set(block.blockId, parent)
        }
        continue
      }
      if (block.kind === 'text' || block.kind === 'thinking') {
        const role = block.kind === 'text' ? 'assistant' : 'thinking'
        const segmentField = role === 'assistant' ? 'assistantSegment' : 'thinkingSegment'
        const key = block.blockId
          ? `${turn}:${role}:${block.blockId}`
          : `${turn}:${role}:segment-${state[segmentField]}`
        const msg = add(key, {
          id: stableId(role, key),
          role,
          text: '',
          ts: row.ts,
          blockId: block.blockId ? key : undefined,
          _source: 'tape',
        })
        msg.text += textOf(block)
        msg.completedAt = row.ts
        if (role === 'assistant') state.lastAssistant = msg
      } else if (block.kind === 'plan') {
        const key = `${turn}:plan:${block.blockId || 'codex-plan'}`
        const msg = add(key, {
          id: stableId('plan', key),
          role: 'plan',
          text: '',
          ts: row.ts,
          blockId: block.blockId || 'codex-plan',
          _tapeTurnKey: turn,
          _source: 'tape',
        })
        msg.text = textOf(block) || msg.text
        msg.explanation = block.explanation || msg.explanation || ''
        if (Array.isArray(block.steps)) msg.steps = block.steps
        msg._partial = block.partial !== false
        msg.completedAt = row.ts
      } else if (block.kind === 'goal') {
        const key = `${turn}:goal:${block.blockId || 'codex-goal'}`
        const msg = add(key, {
          id: stableId('goal', key),
          role: 'goal',
          text: '',
          ts: row.ts,
          blockId: block.blockId || 'codex-goal',
          _source: 'tape',
        })
        msg.text = block.objective || msg.text
        Object.assign(msg, {
          status: block.status || '',
          tokenBudget: block.tokenBudget,
          tokensUsed: block.tokensUsed,
          timeUsedSeconds: block.timeUsedSeconds,
          createdAt: block.createdAt,
          updatedAt: block.updatedAt,
          cleared: !!block.cleared,
          completedAt: row.ts,
        })
      } else if (block.kind === 'tool_use') {
        state.assistantSegment++
        state.thinkingSegment++
        const useId = block.blockId || `${turn}:tool:${row.tapeSeq}`
        if (/^Agent$/i.test(block.toolName || '')) {
          const key = `${turn}:agent:${useId}`
          const input =
            block.inputJson && typeof block.inputJson === 'object' ? block.inputJson : {}
          const group = add(key, {
            id: stableId('agent', key),
            role: 'agent-group',
            text:
              input.description ||
              (typeof input.prompt === 'string' ? input.prompt.slice(0, 80) : '') ||
              block.inputPreview ||
              '子任务',
            ts: row.ts,
            blockId: useId,
            toolName: 'Agent',
            startTime: row.ts,
            childBlocks: [],
            _source: 'tape',
          })
          agentGroups.set(useId, group)
          tools.set(useId, group)
        } else {
          const key = `${turn}:tool:${useId}`
          const tool = add(key, {
            id: stableId('tool', key),
            role: 'tool',
            text: block.toolName || 'unknown',
            ts: row.ts,
            toolName: block.toolName || 'unknown',
            blockId: useId,
            inputPreview: block.inputPreview || '',
            inputJson: block.inputJson ?? null,
            _partial: !!block.partial,
            _completed: false,
            output: null,
            error: false,
            _source: 'tape',
          })
          tool.inputPreview = block.inputPreview || tool.inputPreview
          if (block.inputJson != null) tool.inputJson = block.inputJson
          tool._partial = !!block.partial
          tools.set(useId, tool)
        }
      } else if (block.kind === 'tool_result') {
        state.assistantSegment++
        state.thinkingSegment++
        const useId = block.toolUseBlockId || String(block.blockId || '').replace(/:result$/, '')
        const tool = tools.get(useId)
        if (tool) {
          tool._completed = true
          tool._partial = false
          tool.output = block.output ?? block.preview ?? ''
          tool.outputJson = block.outputJson ?? null
          tool.error = !!block.isError
          tool.completedAt = row.ts
          if (tool.role === 'agent-group') {
            tool._resultPreview = (block.preview || block.output || '').slice(0, 200)
            tool._isError = !!block.isError
            tool._duration = row.ts - tool.startTime
          }
        } else if (block.output || block.preview) {
          const key = `${turn}:result:${block.blockId || row.tapeSeq}`
          add(key, {
            id: stableId('tool', key),
            role: 'tool',
            text: block.toolName || 'unknown',
            ts: row.ts,
            toolName: block.toolName || 'unknown',
            blockId: block.blockId,
            inputPreview: '',
            inputJson: null,
            _partial: false,
            _completed: true,
            output: block.output ?? block.preview ?? '',
            outputJson: block.outputJson ?? null,
            error: !!block.isError,
            _source: 'tape',
          })
        }
      } else if (block.kind === 'tool_output_tail') {
        const tool = tools.get(block.toolUseBlockId)
        if (tool && (tool.bashTail?.totalBytes ?? 0) <= (block.totalBytes ?? 0)) {
          tool.bashTail = {
            tail: block.tail || '',
            totalBytes: block.totalBytes || 0,
            truncatedHead: !!block.truncatedHead,
          }
        }
      }
    }
    if (frame.isFinal) {
      for (const msg of messages) {
        if (msg.role === 'plan' && msg._tapeTurnKey === turn) msg._partial = false
      }
      if (state.lastAssistant && frame.meta) {
        const meta = frame.meta
        const parts = []
        if (meta.costStatus === 'unavailable') parts.push('订阅计费不可用')
        else if (typeof meta.cost === 'number') parts.push(`$${meta.cost.toFixed(4)}`)
        if (typeof meta.inputTokens === 'number') parts.push(`in ${meta.inputTokens}`)
        if (typeof meta.outputTokens === 'number') parts.push(`out ${meta.outputTokens}`)
        if (meta.cacheReadTokens > 0) parts.push(`cache-r ${meta.cacheReadTokens}`)
        if (typeof meta.turn === 'number') parts.push(`T${meta.turn}`)
        if (meta.usageStatus === 'unavailable') parts.push('token 用量不可用')
        state.lastAssistant.metaText = parts.join(' · ')
      }
    }
  }
  return messages.sort((a, b) => (a.ts || 0) - (b.ts || 0))
}
