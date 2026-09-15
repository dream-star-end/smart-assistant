"""Real Docker payloads are private /bin/sh, not platform/model consumers.

Writer initial capability enrollment and managed-name/volume discovery are
explicit fixture seams. Every writer ID/image/PID/StartedAt/cgroup, Docker stop,
process death and final inspect is REAL. No production managed container is
selected, labeled, started or stopped. The original holder/enroll/master stop
and final original B0 remain real; this is not full D17C app/schema recovery.
"""
OC206_QUIESCE_CASES = WRITER_CASES
DOCKER = ['/usr/bin/docker','--host=unix:///var/run/docker.sock']
IMAGE = 'sha256:6ab0b6e7381779332f97b8ca76193e45b0756f38d4c0dcda72dbb3c32061ab99'
run(DOCKER+['image','inspect',IMAGE])  # Existing image only; no pull/build/install.
original_gate = gate.read_text()
original_gate = original_gate.replace("if argv[0]=='/usr/bin/docker':", "if argv[0]=='/usr/bin/docker' and argv[-1]==private['image']:")
needle = " return capture(*args,repository=private['repository'],live=private['live'],releases=private['releases'],unit_name=private['unit'])"
assert original_gate.count(needle)==1
replacement = r""" snapshot=capture(*args,repository=private['repository'],live=private['live'],releases=private['releases'],unit_name=private['unit'])
 import copy
 calls=0
 def inventory_view(databases,deadline):
  nonlocal calls
  calls+=1
  volumes=[];containers=[]
  for index,cid in enumerate(private['dockerIds']):
   actual=pf._inspect('container',cid,deadline)
   view=copy.deepcopy(actual)
   uid=str(700000001+index)
   volume='oc-v5-data-u'+uid
   data=[m for m in view['Mounts'] if m['Destination']=='/home/agent/.openclaude']
   assert len(data)==1 and data[0]['Type']=='bind'
   volumes.append({'Name':volume,'Driver':'local','Scope':'local','Options':{},'Mountpoint':data[0]['Source']})
   data[0].update(Type='volume',Name=volume)
   view['Name']='/oc-v5-u'+uid
   view['Config']['Labels'].update({'com.openclaude.runtime_channel':'v5','com.openclaude.v3.managed':'1','com.openclaude.v3.uid':uid})
   containers.append(view)
  if calls>1 and os.environ['SCENARIO']=='new-root':
   volumes.append({'Name':'oc-v5-data-u700000099','Driver':'local','Scope':'local','Options':{},'Mountpoint':private['extraRoot']})
  return pf.inventory.collect(volumes,containers,databases)
 pf.inventory.capture_local=inventory_view
 snapshot['inventory']=inventory_view([snapshot['current']['unit']['projection']['database'],snapshot['candidate']['unit']['projection']['database']],__import__('time').monotonic()+30)
 snapshot['writers']=[{'writer':w,'launch':pf._image_launch(pf._inspect('image',w['image'],__import__('time').monotonic()+30)), 'code':snapshot['current']['code']} for w in snapshot['inventory']['writers']]
 return snapshot"""
gate.write_text(original_gate.replace(needle,replacement))

