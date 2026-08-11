import BuildProfile from 'entry/BuildProfile';
import { webview } from '@kit.ArkWeb';
import { APP_CLIENT_URL, APP_HOME_URL } from './NavigationPolicy';

export const WORKSPACE_UI_FIXTURE_URL: string =
  'https://claudeai.chat/__harmony_ui_test_v1__';
export const WORKSPACE_UI_FIXTURE_BOOTSTRAP_URL: string = 'about:blank';

const WORKSPACE_UI_FIXTURE_HTML: string = [
  '<!doctype html>',
  '<html lang="zh-CN">',
  '<head>',
  '<meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width,initial-scale=1">',
  '<style>',
  'html,body,#root{width:100%;height:100%;margin:0;background:#fff;color:#171717;',
  'font-family:system-ui,sans-serif}',
  '[data-product-entry-scope="chat-header"]{display:flex;height:52px;',
  'align-items:center;justify-content:center;gap:8px}',
  'button{min-height:40px;border:0;background:transparent;color:inherit;font:inherit}',
  'main{box-sizing:border-box;display:flex;min-height:calc(100% - 52px);',
  'flex-direction:column;align-items:center;justify-content:center;padding:24px}',
  'h1{margin:0 0 12px;font-size:24px;font-weight:600}',
  'p{margin:0;color:#737373}',
  '.fixture-overlay{position:fixed;inset:0;background:rgba(0,0,0,.35)}',
  '[data-aurora-native-dismiss]{position:fixed;z-index:1;inset:0 auto 0 0;width:72%;',
  'padding:72px 24px;background:#fff;box-sizing:border-box}',
  '</style>',
  '</head>',
  '<body>',
  '<div id="root">',
  '<header data-product-entry-scope="chat-header">',
  '<button type="button" aria-label="打开菜单">会话</button>',
  '<button type="button" data-product-feature="agents">全能助手</button>',
  '<button type="button" aria-label="选择对话模型">测试模型</button>',
  '</header>',
  '<main><h1>Aurora</h1><p>HarmonyOS 自动化测试工作面</p></main>',
  '</div>',
  '<script>',
  '(() => {',
  '  const selector = \'[data-aurora-native-dismiss="mobile-session-v1"]\';',
  '  const trigger = document.querySelector(\'button[aria-label="打开菜单"]\');',
  '  const close = () => {',
  '    const panel = document.querySelector(selector);',
  '    const overlay = document.querySelector(\'.fixture-overlay\');',
  '    if (panel instanceof HTMLElement) panel.remove();',
  '    if (overlay instanceof HTMLElement) overlay.remove();',
  '  };',
  '  if (trigger instanceof HTMLButtonElement) {',
  '    trigger.addEventListener(\'click\', () => {',
  '      if (document.querySelectorAll(selector).length !== 0) return;',
  '      const overlay = document.createElement(\'div\');',
  '      overlay.className = \'fixture-overlay\';',
  '      const panel = document.createElement(\'section\');',
  '      panel.setAttribute(\'data-aurora-native-dismiss\', \'mobile-session-v1\');',
  '      panel.setAttribute(\'data-state\', \'open\');',
  '      panel.textContent = \'会话导航\';',
  '      document.body.append(overlay, panel);',
  '    });',
  '  }',
  '  document.addEventListener(\'keydown\', (event) => {',
  '    if (event.key === \'Escape\') close();',
  '  });',
  '})();',
  '</script>',
  '</body>',
  '</html>'
].join('');

export function isWorkspaceUiFixtureBuildMode(buildMode: string): boolean {
  return buildMode === 'test';
}

const WORKSPACE_UI_FIXTURE_ENABLED: boolean =
  isWorkspaceUiFixtureBuildMode(BuildProfile.BUILD_MODE_NAME);

export const WORKSPACE_INITIAL_URL: string = WORKSPACE_UI_FIXTURE_ENABLED ?
  WORKSPACE_UI_FIXTURE_BOOTSTRAP_URL : APP_CLIENT_URL;

export function isWorkspaceUiFixtureBootstrapUrl(url: string): boolean {
  return WORKSPACE_UI_FIXTURE_ENABLED &&
    url === WORKSPACE_UI_FIXTURE_BOOTSTRAP_URL;
}

export function shouldAllowWorkspaceUiFixtureLoadUrl(url: string): boolean {
  return isWorkspaceUiFixtureBootstrapUrl(url) ||
    (WORKSPACE_UI_FIXTURE_ENABLED &&
      url.startsWith('data:text/html;charset=UTF-8;base64,'));
}

export function loadWorkspaceUiFixture(
  controller: webview.WebviewController
): boolean {
  if (!WORKSPACE_UI_FIXTURE_ENABLED) {
    return false;
  }

  try {
    controller.loadData(
      WORKSPACE_UI_FIXTURE_HTML,
      'text/html',
      'UTF-8',
      APP_HOME_URL,
      WORKSPACE_UI_FIXTURE_URL
    );
    return true;
  } catch (_) {
    return false;
  }
}

export function workspaceUiControllerDescription(controllerEpoch: number): string {
  return WORKSPACE_UI_FIXTURE_ENABLED ?
    'aurora-ui-test-web-controller:' + controllerEpoch.toString() : '';
}
