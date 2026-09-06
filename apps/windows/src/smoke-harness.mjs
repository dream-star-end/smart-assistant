import assert from 'node:assert/strict'

import { calculateViewBounds } from './window-layout.mjs'

export function waitForCondition(check, message, timeoutMs = 4_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    const poll = async () => {
      try {
        if (await check()) {
          resolve()
          return
        }
      } catch (error) {
        reject(error)
        return
      }
      if (Date.now() >= deadline) {
        reject(new Error(message))
        return
      }
      setTimeout(poll, 25)
    }
    void poll()
  })
}

export function waitForWebContentsEvent(webContents, eventName, timeoutMs = 4_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      webContents.removeListener(eventName, onEvent)
      reject(new Error(`timed out waiting for ${eventName}`))
    }, timeoutMs)
    const onEvent = (...args) => {
      clearTimeout(timeout)
      resolve(args)
    }
    webContents.once(eventName, onEvent)
  })
}

export async function elementCenter(webContents, selector) {
  const point = await webContents.executeJavaScript(`((selector) => {
    const element = document.querySelector(selector)
    if (!element) return null
    const bounds = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    if (
      bounds.width <= 0 ||
      bounds.height <= 0 ||
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.pointerEvents === 'none'
    ) {
      return null
    }
    return {
      x: Math.floor(bounds.left + bounds.width / 2),
      y: Math.floor(bounds.top + bounds.height / 2),
    }
  })(${JSON.stringify(selector)})`)
  assert.ok(point, `expected ${selector} to be visible and interactive`)
  return point
}

export async function focusWebContentsForInput(window, webContents, action) {
  await waitForCondition(
    async () => {
      if (!window || window.isDestroyed?.()) return false
      if (!window.isVisible()) window.show()
      window.focus()
      webContents.focus()
      await webContents.executeJavaScript(
        'new Promise((resolve) => requestAnimationFrame(resolve))',
      )
      return window.isFocused() && webContents.isFocused()
    },
    `host window and target WebContents did not acquire native focus for ${action}`,
  ).catch((error) => {
    throw new Error(
      `${error.message}; windowFocused=${window?.isFocused?.() === true}; ` +
        `webContentsFocused=${webContents.isFocused()}`,
    )
  })
}

export async function clickElementWithInput(window, webContents, selector) {
  await focusWebContentsForInput(window, webContents, `click ${selector}`)
  const point = await elementCenter(webContents, selector)
  webContents.sendInputEvent({ type: 'mouseMove', ...point })
  webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
  await new Promise((resolve) => setTimeout(resolve, 20))
  webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
  await new Promise((resolve) => setTimeout(resolve, 20))
}

export async function sendKeyWithInput(window, webContents, keyCode, modifiers = []) {
  await focusWebContentsForInput(window, webContents, `key ${keyCode}`)
  webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
  webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
}

export async function waitForViewLayout(window, shell, product, width, height, mode) {
  window.setContentSize(width, height)
  await waitForCondition(() => {
    const bounds = window.getContentBounds()
    if (bounds.width !== width || bounds.height !== height) return false
    const expected = calculateViewBounds(bounds, { shellMode: mode })
    return (
      JSON.stringify(shell.getBounds()) === JSON.stringify(expected.shell) &&
      JSON.stringify(product.getBounds()) === JSON.stringify(expected.product)
    )
  }, `child view bounds did not match ${width}x${height}`)
}
