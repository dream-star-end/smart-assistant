# Reuse setup ONLY (no old preflight matrix) under its exact try/finally.
import copy
er = runtime('enabled-writer', enabled)
(root / 'scripts/deploy-v5-selfhost.sh').write_text(original_deploy)
data = root / 'retained-volume'; data.mkdir()
volume = {'Name': 'oc-v5-data-u3', 'Driver': 'local', 'Scope': 'local',
          'Options': None, 'Mountpoint': str(data)}
inv = pf.inventory
container = {'Id': 'a' * 64, 'Name': '/oc-v5-u3', 'Image': image_id,
    'Config': {'Labels': {inv.CHANNEL: 'v5', inv.MANAGED: '1', inv.UID: '3',
                         'com.openclaude.runtime.release': lr.name,
                         'com.openclaude.runtime.image_id': image_id},
               'User': '1000:1000', 'Env': ['HOME=/home/agent', 'PRIVATE_SECRET=never-return-this'],
               'Entrypoint': ['/private/synthetic-entrypoint'], 'Cmd': None, 'WorkingDir': '/opt/openclaude'},
    'HostConfig': {'RestartPolicy': {'Name': 'no'}},
    'Mounts': [{'Type': 'volume', 'Name': volume['Name'], 'Source': str(data),
                'Destination': inv.DATA_TARGET, 'RW': True},
               {'Type': 'bind', 'Source': str(lr), 'Destination': '/opt/openclaude', 'RW': False},
               {'Type': 'bind', 'Source': str(root / 'baseline.md'), 'Destination': '/opt/openclaude/AGENTS.md', 'RW': False}],
    'State': {'Status': 'running', 'Pid': 123, 'StartedAt': '2026-01-01T00:00:00Z'}}
(root / 'baseline.md').write_text('private non-executable baseline\n')
image_config = {'Entrypoint': ['/private/synthetic-entrypoint'], 'Cmd': None, 'WorkingDir': '/opt/openclaude'}
container_reads = 0
race = False
def writer_transport(argv, deadline):
    global container_reads
    if argv[:4] == ['/usr/bin/docker', '--host=unix:///var/run/docker.sock', 'container', 'inspect']:
        assert argv[4:] == [container['Id']]
        value = copy.deepcopy(container); container_reads += 1
        if race and container_reads > 1: value['State']['StartedAt'] = '2026-02-01T00:00:00Z'
        return json.dumps([value]).encode()
    if argv[:4] == ['/usr/bin/docker', '--host=unix:///var/run/docker.sock', 'image', 'inspect'] and len(argv) == 5:
        assert argv[4] == container['Image']
        return json.dumps([{'Id': container['Image'], 'Config': image_config}]).encode()
    return transport(argv, deadline)
mod._run = writer_transport
inv.capture_local = lambda paths, deadline: inv.collect([volume], [container], paths)
def source(path):
    container['Mounts'][1]['Source'] = str(path)
    container['Config']['Labels']['com.openclaude.runtime.release'] = path.name
def safe():
    value = check(joint=True)
    assert value['status'] == 'compatible_snapshot' and value['required'] == 1
    return value

safe()
projected = inv.collect([volume], [container], [str(root / 'master.db')])
assert 'never-return-this' not in json.dumps(projected)
assert projected['writers'][0]['runtime']['mounts'][0]['Source'] == str(lr)
out['cases'].append('mounted-writer-real-digest-and-image-id-bound-without-secret')

source(er)
value = check(joint=True)
assert value['status'] == 'incompatible' and value['required'] == 2, 'live enabled writer must reject empty legacy fallback'
out['cases'].append('stale-enabled-writer-forces-floor2-before-first-database-write')

container['Config']['Labels']['com.openclaude.runtime.release'] = lr.name
refused(lambda: check(joint=True), 'label-cannot-lie-about-actual-source-mount')
source(lr)
container['Mounts'][1]['RW'] = True
refused(lambda: check(joint=True), 'writable-runtime-source-refused')
container['Mounts'][1]['RW'] = False
overlay = {'Type': 'bind', 'Source': str(root), 'Destination': '/opt/openclaude/packages/storage', 'RW': False}
container['Mounts'].append(overlay)
refused(lambda: check(joint=True), 'source-code-shadow-mount-cannot-inherit-capability')
container['Mounts'].pop()

other_image = 'sha256:' + '2' * 64
container['Image'] = other_image
container['Config']['Labels']['com.openclaude.runtime.image_id'] = other_image
safe()
out['cases'].append('actual-stale-image-id-not-desired-master-tag')
container['Config']['Labels']['com.openclaude.runtime.image_id'] = image_id
refused(lambda: check(joint=True), 'container-image-label-must-match-actual-id')
container['Image'] = image_id

container['Config']['Cmd'] = ['untrusted-command']
refused(lambda: check(joint=True), 'overridden-launch-does-not-inherit-image-proof')
container['Config']['Cmd'] = None
race = True; container_reads = 0
refused(lambda: check(joint=True), 'container-restart-during-artifact-check-refused')
race = False

mount = container['Mounts'].pop(1)
container['Config']['Labels'].pop('com.openclaude.runtime.release')
refused(lambda: check(joint=True), 'embedded-without-immutable-source-adapter-still-unknown')
container['Mounts'].insert(1, mount); source(lr)

# Even a stopped retained container remains part of the explicit context;
# this is not proof that its cgroup is empty or permission to restart it.
container['State'].update(Status='exited', Pid=0)
safe()
out['cases'].append('stopped-retained-writer-source-still-validated-not-death-proof')
assert ctl('show', name, '--property=MainPID', '--value').strip() == '0'
out['consumerStarts'] = 0
