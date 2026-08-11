import { describe, expect, it, Level, Size, TestType } from '@ohos/hypium';
import { Want } from '@kit.AbilityKit';
import { abilityDelegatorRegistry, Component, Driver, ON, Rect } from '@kit.TestKit';

const APP_BUNDLE_NAME: string = 'chat.claudeai.aurora';
const APP_MODULE_NAME: string = 'entry';
const APP_ABILITY_NAME: string = 'EntryAbility';
const UI_TIMEOUT_MS: number = 10000;

const WEB_SCREEN_ID: string = 'aurora-web-screen';
const WEB_OPEN_SETTINGS_ID: string = 'aurora-web-open-settings';
const WEB_OPEN_SESSIONS_ID: string = 'aurora-web-open-sessions';
const WORKBENCH_SCREEN_ID: string = 'aurora-workbench-screen';
const SETTINGS_SCREEN_ID: string = 'aurora-settings-screen';
const SETTINGS_SCROLL_ID: string = 'aurora-settings-scroll';
const SETTINGS_BACK_ID: string = 'aurora-settings-back';
const SETTINGS_STATUS_ABOUT_ID: string = 'aurora-settings-status-about';
const SETTINGS_RELOAD_ID: string = 'aurora-settings-reload';
const SETTINGS_BROWSER_ID: string = 'aurora-settings-browser';
const SETTINGS_SYSTEM_SHARE_ID: string = 'aurora-settings-system-share';
const SETTINGS_PRIVACY_ID: string = 'aurora-settings-privacy';
const SETTINGS_ABOUT_ID: string = 'aurora-settings-about';
const PRIVACY_SCREEN_ID: string = 'aurora-privacy-screen';
const PRIVACY_BACK_ID: string = 'aurora-privacy-back';
const ABOUT_SCREEN_ID: string = 'aurora-about-screen';
const ABOUT_BACK_ID: string = 'aurora-about-back';

async function waitForId(driver: Driver, id: string): Promise<Component> {
  try {
    return await driver.waitForComponent(ON.id(id), UI_TIMEOUT_MS);
  } catch (_) {
    throw new Error('Missing stable native component id: ' + id);
  }
}

async function assertVisible(component: Component, id: string): Promise<void> {
  try {
    const bounds: Rect = await component.getBounds();
    expect(bounds.right > bounds.left).assertTrue();
    expect(bounds.bottom > bounds.top).assertTrue();
  } catch (_) {
    throw new Error('Native component is not visible on the active surface: ' + id);
  }
}

async function assertInteractive(component: Component, id: string): Promise<void> {
  await assertVisible(component, id);
  try {
    expect(await component.isClickable()).assertTrue();
    expect(await component.isEnabled()).assertTrue();
  } catch (_) {
    throw new Error('Native component is not interactive: ' + id);
  }
}

async function hasVisibleComponent(
  driver: Driver,
  id: string,
  timeoutMs: number = 1000
): Promise<boolean> {
  try {
    const component: Component = await driver.waitForComponent(ON.id(id), timeoutMs);
    await component.getBounds();
    return true;
  } catch (_) {
    return false;
  }
}

async function waitForHiddenId(driver: Driver, id: string): Promise<void> {
  for (let attempt: number = 0; attempt < 20; attempt++) {
    if (!await hasVisibleComponent(driver, id, 100)) {
      return;
    }
    try {
      await driver.delayMs(100);
    } catch (_) {
      throw new Error('Unable to wait for native overlay transition: ' + id);
    }
  }
  throw new Error('Native component remained visible above the Web top layer: ' + id);
}

async function controllerIdentity(component: Component): Promise<string> {
  try {
    const identity: string = await component.getDescription();
    expect(identity.startsWith('aurora-ui-test-web-controller:')).assertTrue();
    return identity;
  } catch (_) {
    throw new Error('Missing deterministic test-build Web controller identity');
  }
}

async function clickById(driver: Driver, id: string): Promise<void> {
  const component: Component = await waitForId(driver, id);
  try {
    await component.click();
  } catch (_) {
    throw new Error('Unable to click stable native component id: ' + id);
  }
}

async function assertId(driver: Driver, id: string): Promise<void> {
  try {
    await driver.assertComponentExist(ON.id(id));
  } catch (_) {
    throw new Error('Missing stable native component id: ' + id);
  }
}

function appWant(): Want {
  return {
    bundleName: APP_BUNDLE_NAME,
    moduleName: APP_MODULE_NAME,
    abilityName: APP_ABILITY_NAME
  };
}

