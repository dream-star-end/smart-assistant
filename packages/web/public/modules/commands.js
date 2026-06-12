// OpenClaude — Slash Commands
import { apiGet } from './api.js?v=85ec6dff'
// `?v=...` 必须跟 main.js / websocket.js 的 billing import 用同一版本,不然
// 浏览器把 `./billing.js` 和 `./billing.js?v=...` 当两个独立 ES module 实例,
// `_hostAgentAdmin` 模块状态不共享,admin 登录后本模块永远读到 false。
// 版本号由 scripts/deploy-v3.sh 跟其它 ?v= 一起 bump。
import { isHostAgentAdmin } from './billing.js?v=85ec6dff'
import { $, _mod } from './dom.js?v=85ec6dff'
import { getSession, state } from './state.js?v=85ec6dff'
import { toast } from './ui.js?v=85ec6dff'
import {
  addSystemMessage,
  getActiveStopAgentId,
  localStopTeardown,
  nudgeDrain,
  resetReplyTracker,
  safeWsSend,
} from './websocket.js?v=85ec6dff'

// v3 P0/P1: /memory /skills /persona /tasks are now commercial-safe for normal
// users because the master gateway proxies those APIs into the caller's own
// isolated container. Keep only truly host-scope debug commands hidden.
const HOST_SCOPED_SLASH_CMDS = new Set(['/config'])

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
      // 过滤仍然 host-scope 的调试命令,避免非 admin 从 /help 里看到。
      const hostAdmin = isHostAgentAdmin()
      const lines = ['**可用命令:**', '']
      for (const c of slashCommands) {
        if (HOST_SCOPED_SLASH_CMDS.has(c.cmd) && !hostAdmin) continue
        lines.push(`\`${c.cmd}\` — ${c.desc}`)
      }
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
        agentId: getActiveStopAgentId(sess),
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
    cmd: '/hub',
    desc: '打开 P0/P1 能力导航',
    run() {
      addSystemMessage([
        '**OpenClaude P0/P1 能力已接入当前账号容器:**',
        '',
        '- `Tool Gateway`：搜索、浏览器、图片/TTS、文献等托管工具走平台模型/工具路由；直接在聊天里要求使用对应工具即可。',
        '- `学习与自动化中心`：输入 `/memory`、`/skills`、`/tasks` 打开现代化卡片控制台。',
        '- `技能与定时任务`：技能可搜索/预览/编辑；提醒可用几分钟后、每天、每周等快捷表单创建。',
        '- `Memory`：卡片化管理 USER/MEMORY；原文模式保留精确编辑能力。',
        '- `MCP Connectors`：在聊天里说明要连接 GitHub/Notion/飞书/数据库，我会引导配置或生成安装命令。',
        '- `Goal Mode`：发送“持续执行直到……并验证……”这类目标，我会按可验证标准循环推进；需要暂停时用 `/stop`。',
        '',
        '快捷入口：`/memory` · `/skills` · `/tasks` · `/persona`',
      ].join('\n'))
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
  if (HOST_SCOPED_SLASH_CMDS.has(cmdName) && !isHostAgentAdmin()) {
    addSystemMessage(`命令 \`${cmdName}\` 在当前账号不可用。`)
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
  // host-scope 调试命令在非 admin 商用账号隐藏,跟 handleSlashCommand 拦截同一套策略。
  const hostAdmin = isHostAgentAdmin()
  _slashMatches = slashCommands.filter((c) => {
    if (HOST_SCOPED_SLASH_CMDS.has(c.cmd) && !hostAdmin) return false
    return !q || c.cmd.slice(1).includes(q) || c.desc.includes(q)
  })
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
    '/hub',
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
