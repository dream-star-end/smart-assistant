import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  isDesktopEntitled,
  isSimEnrollAllowed,
  readDesktopEnvFlags,
  resetDesktopFlagCache,
  setDesktopSettingsLoader,
  getDesktopFlagSnapshot,
} from "../desktop/flags.js";

describe("desktop flags", () => {
  test("env off cannot be opened by settings", async () => {
    const prev = process.env.OC_DESKTOP_VIRTUAL_CONTAINER;
    delete process.env.OC_DESKTOP_VIRTUAL_CONTAINER;
    resetDesktopFlagCache();
    setDesktopSettingsLoader(async () => ({ settingsOn: true, allowlist: [3] }));
    const snap = await getDesktopFlagSnapshot();
    assert.equal(readDesktopEnvFlags({} as NodeJS.ProcessEnv).envEnabled, false);
    assert.equal(snap.assembled, false);
    if (prev === undefined) delete process.env.OC_DESKTOP_VIRTUAL_CONTAINER;
    else process.env.OC_DESKTOP_VIRTUAL_CONTAINER = prev;
    setDesktopSettingsLoader(null);
    resetDesktopFlagCache();
  });

  test("env on + settings on => assembled; kill switch independent", async () => {
    const prev = process.env.OC_DESKTOP_VIRTUAL_CONTAINER;
    const prevK = process.env.OC_DESKTOP_KIND_KILLSWITCH;
    process.env.OC_DESKTOP_VIRTUAL_CONTAINER = "1";
    process.env.OC_DESKTOP_KIND_KILLSWITCH = "1";
    resetDesktopFlagCache();
    setDesktopSettingsLoader(async () => ({ settingsOn: true, allowlist: [3] }));
    const snap = await getDesktopFlagSnapshot();
    assert.equal(snap.assembled, true);
    assert.equal(snap.killSwitch, true);
    if (prev === undefined) delete process.env.OC_DESKTOP_VIRTUAL_CONTAINER;
    else process.env.OC_DESKTOP_VIRTUAL_CONTAINER = prev;
    if (prevK === undefined) delete process.env.OC_DESKTOP_KIND_KILLSWITCH;
    else process.env.OC_DESKTOP_KIND_KILLSWITCH = prevK;
    setDesktopSettingsLoader(null);
    resetDesktopFlagCache();
  });

  test("admin always entitled; allowlist otherwise", () => {
    assert.equal(isDesktopEntitled(9, "admin", []), true);
    assert.equal(isDesktopEntitled(9, "user", []), false);
    assert.equal(isDesktopEntitled(9, "user", [9]), true);
  });

  test("sim enroll gated", () => {
    assert.equal(isSimEnrollAllowed("windows", {}), true);
    assert.equal(isSimEnrollAllowed("sim", {}), false);
    assert.equal(isSimEnrollAllowed("sim", { OC_DESKTOP_SIM_ENROLL: "1" }), true);
    assert.equal(isSimEnrollAllowed("sim", { NODE_ENV: "test" }), true);
  });
});
