"""Only private unit/SQLite/Git/history data; never call an actual restore.

The shell history checksum/selector and snapshot writer, PID1 effective unit,
artifact digests and B0 are real. Docker metadata is the inherited explicit
transport fixture; source declarations do not prove actual app bootstrap.
"""
previous_transport = mod._run

def transport_with_fds(argv, deadline, **kw):
    return original_run(argv, deadline, **kw) if kw else previous_transport(argv, deadline)

mod._run = transport_with_fds
private = dict(repository=str(repo), live=str(live), releases=str(root))
lib = str(root / 'scripts/v5-runtime-release-lib.sh')
snapshot = root / 'original-saga.snapshot'
# This is the ORIGINAL snapshot writer, not a hand-written verified tuple.
run(['/bin/bash', '-c', 'set -euo pipefail; source "$1"; oc_hotcfg_env_snapshot_tuple "$2" > "$3"',
     'private-saga-snapshot', lib, str(env_file), str(snapshot)])
old_env = env_file.read_text()
env_file.write_text(old_env.replace(str(lr), str(cr)))
live.unlink(); live.symlink_to(cm)
override.write_text('[Service]\n'); ctl('daemon-reload')

def current_context(master=cm):
    loaded = pf.paths._capture_effective_unit(name, time.monotonic() + 20)
    return pf.capture_context(loaded, str(master), pf.tuple_values(loaded['projection']['runtimeEnvironment']),
                              str(repo), time.monotonic() + 30)

current = current_context()
if NEGATIVE:
    pathmod = root / 'scripts/lib/delegate-consumer-unit-paths.py'
    text = pathmod.read_text()
    anchor = "if tuple_replacement is not None and item['path'] == target:"
    assert text.count(anchor) == 1
    exec(compile(text.replace(anchor, 'if False:  # virtual original restore omission'), str(pathmod), 'exec'), pf.paths.__dict__)

fallback = pf.capture_saga_fallback(current, str(lm), str(snapshot), str(env_file), time.monotonic()+30, **private)
assert fallback['tuple']['OC_RUNTIME_RELEASE'] == str(lr), 'original saga restore must not reuse current runtime'
assert fallback['code']['master']['consumer'] == fallback['code']['runtime']['consumer'] == 1
assert 'never-return-this' not in json.dumps(fallback)
out['cases'].append('original-saga-snapshot-restores-old-runtime-not-current')

archive = root / 'archive.service'
archive_env = root / 'archive-referenced.env'
archive_env.write_text(old_env + 'OPENCLAUDE_DELEGATE_JOBS_DB=' + str(root / 'archive.db') + '\n')
archive.write_text(unit_text(root / 'home-legacy').replace(str(env_file), str(archive_env)))
fallback = pf.capture_unit_fallback(current, str(lm), str(archive), time.monotonic()+30, **private)
assessment = pf.assess_fallback(current, fallback, time.monotonic()+30, repository=str(repo))
assert assessment['decision']['status'] == 'compatible_snapshot'
assert assessment['decision']['requiresQuiescence']
assert set(inventory_paths[-1]) == {str(root/'home-legacy/delegate-jobs.db'), str(root/'archive.db')}
out['cases'].append('archived-unit-actual-env-override-in-complete-B0-inventory')

# Original backup copies the unit only, not the env it references.
archive.write_text(unit_text(root / 'home-legacy'))
fallback = pf.capture_unit_fallback(current, str(lm), str(archive), time.monotonic()+30, **private)
assert fallback['tuple']['OC_RUNTIME_RELEASE'] == str(cr)
assert pf.assess_fallback(current, fallback, time.monotonic()+30, repository=str(repo))['decision']['reason'] == 'unpaired_consumer'
out['cases'].append('unit-backup-is-not-an-env-snapshot-unpaired-refused')

later = root / 'later.env'; later.write_text('OC_RUNTIME_RELEASE=' + str(cr) + '\n')
override.write_text('[Service]\nEnvironmentFile=' + str(later) + '\n'); ctl('daemon-reload')
out['multipleEnvironmentFileLines'] = len(ctl('show', name, '--property=EnvironmentFiles').splitlines())
current = current_context()
fallback = pf.capture_saga_fallback(current, str(lm), str(snapshot), str(env_file), time.monotonic()+30, **private)
assert fallback['tuple']['OC_RUNTIME_RELEASE'] == str(cr), 'later EnvironmentFile must override restored first file'
assert pf.assess_fallback(current, fallback, time.monotonic()+30, repository=str(repo))['decision']['status'] == 'incompatible'
out['cases'].append('later-effective-file-precedence-not-overwritten-by-snapshot')
override.write_text('[Service]\n'); ctl('daemon-reload'); current = current_context()

