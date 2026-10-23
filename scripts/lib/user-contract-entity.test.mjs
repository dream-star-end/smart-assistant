import test from 'node:test';
import assert from 'node:assert/strict';
import { continuationPrompts } from './user-contract.mjs';

function purchaseEntity(text) {
  const match = /采购批次 (R2-[0-9a-f-]{36}) 的第一张采购单/.exec(text);
  assert.ok(match, 'the random identifier must name the purchase entity, not just prefix a global daily order');
  return match[1];
}

test('C3 probes name independent business entities in shared agent memory', () => {
  const firstRun = continuationPrompts('ABCD1234');
  const nextRun = continuationPrompts('EFGH5678');
  const firstEntity = purchaseEntity(firstRun.first);
  assert.equal(purchaseEntity(firstRun.second), firstEntity);
  const nextEntity = purchaseEntity(nextRun.first);
  assert.equal(purchaseEntity(nextRun.second), nextEntity);
  assert.notEqual(firstEntity, nextEntity, 'repeated probes must not redefine the same shared-memory entity');
  assert.doesNotMatch(firstRun.first + firstRun.second, /今天第一张采购单/);
});

test('the random purchase code remains first-turn-only evidence', () => {
  const code = 'ABCD1234';
  const prompts = continuationPrompts(code);
  assert.equal(prompts.first.split(code).length - 1, 1);
  assert.equal(prompts.second.includes(code), false, 'turn two must retrieve the code rather than repeat its own input');
  assert.notEqual(prompts.first, prompts.second);
});
