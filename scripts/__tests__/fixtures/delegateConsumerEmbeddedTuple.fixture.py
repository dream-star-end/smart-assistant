images = {}
for index, source_spec in [(1, legacy), (2, closed), (3, enabled)]:
    identity = 'sha256:' + str(index) * 64
    images[identity] = {'Id': identity, 'Config': {'Labels': {
        'oc.runtime.embed_source': '1', 'oc.runtime.source_commit': source_spec[0],
        'oc.runtime.features': 'v3-sink' + ((' ' + mod.kernel.CAP) if index > 1 else '')}}}
tags = {image: image_id, 'fixture/closed:immutable': 'sha256:' + '2' * 64,
        'fixture/enabled:immutable': 'sha256:' + '3' * 64}
def embedded_transport(argv, deadline):
    if argv[:4] == ['/usr/bin/docker', '--host=unix:///var/run/docker.sock', 'image', 'inspect']:
        if len(argv) == 5:
            assert argv[4] in images
            return json.dumps([images[argv[4]]]).encode()
        assert argv[4:6] == ['--format', '{{.Id}}'] and argv[6] in tags
        return (tags[argv[6]] + '\n').encode()
    return original_run(argv, deadline)
mod._run = embedded_transport
env_file.write_text(env_file.read_text().replace('OC_RUNTIME_RELEASE=' + str(lr), 'OC_RUNTIME_RELEASE='))

value = check(joint=True)
assert value['status'] == 'compatible_snapshot' and value['required'] == 1
out['cases'].append('actual-current-baked-fallback-pairs-with-closed-source-candidate')
value = check(lm)
assert value['status'] == 'compatible_snapshot'
out['cases'].append('master-only-preserves-complete-effective-baked-tuple')

def proposed(master, tag, identity):
    return pf.initial(str(master), '', tag, identity, '', time.monotonic() + 30,
                      repository=str(repo), live=str(live), releases=str(root), unit_name=name)
value = proposed(lm, image, image_id)
assert value['status'] == 'compatible_snapshot' and value['required'] == 1
out['cases'].append('explicit-joint-empty-release-is-image-bound-not-ambient-default')
value = proposed(cm, 'fixture/closed:immutable', tags['fixture/closed:immutable'])
assert value['status'] == 'compatible_snapshot' and value['required'] == 1
out['cases'].append('first-closed-c0-baked-candidate-can-retain-legacy-fallback')
value = proposed(cm, 'fixture/enabled:immutable', tags['fixture/enabled:immutable'])
assert value['status'] == 'incompatible' and value['required'] == 2
out['cases'].append('enabled-baked-candidate-cannot-use-empty-legacy-fallback')
value = proposed(cm, image, image_id)
assert value == {'status': 'incompatible', 'reason': 'unpaired_consumer'}
out['cases'].append('baked-runtime-and-master-must-still-pair')

tags[image] = tags['fixture/closed:immutable']
refused(lambda: check(lm), 'actual-tag-id-drift-refused-even-with-valid-baked-source')
tags[image] = image_id
labels = images[image_id]['Config']['Labels']
labels.pop('oc.runtime.embed_source')
refused(lambda: check(lm), 'missing-baked-source-label-never-falls-back')
labels['oc.runtime.embed_source'] = '1'
metadata = lm / 'deploy/v5/release-metadata.json'
original = metadata.read_bytes()
metadata.write_text('{"capabilities":["delegate-receipt-consumer-v2"],"runtimeCapabilities":[]}')
refused(lambda: check(lm), 'original-master-digest-and-metadata-gates-retained')
metadata.write_bytes(original)
assert ctl('show', name, '--property=MainPID', '--value').strip() == '0'
out['consumerStarts'] = 0
