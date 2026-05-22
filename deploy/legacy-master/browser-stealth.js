// OpenClaude browser stealth script
// Injected via Playwright MCP --init-script to avoid bot detection
// Based on puppeteer-extra-plugin-stealth evasions

// 1. Remove webdriver flag
Object.defineProperty(navigator, 'webdriver', { get: () => false });

// 2. Mock Chrome runtime (headless Chrome lacks this)
if (!window.chrome) {
  window.chrome = {};
}
if (!window.chrome.runtime) {
  window.chrome.runtime = {};
}

// 3. Fix permissions API
const _origPermQuery = navigator.permissions?.query?.bind(navigator.permissions);
if (_origPermQuery) {
  navigator.permissions.query = (params) =>
    params.name === 'notifications'
      ? Promise.resolve({ state: Notification.permission })
      : _origPermQuery(params);
}

// 4. Mock plugins array (headless has empty plugins)
Object.defineProperty(navigator, 'plugins', {
  get: () => {
    const plugins = [
      { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
      { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '', length: 1 },
      { name: 'Native Client', filename: 'internal-nacl-plugin', description: '', length: 2 },
    ];
    plugins.refresh = () => {};
    return plugins;
  }
});

// 5. Fix languages
Object.defineProperty(navigator, 'languages', {
  get: () => ['zh-CN', 'zh', 'en-US', 'en']
});

// 6. Fix platform
Object.defineProperty(navigator, 'platform', {
  get: () => 'Win32'
});

// 7. Remove automation-related properties from window
delete window.__playwright;
delete window.__pw_manual;

// 8. Fix WebGL vendor/renderer (headless often returns "Google Inc. (Google)" which is a signal)
const _getParameter = WebGLRenderingContext.prototype.getParameter;
WebGLRenderingContext.prototype.getParameter = function (param) {
  if (param === 37445) return 'Intel Inc.';        // UNMASKED_VENDOR_WEBGL
  if (param === 37446) return 'Intel Iris OpenGL Engine'; // UNMASKED_RENDERER_WEBGL
  return _getParameter.call(this, param);
};

// 9. Fix connection.rtt (headless returns 0)
if (navigator.connection) {
  Object.defineProperty(navigator.connection, 'rtt', { get: () => 50 });
}