saved_snapshot = snapshot.read_text()
snapshot.write_text(saved_snapshot.replace('OC_RUNTIME_IMAGE_ID='+image_id, 'OC_RUNTIME_IMAGE_ID=<UNSET>'))
refused(lambda: pf.capture_saga_fallback(current, str(lm), str(snapshot), str(env_file), time.monotonic()+30, **private),
        'UNSET-is-delete-not-ambient-default')
snapshot.write_text(saved_snapshot+'OPENCLAUDE_HOME='+str(root)+'\n')
refused(lambda: pf.capture_saga_fallback(current, str(lm), str(snapshot), str(env_file), time.monotonic()+30, **private),
        'full-env-cannot-masquerade-as-four-key-saga-snapshot')
snapshot.write_text(saved_snapshot)

history = root / 'history'
def append(master_path, runtime_path):
    run(['/bin/bash', '-c', 'set -euo pipefail; source "$1"; oc_hotcfg_history_append "$2" "$3" "$4" "$5" "" "$6" "" joint "$7"',
         'private-original-history', lib, str(history), image, image_id, str(runtime_path), master_path, str(lm)])
append(str(lm), lr); append(cm.name, cr)
fallback = pf.capture_history_fallback(current, str(history), 2, str(env_file), time.monotonic()+30, **private)
assert fallback['code']['master']['root'] == str(lm) and fallback['tuple']['OC_RUNTIME_RELEASE'] == str(lr)
latest = pf.capture_history_fallback(current, str(history), 1, str(env_file), time.monotonic()+30, **private)
assert latest['code']['master']['root'] == str(cm)
out['cases'].append('original-checksummed-nth-history-selects-exact-master-and-tuple')

# Real original selector ignores invalid lines; never trust forged fields from
# the corrupt newest row or replace its checksum implementation in Python.
rows = history.read_text().splitlines(); record = json.loads(rows[-1]); record['image_id'] = 'sha256:'+'9'*64
history.write_text('\n'.join([rows[0], json.dumps(record)])+'\n')
selected = pf.history_selection(str(history), 1, time.monotonic()+30)
assert selected['masterRelease'] == str(lm)
out['cases'].append('corrupt-newest-row-uses-original-checksum-selection')
history.unlink(); append('', lr)
refused(lambda: pf.capture_history_fallback(current, str(history), 1, str(env_file), time.monotonic()+30, **private),
        'masterless-history-not-guessed-from-live-or-HEAD')
history.unlink(); append(str(lm), lr)

# Current admission-enabled source makes even an empty old target unsafe.
live.unlink(); live.symlink_to(em); current = current_context(em)
fallback = pf.capture_history_fallback(current, str(history), 1, str(env_file), time.monotonic()+30, **private)
assessment = pf.assess_fallback(current, fallback, time.monotonic()+30, repository=str(repo))
assert assessment['decision']['status'] == 'incompatible' and assessment['decision']['required'] == 2
out['cases'].append('enabled-current-empty-DB-still-rejects-historical-legacy')

# Change the actual root history during its original reader, not a fake hash.
original_transport = mod._run
changed = False
def mutate_history(argv, deadline, **kw):
    global changed
    result = original_transport(argv, deadline, **kw)
    if 'consumer-history' in argv and not changed:
        changed = True; history.write_text(history.read_text()+'\n')
    return result
mod._run = mutate_history
refused(lambda: pf.history_selection(str(history), 1, time.monotonic()+30), 'history-path-changed-after-pinned-read-refused')
assert changed
mod._run = original_transport

# The exact same path/tuple rules are exercised with the REAL loaded egress
# argv, not a master-shaped synthetic plan. No service payload is started.
unit_file.write_text(unit_file.read_text().replace('/usr/bin/npx tsx packages/cli/src/index.ts gateway',
                     '/usr/bin/node --import tsx packages/commercial/src/egress/main.ts'))
ctl('daemon-reload'); current = current_context(em)
archive.write_text(unit_file.read_text().replace(str(env_file), str(archive_env)))
fallback = pf.capture_unit_fallback(current, str(lm), str(archive), time.monotonic()+30, **private)
assert fallback['unit']['projection']['argv'] == ['/usr/bin/node','--import','tsx','packages/commercial/src/egress/main.ts']
assert fallback['unit']['projection']['database'] == str(root/'archive.db')
assert ctl('show', name, '--property=MainPID', '--value') == '0'
out['cases'].append('actual-PID1-egress-argv-archive-env-path-projection')
out['consumerStarts'] = 0
