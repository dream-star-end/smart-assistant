/** Synthetic SQLite crash fixture; never opens a product database. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
export function createInterruptedWal(
  filename: string,
  applicationId: number,
  version: number,
): void {
  const script = `const Database = require('better-sqlite3');
process.umask(0o077);
const db = new Database(process.argv[1]);
db.pragma('journal_mode = WAL');
db.pragma('wal_autocheckpoint = 0');
db.pragma('application_id = ' + Number(process.argv[2]));
db.pragma('user_version = ' + Number(process.argv[3]));
db.exec('CREATE TABLE synthetic_pending(value TEXT)');
db.prepare('INSERT INTO synthetic_pending VALUES(?)').run('crash-boundary');
process.kill(process.pid, 'SIGKILL');`
  const result = spawnSync(
    process.execPath,
    ['-e', script, filename, String(applicationId), String(version)],
    { timeout: 15000, encoding: 'utf8' },
  )
  assert.equal(result.error, undefined)
  assert.equal(result.signal, 'SIGKILL', result.stderr)
}
