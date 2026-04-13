// OpenClaude — OAuth
import { $ } from './dom.js'
import { state } from './state.js'
import { openModal, closeModal, toast } from './ui.js'

let _oauthState = null

export function openOAuthModal() {
  $('oauth-step1').hidden = false
  $('oauth-step2').hidden = true
  $('oauth-error').hidden = true
  $('oauth-code-input').value = ''
  openModal('oauth-modal')
}

export function initOAuthListeners() {
  $('oauth-start-btn').onclick = async () => {
    try {
      const oauthProvider = $('oauth-provider').value
      const r = await fetch('/api/auth/claude/start', {
        method: 'POST',
        headers: { Authorization: `Bearer ${state.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: oauthProvider }),
      })
      const data = await r.json()
      if (data.authUrl) {
        _oauthState = data.state
        window.open(data.authUrl, '_blank')
        $('oauth-code-input').focus()
        // For Codex, show extra hint about copying URL code
        if (oauthProvider === 'codex') {
          $('oauth-code-input').placeholder = '授权后从浏览器地址栏复制 code=XXX 的值...'
        } else {
          $('oauth-code-input').placeholder = '粘贴授权代码或完整回调 URL...'
        }
      } else {
        $('oauth-error').textContent = '生成授权链接失败'
        $('oauth-error').hidden = false
      }
    } catch (e) {
      $('oauth-error').textContent = `请求失败: ${e}`
      $('oauth-error').hidden = false
    }
  }
  $('oauth-submit-btn').onclick = async () => {
    let code = $('oauth-code-input').value.trim()
    if (!code) {
      $('oauth-error').textContent = '请粘贴授权代码或回调 URL'
      $('oauth-error').hidden = false
      return
    }
    if (!_oauthState) {
      $('oauth-error').textContent = '请先点击"打开授权页面"'
      $('oauth-error').hidden = false
      return
    }
    // Auto-parse: if user pasted the full callback URL, extract code from it
    if (code.includes('code=')) {
      try {
        const u = new URL(code.startsWith('http') ? code : `http://x?${code}`)
        code = u.searchParams.get('code') || code
      } catch {}
    }
    $('oauth-submit-btn').disabled = true
    $('oauth-submit-btn').textContent = '验证中...'
    $('oauth-error').hidden = true
    try {
      const r = await fetch('/api/auth/claude/callback', {
        method: 'POST',
        headers: { Authorization: `Bearer ${state.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, state: _oauthState }),
      })
      const data = await r.json()
      if (data.ok) {
        $('oauth-step1').hidden = true
        $('oauth-step2').hidden = false
        const provName = $('oauth-provider').value === 'codex' ? 'OpenAI Codex' : 'Claude.ai'
        $('oauth-result-text').textContent =
          `已连接 ${provName} · Token 有效期 ${Math.round((data.expiresIn || 3600) / 60)} 分钟`
        toast(`${provName} 登录成功!`, 'success')
        setTimeout(() => closeModal('oauth-modal'), 2000)
      } else {
        $('oauth-error').textContent = data.error || '登录失败'
        $('oauth-error').hidden = false
      }
    } catch (e) {
      $('oauth-error').textContent = `请求失败: ${e}`
      $('oauth-error').hidden = false
    } finally {
      $('oauth-submit-btn').disabled = false
      $('oauth-submit-btn').textContent = '完成登录'
    }
  }
}
