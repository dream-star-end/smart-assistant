// OpenClaude — Slash Commands
import { apiGet } from './api.js'
import { $, _mod } from './dom.js'
import { getSession, state } from './state.js'
import { toast } from './ui.js'
import {
  addSystemMessage,
  localStopTeardown,
  nudgeDrain,
  resetReplyTracker,
  safeWsSend,
} from './websocket.js'

// ── Late-binding for circular deps ──
let _deps = {}
export function setCommandDeps(deps) {
  _deps = deps
}

// ── Module-private state ──
export let slashPopupVisible = false
let _slashSelected = 0
let _slashMatches = []

// Expose getters for main app keydown handler
export function getSlashSelected() {
  return _slashSelected
}
export function setSlashSelected(v) {
  _slashSelected = v
}
export function getSlashMatches() {
  return _slashMatches
}

const slashCommands = [
  {
    cmd: '/help',
    desc: '显示所有可用命令',
    run() {
      const lines = ['**可用命令:**', '']
      for (const c of slashCommands) lines.push(`\`${c.cmd}\` — ${c.desc}`)
      lines.push('', `也可以用 \`${_mod}K\` 打开命令面板`)
      addSystemMessage(lines.join('\n'))
    },
  },
  {
    cmd: '/new',
    desc: '新建会话',
    run() {
      _deps.createNewChat()
    },
  },
  {
    cmd: '/clear',
    desc: '清空当前会话消息和上下文',
    run() {
      const sess = getSession()
      if (!sess) return
      sess.messages = []
      sess._streamingAssistant = null
      sess._streamingThinking = null
      // Drop reply tracker so a late isFinal from the cleared turn doesn't
      // spuriously attach to (or warn about) subsequent fresh turns.
      resetReplyTracker(sess)
      // Purge any offline queued messages for this session to prevent stale sends
      if (state.offlineQueue?.length > 0) {
        state.offlineQueue = state.offlineQueue.filter(item => item.sessId !== sess.id)
      }
      if (state._offlineQueuePending?.length > 0) {
        state._offlineQueuePending = state._offlineQueuePending.filter(item => item.sessId !== sess.id)
      }
      if (state._offlineDrainingCurrent?.sessId === sess.id) {
        state._offlineDrainingCurrent = null
        nudgeDrain()  // Advance drain to next item since we killed the current one
      }
      _deps.renderMessages()
      _deps.scheduleSaveFromUserEdit(sess)
      // Notify gateway to kill the CCB subprocess so context is truly reset
      // Next message will spawn a fresh process with no history.
      // safeWsSend:背压时 close+reconnect,reset 丢了下次发消息会重 spawn fresh。
      if (state.ws && state.ws.readyState === 1) {
        safeWsSend(state.ws, JSON.stringify({
          type: 'inbound.control.reset',
          channel: 'webchat',
          peer: { id: sess.id, kind: 'dm' },
          agentId: sess.agentId || state.defaultAgentId,
        }))
      }
      toast('会话已清空，上下文已重置')
    },
  },
  {
    cmd: '/stop',
    desc: '停止当前生成',
    run() {
      const sess = getSession()
      if (!sess) return
      // 2026-04-22 Codex R2 IMPORTANT#1:原实现只要 state.ws 存在就 localStopTeardown,
      // ws 不是 OPEN 时 safeWsSend 直接返 false,stop 帧没发出,但本地 UI 已 teardown;
      // 重连后 hello 汇报 inFlight=false,服务端不会发 interrupted final → 旧 turn 继续
      // 跑、token 继续扣。必须 WS 处于 OPEN(readyState === 1)时才允许 stop,否则提示
      // 用户网络未就绪。OPEN 但 safeWsSend 背压失败可以 teardown,因为它会 close(4000)
      // 触发服务端 channel cleanup(服务端自会清 in-flight turn)。
      if (!state.ws || state.ws.readyState !== 1) {
        toast('当前连接未就绪,无法发送停止信号', 'error')
        return
      }
      safeWsSend(state.ws, JSON.stringify({
        type: 'inbound.control.stop',
        channel: 'webchat',
        peer: { id: sess.id, kind: 'dm' },
        agentId: sess.agentId || state.defaultAgentId,
      }))
      localStopTeardown(sess)
      toast('已发送停止信号')
    },
  },
  {
    cmd: '/memory',
    desc: '打开记忆管理',
    run() {
      _deps.openMemoryModal()
    },
  },
  {
    cmd: '/skills',
    desc: '打开技能管理',
    run() {
      _deps.openSkillsModal()
    },
  },
  {
    cmd: '/persona',
    desc: '编辑 agent 人格',
    run() {
      const sess = getSession()
      _deps.openPersonaEditor(sess?.agentId || state.defaultAgentId)
    },
  },
  {
    cmd: '/tasks',
    desc: '管理定时任务',
    run() {
      _deps.openTasksModal()
    },
  },
  {
    cmd: '/theme',
    desc: '切换主题',
    run() {
      _deps.cycleTheme()
    },
  },
  {
    cmd: '/config',
    desc: '查看当前配置 (调试)',
    async run() {
      ;(async () => {
        try {
          const cfg = await apiGet('/api/config')
          addSystemMessage(`**当前配置:**\n\`\`\`json\n${JSON.stringify(cfg, null, 2)}\n\`\`\``)
        } catch {
          toast('获取配置失败', 'error')
        }
      })()
    },
  },
]

