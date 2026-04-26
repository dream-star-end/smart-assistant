/**
 * compute-pool/master-mtls-url.ts 单测。纯函数,不依赖 process.env / DB。
 *
 * 覆盖:
 *   isPrivateIp:RFC1918 + loopback;边界(172.15 / 172.32);非法 IP / IPv6 / 主机名 → false
 *   chooseMasterMtlsUrl:internalUrl 空 → 都走 default;internalUrl 已设 + 私网 → internal;
 *                       internalUrl 已设 + 公网 → default
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  isPrivateIp,
  chooseMasterMtlsUrl,
} from "../compute-pool/master-mtls-url.js";

describe("isPrivateIp", () => {
  test("10.0.0.0/8", () => {
    assert.equal(isPrivateIp("10.0.0.1"), true);
    assert.equal(isPrivateIp("10.146.0.4"), true);
    assert.equal(isPrivateIp("10.255.255.255"), true);
  });

  test("172.16.0.0/12 — 范围内", () => {
    assert.equal(isPrivateIp("172.16.0.1"), true);
    assert.equal(isPrivateIp("172.20.5.10"), true);
    assert.equal(isPrivateIp("172.31.255.255"), true);
  });

  test("172.16.0.0/12 — 边界外", () => {
    assert.equal(isPrivateIp("172.15.0.1"), false);
    assert.equal(isPrivateIp("172.32.0.1"), false);
  });

  test("192.168.0.0/16", () => {
    assert.equal(isPrivateIp("192.168.0.1"), true);
    assert.equal(isPrivateIp("192.168.255.255"), true);
  });

  test("127.0.0.0/8 loopback", () => {
    assert.equal(isPrivateIp("127.0.0.1"), true);
    assert.equal(isPrivateIp("127.255.255.255"), true);
  });

  test("公网 IP", () => {
    assert.equal(isPrivateIp("38.55.134.227"), false); // boheyun
    assert.equal(isPrivateIp("34.146.172.239"), false); // master 外网
    assert.equal(isPrivateIp("1.2.3.4"), false);
    assert.equal(isPrivateIp("8.8.8.8"), false);
  });

  test("非法格式 / IPv6 / 主机名 → false", () => {
    assert.equal(isPrivateIp(""), false);
    assert.equal(isPrivateIp("not-an-ip"), false);
    assert.equal(isPrivateIp("master.internal"), false);
    assert.equal(isPrivateIp("::1"), false);
    assert.equal(isPrivateIp("fe80::1"), false);
    assert.equal(isPrivateIp("10.0.0"), false); // 缺一个 octet
    assert.equal(isPrivateIp("10.0.0.0.0"), false); // 多一个 octet
  });

  test("octet 范围越界 → false", () => {
    assert.equal(isPrivateIp("10.999.0.1"), false);
    assert.equal(isPrivateIp("256.0.0.1"), false);
    assert.equal(isPrivateIp("10.0.0.300"), false);
  });
});

describe("chooseMasterMtlsUrl", () => {
  const DEFAULT = "https://34.146.172.239:18443";
  const INTERNAL = "https://10.146.0.2:18443";

  test("internalUrl 空 → 私网 host 也走 default", () => {
    assert.equal(
      chooseMasterMtlsUrl({
        targetHost: "10.146.0.4",
        defaultUrl: DEFAULT,
        internalUrl: "",
      }),
      DEFAULT,
    );
  });

  test("internalUrl 已设 + 私网 host → internal", () => {
    for (const ip of ["10.146.0.4", "172.20.0.1", "192.168.1.1", "127.0.0.1"]) {
      assert.equal(
        chooseMasterMtlsUrl({
          targetHost: ip,
          defaultUrl: DEFAULT,
          internalUrl: INTERNAL,
        }),
        INTERNAL,
        `expected internal for ${ip}`,
      );
    }
  });

  test("internalUrl 已设 + 公网 host → default", () => {
    for (const ip of ["38.55.134.227", "1.2.3.4", "172.32.0.1"]) {
      assert.equal(
        chooseMasterMtlsUrl({
          targetHost: ip,
          defaultUrl: DEFAULT,
          internalUrl: INTERNAL,
        }),
        DEFAULT,
        `expected default for ${ip}`,
      );
    }
  });

  test("非法 host → fallback default", () => {
    assert.equal(
      chooseMasterMtlsUrl({
        targetHost: "not-an-ip",
        defaultUrl: DEFAULT,
        internalUrl: INTERNAL,
      }),
      DEFAULT,
    );
  });

  test("defaultUrl 空也支持(self-only / dev)", () => {
    assert.equal(
      chooseMasterMtlsUrl({
        targetHost: "1.2.3.4",
        defaultUrl: "",
        internalUrl: "",
      }),
      "",
    );
  });
});
