"""Explicit opt-in root-only private file test; no service/database operations.
Host harness prepends OC206_FROZEN_UNIT_SOURCE (base64 of this checkout's module).
No test is skipped and no current production unit/env file is opened.
"""
import base64,json,os,pathlib,shutil,tempfile,time
m={};exec(compile(base64.b64decode(OC206_FROZEN_UNIT_SOURCE),'<frozen-root-input-reader>','exec'),m)
assert os.geteuid() == 0, 'explicit isolated host execution required'
root=pathlib.Path(tempfile.mkdtemp(prefix='oc-206-startguard-test-files-',dir='/run'))
out={'cases':0,'denied':0,'cleanupComplete':False};failed=None
try:
 env=root/'master.env';env.write_text('OPENCLAUDE_HOME='+str(root/'dbhome')+'\nTOKEN=synthetic-private-secret\n');unit=root/'master.service';unit.write_text('[Service]\nUser=root\nWorkingDirectory=/private/release\nEnvironmentFile='+str(env)+'\nExecStart=/usr/bin/npx tsx packages/cli/src/index.ts gateway\n')
 result=m['capture_root_files']([str(unit)],time.monotonic()+3)
 assert result['projection']['database']==str(root/'dbhome/delegate-jobs.db')
 assert len(result['inputs'])==2 and 'synthetic-private-secret' not in json.dumps(result)
 out['cases']+=1
 def deny():
  try: m['capture_root_files']([str(unit)],time.monotonic()+3)
  except m['Unknown']: out['denied']+=1; return
  raise AssertionError('root input accepted an untrusted path')
 env.chmod(0o666);deny();env.chmod(0o644)
 backup=root/'actual.env';env.rename(backup);env.symlink_to(backup);deny();env.unlink();backup.rename(env)
 root.chmod(0o777);deny();root.chmod(0o700)
 env.unlink();deny()
 unit.write_text(unit.read_text().replace('EnvironmentFile=', 'EnvironmentFile=-'))
 result=m['capture_root_files']([str(unit)],time.monotonic()+3)
 assert result['inputs'][1]['file'] is None
 out['cases']+=1
except BaseException as exc: failed=type(exc).__name__;out['failure']=failed
finally:
 root.chmod(0o700);shutil.rmtree(root);out['cleanupComplete']=not root.exists()
print(json.dumps(out));raise SystemExit(0 if not failed and out['cases']==2 and out['denied']==4 and out['cleanupComplete'] else 1)
