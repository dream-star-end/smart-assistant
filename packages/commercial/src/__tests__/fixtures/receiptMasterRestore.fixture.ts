import { loadFullLog } from '../../../../../claude-code-best/src/utils/sessionStorage.js';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const mode = process.argv[3] || 'normal', ingested = mode === 'ingested';
const dir = process.argv[2];
const e = JSON.parse(readFileSync(join(dir, 'container-evidence.json'), 'utf8'));
assert.equal(e.executions, 1);
assert.equal(e.mainRequests, ingested ? 2 : 3);
assert.equal(e.callbackModels, ingested ? 0 : 1);
assert.equal(e.rows.length, 1);
assert.equal(e.rows[0].state, ingested ? 'ingested' : 'notified');
assert.equal(e.rows[0].native_tool_use_id, 'd13_real_creator');
const id = e.sessions[0].ccbSessionId, projects = join(dir, 'native/projects');
const files = readdirSync(projects).flatMap(p => readdirSync(join(projects, p)).filter(f => f === id + '.jsonl').map(f => join(projects, p, f)));
assert.equal(files.length, 1);
const restored = await loadFullLog({ isLite: true, sessionId: id, fullPath: files[0], messages: [], date: '', value: 0, created: new Date(), modified: new Date(), firstPrompt: '', messageCount: 3, isSidechain: false });
const input = restored.messages.filter((m: any) => m.type === 'user' && JSON.stringify(m.message).includes('D13_REAL_CHILD_RESULT'));
assert.equal(input.length, 1, 'one durable callback user input');
if (ingested)
    assert.ok(input[0].delegateReceipt, 'actual creator receipt input');
else
    assert.equal(input[0].delegateReceipt, undefined, 'callback is not creator receipt ingestion');
const results = restored.messages.flatMap((m: any) => m.type === 'user' && Array.isArray(m.message.content) ? m.message.content.filter((c: any) => c.type === 'tool_result' && c.tool_use_id === 'd13_real_creator') : []);
assert.equal(results.length, 1);
assert.ok(!JSON.stringify(results).includes('D13_REAL_CHILD_RESULT'));
assert.equal(restored.messages.filter((m: any) => m.type === 'assistant' && JSON.stringify(m.message).includes(ingested ? 'D13_PARENT_INGESTED_FINAL' : 'D13_CALLBACK_MODEL_FINAL')).length, 1);
process.stdout.write(JSON.stringify({ nativeSession: id, messages: restored.messages.length, creatorReceiptInputs: ingested ? 1 : 0, callbackInputs: ingested ? 0 : input.length, finals: 1, passed: true }) + '\n');
