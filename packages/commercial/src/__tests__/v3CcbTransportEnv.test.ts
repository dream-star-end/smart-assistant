import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { resolveV5LocalCcbTransportEnv } from "../agent-sandbox/v3supervisor.js";

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

  test("injects a credential-free HTTPS proxy, internal bypass, and IANA timezone", () => {
    assert.deepEqual(
      resolveV5LocalCcbTransportEnv({
        runtimeChannel: "v5",
        useRemote: false,
        hostGatewayIp: "172.31.0.1",
        proxyUrl: "http://172.31.0.1:18991/",
        timezone: "Asia/Tokyo",
        noProxy: "localhost,10.0.0.0/8",
      }),
      [
        "OPENCLAUDE_CCB_HTTPS_PROXY=http://172.31.0.1:18991",
        "OPENCLAUDE_CCB_NO_PROXY=localhost,10.0.0.0/8,127.0.0.1,::1,172.31.0.1",
        "OPENCLAUDE_CCB_TZ=Asia/Tokyo",
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
          timezone: "not/a-zone",
        }),
        [],
      );
    }
  });

  test("fails closed on credentials or malformed timezones", () => {
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
    assert.throws(
      () =>
        resolveV5LocalCcbTransportEnv({
          runtimeChannel: "v5",
          useRemote: false,
          hostGatewayIp: "172.31.0.1",
          timezone: "not\/a-zone",
        }),
      /IANA timezone/,
    );
  });
});
