# Cleanup is independent of business failure; only exact names registered
# BEFORE creation. No production names, labels, volumes or wildcard stops.
for cname in private_containers:
    try:
        inspected=subprocess.run(['/usr/bin/docker','--host=unix:///var/run/docker.sock','container','inspect',cname],capture_output=True,text=True,timeout=10)
        if inspected.returncode==0:
            obj=json.loads(inspected.stdout)[0];cid=obj['Id'];pid=obj['State']['Pid']
            if pid and not any(x[0]==cid for x in private_groups):
                group=Path('/proc/'+str(pid)+'/cgroup').read_text().strip().removeprefix('0::')
                private_groups.append((cid,pf.cgroups.PinnedCgroup(group)))
            run(['/usr/bin/docker','--host=unix:///var/run/docker.sock','container','rm','--force',cid])
        remaining=run(['/usr/bin/docker','--host=unix:///var/run/docker.sock','container','ls','--all','--format','{{.Names}}','--filter','name=^/'+cname+'$'])
        assert not remaining,'private container cleanup incomplete'
    except BaseException as exc:cleanup_errors.append(type(exc).__name__+': private Docker '+cname)
for cid,held in private_groups:
    try:held.verify_stopped()
    except BaseException as exc:cleanup_errors.append(type(exc).__name__+': private Docker subtree '+cid)
    finally:held.close()
out['dockerCleanupComplete']=not cleanup_errors