for mode in OC206_QUIESCE_CASES:
    case=root/mode;case.mkdir()
    extra=case/'extra-root';extra.mkdir()
    name='oc-206-startguard-test-'+uuid.uuid4().hex+'.service'
    unit=Path('/run/systemd/system')/name;names.append((unit,name))
    text=template(root/'home-legacy',env_file)
    text+='Environment=PRIVATE_WORKER='+str(worker)+'\nEnvironment=PRIVATE_CASE='+str(case)+'\n'
    unit.write_text(text);ctl('daemon-reload');ctl('start',name)
    cgroup_handles.append(pf.cgroups.PinnedCgroup(ctl('show',name,'--property=ControlGroup','--value')))
    until=time.monotonic()+5
    while not (case/'writer.pid').exists() and time.monotonic()<until:time.sleep(.02)
    assert (case/'writer.pid').exists()
    pidfds.append(os.pidfd_open(int((case/'writer.pid').read_text())))
    ids=[];data_dirs=[]
    for index in range(2 if mode=='running' else 1):
        data=case/('data-'+str(index));data.mkdir();os.chown(data,1000,1000)
        cname='oc-206-writer-test-'+uuid.uuid4().hex;private_containers.append(cname)
        shell="trap 'exit 0' TERM; (while :; do printf x >> /home/agent/.openclaude/ticks; sleep .03; done) & wait"
        cid=run(DOCKER+['run','--detach','--pull=never','--name',cname,'--network','none','--read-only',
            '--user','1000:1000','--cap-drop','ALL','--security-opt','no-new-privileges','--restart=no',
            '--mount','type=bind,source='+str(data)+',destination=/home/agent/.openclaude',
            '--entrypoint','/bin/sh',IMAGE,'-c',shell])
        assert len(cid)==64;ids.append(cid);data_dirs.append(data)
        info=json.loads(run(DOCKER+['container','inspect',cid]))[0]
        cgroup=Path('/proc/'+str(info['State']['Pid'])+'/cgroup').read_text().strip().removeprefix('0::')
        held=pf.cgroups.PinnedCgroup(cgroup);private_groups.append((cid,held))
        until=time.monotonic()+5
        while not (data/'ticks').exists() and time.monotonic()<until:time.sleep(.02)
        assert (data/'ticks').stat().st_size>0,'real private container payload did not write'
    if mode=='already-exited':
        run(DOCKER+['container','stop','--time','2',ids[0]])
    context={'repository':str(repo),'live':str(live),'releases':str(root),'unit':name,'image':image,'image_id':image_id,
             'dockerIds':ids,'extraRoot':str(extra)}
    env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','PRIVATE_ROOT':str(root),'PRIVATE_CASE':str(case),
         'PRIVATE_GATE':str(gate),'PRIVATE_RUNTIME':str(cr),'PRIVATE_CANDIDATE':str(cm),
         'PRIVATE_CONTEXT':json.dumps(context),'SCENARIO':mode,
         'SURVIVOR_STATE':str(case/'legacy.state'),'SURVIVOR_CONSUMER_STATE':str(case/'consumer.state')}
    result=subprocess.run(['/bin/bash',str(driver)],env=env,capture_output=True,text=True,timeout=75)
    (case/'driver.log').write_text(result.stdout+result.stderr)
    assert (case/'consumer.state').exists(), 'enrollment failed before writer barrier: '+result.stdout+result.stderr
    record=pf.artifacts.state.read(str(case/'consumer.state'))
    states=[json.loads(run(DOCKER+['container','inspect',cid]))[0]['State'] for cid in ids]
    if mode=='running':
        # BEFORE phase/result assertions, so virtual missing call is a real
        # live Docker writer business failure, not only a text/phase mismatch.
        assert all(not s['Running'] and s['Pid']==0 for s in states),'original caller left a private Docker writer running'
        assert result.returncode==0,result.stdout+result.stderr
        assert record['phase']=='consumer-writers-stopped' and record['consumer_phase']=='quiescing'
        sizes=[(d/'ticks').stat().st_size for d in data_dirs];time.sleep(.1)
        assert sizes==[(d/'ticks').stat().st_size for d in data_dirs],'child writes continued after all-writer barrier'
        out['cases'].append('original-enroll-stops-two-real-Docker-subtrees-and-retakes-B0')
    else:
        assert result.returncode!=0 and not (case/'proceeded').exists(),result.stdout+result.stderr
        assert record['consumer_phase']=='manual' and record['phase']=='consumer-stop-failed'
        assert all(not s['Running'] for s in states)
        out['cases'].append('refuse-'+mode)
    assert ctl('show',name,'--property=MainPID','--value')=='0'
out['applicationStarts']=0
out['actualPrivateDockerContainers']=len(private_containers)
