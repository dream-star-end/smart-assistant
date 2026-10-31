import assert from 'node:assert/strict'
import test from 'node:test'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { deriveBoxAgentSession } from '@openclaude/protocol'

test('0332 app role can register/cancel/read exact generations but cannot mutate identity or reopen a tombstone',async () => {
  const url=process.env.TEST_DATABASE_URL ?? process.env.OCV5_289_JOURNAL_TEST_DATABASE_URL
  assert.ok(url,'migration0332 requires an explicit isolated PostgreSQL fixture')
  const address=new URL(url)
  assert.ok(['127.0.0.1','localhost','[::1]'].includes(address.hostname) && /_test$/.test(address.pathname))
  const pool=new Pool({connectionString:url,max:1})
  const client=await pool.connect()
  const schema=`scope_migration_${randomBytes(6).toString('hex')}`
  try {
    assert.match((await client.query('SELECT current_database() AS db')).rows[0].db,/_test$/)
    await client.query('BEGIN')
    await client.query(`CREATE SCHEMA ${schema}; SET LOCAL search_path=${schema}`)
    if(!(await client.query("SELECT 1 FROM pg_roles WHERE rolname='openclaude_app'")).rowCount) {
      await client.query('CREATE ROLE openclaude_app NOLOGIN') // Rolled back with this private fixture.
    }
    await client.query(`GRANT USAGE ON SCHEMA ${schema} TO openclaude_app;
      CREATE TABLE users(id BIGINT PRIMARY KEY);
      CREATE TABLE agent_containers(id BIGINT PRIMARY KEY);
      INSERT INTO users VALUES(1);INSERT INTO agent_containers VALUES(1)`)
    await client.query(await readFile(new URL('../db/migrations/0332_box_agent_api_scopes.sql',import.meta.url),'utf8'))
    const root=randomUUID()
    const scope=randomUUID()
    const session=deriveBoxAgentSession(root,'agent')
    await client.query('SET LOCAL ROLE openclaude_app')
    await client.query(`INSERT INTO box_agent_api_scopes(user_id,container_id,scope_id,root_session_id,session_id,agent_id,turn_key)
      VALUES(1,1,$1,$2,$3,'agent',$4)`,[scope,root,session,'a'.repeat(64)])
    assert.equal((await client.query('SELECT session_id::text FROM box_agent_api_scopes')).rows[0].session_id,session)
    for (const agentId of ['a','A'.repeat(256),'._:-09']) {
      await client.query(`INSERT INTO box_agent_api_scopes(user_id,container_id,scope_id,root_session_id,session_id,agent_id,turn_key)
        VALUES(1,1,$1,$2,$3,$4,$5)`,[randomUUID(),root,deriveBoxAgentSession(root,agentId),agentId,'a'.repeat(64)])
    }
    for (const agentId of ['','A'.repeat(257),'has space','has/slash','非ASCII']) {
      await client.query('SAVEPOINT invalid_scope_agent')
      await assert.rejects(client.query(`INSERT INTO box_agent_api_scopes
        (user_id,container_id,scope_id,root_session_id,session_id,agent_id,turn_key)
        VALUES(1,1,$1,$2,$3,$4,$5)`,[randomUUID(),root,randomUUID(),agentId,'a'.repeat(64)]),{code:'23514'})
      await client.query('ROLLBACK TO SAVEPOINT invalid_scope_agent')
    }
    await client.query("UPDATE box_agent_api_scopes SET cancelled_at=NOW(),cancel_reason='explicit-stop'")
    for(const sql of ["UPDATE box_agent_api_scopes SET cancelled_at=NULL,cancel_reason=NULL",
      "UPDATE box_agent_api_scopes SET agent_id='changed'",'DELETE FROM box_agent_api_scopes','TRUNCATE box_agent_api_scopes']) {
      await client.query('SAVEPOINT invalid_scope_change')
      await assert.rejects(client.query(sql))
      await client.query('ROLLBACK TO SAVEPOINT invalid_scope_change')
    }
    const metadata=JSON.parse(await readFile(new URL('../../../../deploy/v5/release-metadata.json',import.meta.url),'utf8'))
    assert.ok(metadata.requiredMigrations.includes('0332_box_agent_api_scopes'))
  } finally {
    await client.query('RESET ROLE').catch(() => {})
    await client.query('ROLLBACK').catch(() => {})
    client.release();await pool.end()
  }
})
