import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import {
  AUTHORITY_TTL_MS, ModelAuthorityError,
  verifyAuthority, verifyTurnLease, assertLeaseMatchesAuthority,
} from "@openclaude/protocol";
import { mintIdleUserAuthority } from "./idleAuthorityFixture.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const keyId = "idle-fixture-key";
const keyring = new Map([[keyId, publicKey.export({ type: "spki", format: "der" }).subarray(-32)]]);
const model = "box-api-claude-opus-5-5";
const start = 1_790_000_000_000;
const expired = (error: unknown) => error instanceof ModelAuthorityError && error.code === "Expired";

function validPair(pair: ReturnType<typeof mintIdleUserAuthority>, now: number, continuing = false) {
  // Egress may allow an expired short authority only AFTER verifying a live lease.
  const lease = verifyTurnLease(pair.modelAuthority.leaseEnvelope, keyring, now);
  const authority = verifyAuthority(pair.modelAuthority.authorityEnvelope, keyring, now,
    continuing ? { allowExpired: true } : undefined);
  assertLeaseMatchesAuthority(lease, authority);
  return { authority, lease };
}

test("logical new idle-fixture users get fresh signed identities after thirty minutes", () => {
  const first = mintIdleUserAuthority(privateKey, keyId, model, start);
  const later = start + 31 * 60_000;
  const second = mintIdleUserAuthority(privateKey, keyId, model, later);
  const a = validPair(first, start), b = validPair(second, later);
  assert.notEqual(a.authority.authorityTurnId, b.authority.authorityTurnId);
  assert.equal(a.authority.expiresAt - a.authority.issuedAt, AUTHORITY_TTL_MS);
  assert.equal(b.authority.expiresAt - b.authority.issuedAt, AUTHORITY_TTL_MS);
  assert.equal(b.lease.expiresAt - later, 30 * 60_000);
  assert.equal(b.lease.issuedAt, later - 60_000);
  assert.deepEqual(a.authority.executionDescriptor, b.authority.executionDescriptor);
  assert.equal(a.authority.executionRevision, b.authority.executionRevision);
  assert.equal(a.authority.securityEpoch, b.authority.securityEpoch);
  assert.deepEqual(second.record, {
    authorityTurnId: b.authority.authorityTurnId, issuedAt: later,
    expiresAt: later + AUTHORITY_TTL_MS, leaseIssuedAt: later - 60_000,
    leaseExpiresAt: later + 30 * 60_000,
  });
});

test("an already-admitted long turn keeps its short expired authority and live matching lease", () => {
  const pair = mintIdleUserAuthority(privateKey, keyId, model, start);
  const now = start + 3 * 60_000;
  assert.throws(() => verifyAuthority(pair.modelAuthority.authorityEnvelope, keyring, now), expired);
  const { authority, lease } = validPair(pair, now, true);
  assert.equal(authority.authorityTurnId, pair.record.authorityTurnId);
  assert.equal(lease.authorityTurnId, pair.record.authorityTurnId);
});

test("an actually expired old pair is rejected even as a continuation", () => {
  const pair = mintIdleUserAuthority(privateKey, keyId, model, start);
  const now = start + 31 * 60_000;
  assert.throws(() => verifyAuthority(pair.modelAuthority.authorityEnvelope, keyring, now), expired);
  assert.throws(() => validPair(pair, now, true), expired);
});

test("separately valid fresh signatures from different user turns cannot be paired", () => {
  const first = mintIdleUserAuthority(privateKey, keyId, model, start);
  const second = mintIdleUserAuthority(privateKey, keyId, model, start);
  const a = validPair(first, start), b = validPair(second, start);
  assert.throws(() => assertLeaseMatchesAuthority(a.lease, b.authority),
    (error: unknown) => error instanceof ModelAuthorityError && error.code === "LeaseMismatch");
});
