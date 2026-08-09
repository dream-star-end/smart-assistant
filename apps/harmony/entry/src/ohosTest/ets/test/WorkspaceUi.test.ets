import { describe, expect, it, Level, Size, TestType } from '@ohos/hypium';
import { UIAbility, Want } from '@kit.AbilityKit';
import { abilityDelegatorRegistry, Component, Driver, ON } from '@kit.TestKit';

const APP_BUNDLE_NAME: string = 'chat.claudeai.aurora';
const APP_MODULE_NAME: string = 'entry';
const APP_ABILITY_NAME: string = 'EntryAbility';
const UI_TIMEOUT_MS: number = 10000;

const WORKBENCH_SCREEN_ID: string = 'aurora-workbench-screen';
const OPEN_SETTINGS_ID: string = 'aurora-open-settings';
const HOME_SYSTEM_SHARE_ID: string = 'aurora-home-system-share';
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
const ENTER_CONVERSATION_ID: string = 'aurora-enter-conversation';
const WEB_SCREEN_ID: string = 'aurora-web-screen';

async function waitForId(driver: Driver, id: string): Promise<Component> {
  try {
    return await driver.waitForComponent(ON.id(id), UI_TIMEOUT_MS);
  } catch (_) {
    throw new Error('Missing stable native component id: ' + id);
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

export default function workspaceUiTest(): void {
  describe('WorkspaceUi', () => {
    it(
      'covers native settings details and workspace back navigation',
      TestType.FUNCTION | Size.MEDIUMTEST | Level.LEVEL0,
      async (): Promise<void> => {
        const driver: Driver = Driver.create();
        const delegator: abilityDelegatorRegistry.AbilityDelegator =
          abilityDelegatorRegistry.getAbilityDelegator();
        const want: Want = {
          bundleName: APP_BUNDLE_NAME,
          moduleName: APP_MODULE_NAME,
          abilityName: APP_ABILITY_NAME
        };

        await delegator.startAbility(want);
        await waitForId(driver, WORKBENCH_SCREEN_ID);
        await assertId(driver, HOME_SYSTEM_SHARE_ID);

        const topAbility: UIAbility = await delegator.getCurrentTopAbility();
        expect(topAbility.context.abilityInfo.name).assertEqual(APP_ABILITY_NAME);

        await clickById(driver, OPEN_SETTINGS_ID);
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
        await waitForId(driver, WORKBENCH_SCREEN_ID);

        await clickById(driver, ENTER_CONVERSATION_ID);
        await waitForId(driver, WEB_SCREEN_ID);

        await driver.pressBack();
        await waitForId(driver, WORKBENCH_SCREEN_ID);

        await clickById(driver, OPEN_SETTINGS_ID);
        await waitForId(driver, SETTINGS_SCREEN_ID);
        await clickById(driver, SETTINGS_RELOAD_ID);
        await waitForId(driver, WEB_SCREEN_ID);

        await driver.pressBack();
        await waitForId(driver, WORKBENCH_SCREEN_ID);
      }
    );
  });
}
