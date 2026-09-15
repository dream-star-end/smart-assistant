# Docker transport remains synthetic. Actual immutable image IDs/labels are
# consumed via the ORIGINAL root adapter; no baked application/model is run.
container['Mounts'].pop(1)
container['Config']['Labels'].pop('com.openclaude.runtime.release')
image_config['Labels'] = {'oc.runtime.embed_source': '1',
                          'oc.runtime.source_commit': legacy[0],
                          'oc.runtime.features': 'v3-sink'}
labels = image_config['Labels']
safe()
out['cases'].append('explicit-baked-legacy-source-accepted-with-real-git-and-b0')

original_transport = mod._run
def changed_layer(argv, deadline):
    if argv[:4] == ['/usr/bin/docker', '--host=unix:///var/run/docker.sock', 'container', 'diff']:
        return b'C /opt/openclaude/packages/storage/receipt.js\n'
    return original_transport(argv, deadline)
mod._run = changed_layer
refused(lambda: check(joint=True), 'unchanged-image-id-cannot-hide-user-modified-baked-source')
mod._run = original_transport
container['HostConfig']['Privileged'] = True
refused(lambda: check(joint=True), 'privileged-writer-cannot-certify-immutable-source')
container['HostConfig']['Privileged'] = False

labels['oc.runtime.embed_source'] = '0'
refused(lambda: check(joint=True), 'toolchain-image-label-cannot-certify-baked-source')
labels['oc.runtime.embed_source'] = '1'

labels['oc.runtime.features'] = 'v3-sink ' + mod.kernel.CAP
refused(lambda: check(joint=True), 'feature-label-cannot-invent-git-source-capability')
labels['oc.runtime.source_commit'] = enabled[0]
value = check(joint=True)
assert value['status'] == 'incompatible' and value['required'] == 2, 'enabled baked writer must raise first-write floor'
out['cases'].append('enabled-baked-writer-refuses-empty-legacy-fallback')

labels['oc.runtime.source_commit'] = closed[0]
safe()
out['cases'].append('closed-baked-writer-matches-source-admission-not-env')
labels.pop('oc.runtime.embed_source')
refused(lambda: check(joint=True), 'missing-embed-label-is-unknown-not-legacy')
labels['oc.runtime.embed_source'] = '1'

labels['oc.runtime.source_commit'] = 'toolchain'
refused(lambda: check(joint=True), 'non-source-commit-string-refused')
labels['oc.runtime.source_commit'] = 'f' * 40
refused(lambda: check(joint=True), 'unavailable-original-source-object-refused')
labels['oc.runtime.source_commit'] = closed[0]
labels['oc.runtime.features'] = 'v3-sink delegate-receipt-consumer-v999'
refused(lambda: check(joint=True), 'unknown-consumer-version-refused-by-original-b0')
labels['oc.runtime.features'] = 'v3-sink ' + mod.kernel.CAP

before_transport = mod._run
image_reads = 0
def image_race(argv, deadline):
    global image_reads
    value = before_transport(argv, deadline)
    if argv[:4] == ['/usr/bin/docker', '--host=unix:///var/run/docker.sock', 'image', 'inspect'] and len(argv) == 5:
        image_reads += 1
        if image_reads >= 3:
            obj = json.loads(value); obj[0]['Config']['Labels']['oc.runtime.source_commit'] = legacy[0]
            return json.dumps(obj).encode()
    return value
mod._run = image_race
refused(lambda: check(joint=True), 'image-proof-drift-during-revalidation-refused')
mod._run = before_transport

container['Mounts'].append({'Type': 'bind', 'Source': str(root),
                           'Destination': '/opt/openclaude/claude-code-best', 'RW': False})
refused(lambda: check(joint=True), 'baked-code-overlay-cannot-inherit-image-capability')
assert ctl('show', name, '--property=MainPID', '--value').strip() == '0'
out['consumerStarts'] = 0