export function handleSlashCommand(text) {
  const parts = text.match(/^(\/\S+)\s*(.*)$/)
  if (!parts) return false
  const cmdName = parts[1].toLowerCase()
  const args = parts[2] || ''
  const cmd = slashCommands.find((c) => c.cmd === cmdName)
  if (!cmd) {
    addSystemMessage(`未知命令: \`${cmdName}\`。输入 \`/help\` 查看可用命令。`)
    return true
  }
  cmd.run(args)
  return true
}

// ── Slash command autocomplete ──
export function showSlashPopup(filter) {
  let popup = $('slash-popup')
  if (!popup) {
    popup = document.createElement('div')
    popup.id = 'slash-popup'
    popup.className = 'slash-popup'
    // Mount on .composer so it floats above the input area
    document.querySelector('.composer').appendChild(popup)
  }
  const q = filter.toLowerCase().slice(1) // remove leading /
  _slashMatches = slashCommands.filter(
    (c) => !q || c.cmd.slice(1).includes(q) || c.desc.includes(q),
  )
  if (_slashMatches.length === 0) {
    hideSlashPopup()
    return
  }
  _slashSelected = 0
  _renderSlashPopup(popup)
  popup.hidden = false
  slashPopupVisible = true
}

function _renderSlashPopup(popup) {
  popup.innerHTML = '<div class="slash-popup-header">命令</div>'
  _slashMatches.forEach((c, i) => {
    const item = document.createElement('div')
    item.className = `slash-popup-item${i === _slashSelected ? ' active' : ''}`
    item.innerHTML = `<div class="slash-item-left"><span class="slash-cmd">${c.cmd}</span></div><span class="slash-desc">${c.desc}</span>`
    item.onmouseenter = () => {
      _slashSelected = i
      popup
        .querySelectorAll('.slash-popup-item')
        .forEach((el, j) => el.classList.toggle('active', j === i))
    }
    item.onclick = (e) => {
      e.preventDefault()
      e.stopPropagation()
      selectSlashItem(c)
    }
    popup.appendChild(item)
  })
}

export function selectSlashItem(c) {
  // For commands that take args, put cursor after the space
  // For commands that don't, execute immediately
  const noArgCmds = [
    '/help',
    '/new',
    '/clear',
    '/stop',
    '/memory',
    '/skills',
    '/persona',
    '/tasks',
    '/theme',
    '/config',
  ]
  if (noArgCmds.includes(c.cmd)) {
    $('input').value = c.cmd
    hideSlashPopup()
    _deps.send()
  } else {
    $('input').value = `${c.cmd} `
    $('input').focus()
    hideSlashPopup()
  }
}

export function hideSlashPopup() {
  const popup = $('slash-popup')
  if (popup) popup.hidden = true
  slashPopupVisible = false
  _slashMatches = []
}
