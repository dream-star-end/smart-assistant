import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { resolveUserTimeZoneEnv, resolveV5LocalCcbTransportEnv } from "../agent-sandbox/v3supervisor.js";

describe("resolveV5LocalCcbTransportEnv", () => {
  test("is a zero-change default", () => {
    assert.deepEqual(
      resolveV5LocalCcbTransportEnv({
        runtimeChannel: "v5",
        useRemote: false,
        hostGatewayIp: "172.31.0.1",
      }),
      [],
    );
  });

  test("injects a credential-free HTTPS proxy and internal bypass without OPENCLAUDE_CCB_TZ", () => {
    assert.deepEqual(
      resolveV5LocalCcbTransportEnv({
        runtimeChannel: "v5",
        useRemote: false,
        hostGatewayIp: "172.31.0.1",
        proxyUrl: "http://172.31.0.1:18991/",
        noProxy: "localhost,10.0.0.0/8",
      }),
      [
        "OPENCLAUDE_CCB_HTTPS_PROXY=http://172.31.0.1:18991",
        "OPENCLAUDE_CCB_NO_PROXY=localhost,10.0.0.0/8,127.0.0.1,::1,172.31.0.1",
      ],
    );
  });

  test("never projects a selfhost-local listener into v3 or remote containers", () => {
    for (const input of [
      { runtimeChannel: "v3" as const, useRemote: false },
      { runtimeChannel: "v5" as const, useRemote: true },
    ]) {
      assert.deepEqual(
        resolveV5LocalCcbTransportEnv({
          ...input,
          hostGatewayIp: "172.31.0.1",
          proxyUrl: "not-a-url",
        }),
        [],
      );
    }
  });

  test("fails closed on proxy credentials", () => {
    assert.throws(
      () =>
        resolveV5LocalCcbTransportEnv({
          runtimeChannel: "v5",
          useRemote: false,
          hostGatewayIp: "172.31.0.1",
          proxyUrl: "http://user:pass@172.31.0.1:18991",
        }),
      /credential-free/,
    );
  });
});

describe("resolveUserTimeZoneEnv (OCV5-166 / OCV5-754 unified OC_USER_TZ)", () => {
  test("passes a valid IANA zone through as OC_USER_TZ", () => {
    assert.deepEqual(resolveUserTimeZoneEnv("Asia/Shanghai"), ["OC_USER_TZ=Asia/Shanghai"]);
    assert.deepEqual(resolveUserTimeZoneEnv(" America/New_York "), ["OC_USER_TZ=America/New_York"]);
  });

  test("injects nothing for absent, blank, invalid or shell-unsafe values (never throws)", () => {
    for (const bad of [undefined, "", "   ", "Not/AZone", "Asia/Shanghai; id", "x".repeat(65)]) {
      assert.deepEqual(resolveUserTimeZoneEnv(bad), [], String(bad));
    }
  });

  test("transport env emits neither OPENCLAUDE_CCB_TZ nor OC_USER_TZ", () => {
    const egress = resolveV5LocalCcbTransportEnv({
      runtimeChannel: "v5",
      useRemote: false,
      hostGatewayIp: "172.31.0.1",
      proxyUrl: "http://172.31.0.1:18991",
    });
    assert.ok(!egress.some((kv) => kv.startsWith("OPENCLAUDE_CCB_TZ=")));
    assert.ok(!egress.some((kv) => kv.startsWith("OC_USER_TZ=")));
  });
});