export default function workspaceUiTest(): void {
  describe('WorkspaceUi', () => {
    it(
      'launches directly into the primary conversation surface without a workbench',
      TestType.FUNCTION | Size.MEDIUMTEST | Level.LEVEL0,
      async (): Promise<void> => {
        const driver: Driver = Driver.create();
        const delegator: abilityDelegatorRegistry.AbilityDelegator =
          abilityDelegatorRegistry.getAbilityDelegator();

        await delegator.startAbility(appWant());
        const webScreen: Component = await waitForId(driver, WEB_SCREEN_ID);
        await assertVisible(webScreen, WEB_SCREEN_ID);
        const initialControllerIdentity: string = await controllerIdentity(webScreen);
        const settingsButton: Component = await waitForId(driver, WEB_OPEN_SETTINGS_ID);
        const sessionsButton: Component = await waitForId(driver, WEB_OPEN_SESSIONS_ID);
        await assertInteractive(settingsButton, WEB_OPEN_SETTINGS_ID);
        await assertInteractive(sessionsButton, WEB_OPEN_SESSIONS_ID);
        expect(await hasVisibleComponent(driver, WORKBENCH_SCREEN_ID)).assertFalse();

        await sessionsButton.click();
        await waitForHiddenId(driver, WEB_OPEN_SETTINGS_ID);
        await waitForHiddenId(driver, WEB_OPEN_SESSIONS_ID);

        await driver.pressBack();
        const restoredSettings: Component = await waitForId(driver, WEB_OPEN_SETTINGS_ID);
        const restoredSessions: Component = await waitForId(driver, WEB_OPEN_SESSIONS_ID);
        await assertInteractive(restoredSettings, WEB_OPEN_SETTINGS_ID);
        await assertInteractive(restoredSessions, WEB_OPEN_SESSIONS_ID);
        const restoredWebScreen: Component = await waitForId(driver, WEB_SCREEN_ID);
        await assertVisible(restoredWebScreen, WEB_SCREEN_ID);
        expect(await controllerIdentity(restoredWebScreen)).assertEqual(initialControllerIdentity);
      }
    );

    it(
      'covers the native settings journey when the compat shell is available',
      TestType.FUNCTION | Size.MEDIUMTEST | Level.LEVEL0,
      async (): Promise<void> => {
        const driver: Driver = Driver.create();
        const delegator: abilityDelegatorRegistry.AbilityDelegator =
          abilityDelegatorRegistry.getAbilityDelegator();

        await delegator.startAbility(appWant());
        const initialWebScreen: Component = await waitForId(driver, WEB_SCREEN_ID);
        const initialControllerIdentity: string = await controllerIdentity(initialWebScreen);
        const settingsButton: Component = await waitForId(driver, WEB_OPEN_SETTINGS_ID);
        const sessionsButton: Component = await waitForId(driver, WEB_OPEN_SESSIONS_ID);
        await assertInteractive(settingsButton, WEB_OPEN_SETTINGS_ID);
        await assertInteractive(sessionsButton, WEB_OPEN_SESSIONS_ID);
        await settingsButton.click();
        await waitForId(driver, SETTINGS_SCREEN_ID);
        await assertId(driver, SETTINGS_SCROLL_ID);
        await assertId(driver, SETTINGS_STATUS_ABOUT_ID);
        await assertId(driver, SETTINGS_RELOAD_ID);
        await assertId(driver, SETTINGS_BROWSER_ID);
        await assertId(driver, SETTINGS_SYSTEM_SHARE_ID);
        await assertId(driver, SETTINGS_PRIVACY_ID);
        await assertId(driver, SETTINGS_ABOUT_ID);

        await clickById(driver, SETTINGS_PRIVACY_ID);
        await waitForId(driver, PRIVACY_SCREEN_ID);
        await clickById(driver, PRIVACY_BACK_ID);
        await waitForId(driver, SETTINGS_SCREEN_ID);

        await clickById(driver, SETTINGS_ABOUT_ID);
        await waitForId(driver, ABOUT_SCREEN_ID);
        await clickById(driver, ABOUT_BACK_ID);
        await waitForId(driver, SETTINGS_SCREEN_ID);

        await clickById(driver, SETTINGS_STATUS_ABOUT_ID);
        await waitForId(driver, ABOUT_SCREEN_ID);
        await clickById(driver, ABOUT_BACK_ID);
        await waitForId(driver, SETTINGS_SCREEN_ID);

        await clickById(driver, SETTINGS_BACK_ID);
        const retainedWebScreen: Component = await waitForId(driver, WEB_SCREEN_ID);
        expect(await controllerIdentity(retainedWebScreen)).assertEqual(initialControllerIdentity);

        await clickById(driver, WEB_OPEN_SETTINGS_ID);
        await waitForId(driver, SETTINGS_SCREEN_ID);
        await clickById(driver, SETTINGS_RELOAD_ID);
        const reloadedWebScreen: Component = await waitForId(driver, WEB_SCREEN_ID);
        expect(await controllerIdentity(reloadedWebScreen)).assertEqual(initialControllerIdentity);
        await assertInteractive(
          await waitForId(driver, WEB_OPEN_SETTINGS_ID),
          WEB_OPEN_SETTINGS_ID
        );
      }
    );
  });
}
