import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
test('CLI exporter uses private relay ID and emits only allowlisted metadata, read-only', () => {
  const script = String.raw`
import pathlib, tempfile, sqlite3, runpy, json
module = runpy.run_path('scripts/ocv5-496/export-codex-http-timing.py')
with tempfile.TemporaryDirectory() as root:
 p=pathlib.Path(root)/'logs.sqlite';db=sqlite3.connect(p)
 db.execute('CREATE TABLE logs(id,ts,ts_nanos,thread_id,process_uuid,feedback_log_body,target)')
 tid='01a14d2c-88d4-7861-b1ce-5e1205d65075'
 proc='pid:121:be1c7c2d-81bc-42c2-ac6b-1228fb08a4ab'
 headers={'x-request-id':'b'*32,'x-openclaude-relay-request-id':'a'*32,'authorization':'PRIVATE_KEY'}
 body='Request completed transport=responses_http method=POST status=200 turn_id='+tid+' headers='+json.dumps(headers)+' PRIVATE_BODY'
 db.execute('INSERT INTO logs VALUES(1,10,7,?,?,?,?)',(tid,proc,body,'codex_http_client::client'))
 db.execute('INSERT INTO logs VALUES(2,11,8,NULL,?,?,?)',(proc,'Request completed method=GET status=200 url="http://user:PRIVATE_AUTH@localhost/v1/models?token=PRIVATE_QUERY" headers='+json.dumps(headers),'codex_http_client::client'))
 db.commit();before=p.read_bytes();db.close()
 result=list(module['export_metadata'](p,0))
 assert p.read_bytes()==before
 assert len(result)==2 and all(r['requestId']=='a'*32 and r['correlationSource']=='private' for r in result)
 assert result[1]['threadId'] is None and result[1]['operation']=='models'
 assert all(r['processUuid']==proc for r in result)
 assert 'PRIVATE' not in json.dumps(result)
 print(json.dumps(result))
`
  const rows = JSON.parse(execFileSync('python3', ['-c', script], { encoding: 'utf8' }))
  assert.equal(rows.length, 2)
  assert.equal(rows[0].timestampNs, '10000000007')
  assert.equal(rows[1].timestampNs, '11000000008')
})
