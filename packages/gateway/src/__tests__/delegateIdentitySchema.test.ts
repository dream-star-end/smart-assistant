import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import Database from 'better-sqlite3'
import { DelegateDurableDb } from '../delegateDurable.js'
import { DelegateJobStore } from '../delegateJobs.js'

test('identity schema storage fence rejects preexisting and reopened legacy connections without partial writes', () => {
  const path=join(mkdtempSync(join(tmpdir(),'delegate-identity-schema-')),'jobs.db')
  // Connection predates the migration; unlike a new-code version check the
  // trigger is enforced by SQLite for this already-open connection as well.
  const held=new Database(path), db=new DelegateDurableDb(path)
  const jobs=new DelegateJobStore({durable:db,sm:true})
  const reopened=new Database(path)
  try {
    const source=jobs.create('worker');assert.ok('jobId' in source)
    assert.equal(held.pragma('user_version',{simple:true}),10)
    const before=held.prepare('SELECT job_id,state,callback_state FROM delegate_jobs').all()
    for (const old of [held,reopened]) {
      assert.throws(()=>old.prepare("UPDATE delegate_jobs SET state='failed'").run(),/no such function: oc_delegate_schema10/)
      assert.throws(()=>old.prepare('DELETE FROM delegate_jobs').run(),/no such function: oc_delegate_schema10/)
      assert.deepEqual(old.prepare('SELECT job_id,state,callback_state FROM delegate_jobs').all(),before)
    }
    reopened.function('oc_delegate_schema10',()=>9)
    assert.throws(()=>reopened.prepare('DELETE FROM delegate_jobs').run(),/schema10 writer required/)
    const claim=jobs.snapshotOf(source.jobId)!
    assert.equal(jobs.fail(source.jobId,{failureClass:'internal',detail:'private failure',httpStatus:500,claimToken:claim.claimToken,fencingEpoch:claim.fencingEpoch}),true)
    assert.equal(jobs.snapshotOf(source.jobId)?.state,'failed','registered original writer remains functional')
  } finally {jobs.close();db.close();held.close();reopened.close()}
})
