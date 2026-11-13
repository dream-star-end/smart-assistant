#!/usr/bin/python3
"""Admin authenticated live commissioning client; run never sets readiness.
Token file: current uid3 admin access JWT (0600); no password or signing key accepted.
"""
import argparse,json,os,pathlib,stat,urllib.request,urllib.parse

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--url',required=True);p.add_argument('--token-file',required=True)
    sub=p.add_subparsers(dest='command',required=True)
    r=sub.add_parser('run');r.add_argument('--profile-id',required=True)
    for name in ['status','artifact','apply','revoke']:
        c=sub.add_parser(name);c.add_argument('--run-id',required=True)
        if name in ['apply','revoke']:c.add_argument('--sha256',required=True);c.add_argument('--confirm',action='store_true',required=True)
    a=p.parse_args();url=urllib.parse.urlsplit(a.url)
    if url.username or url.password or url.query or url.fragment or not(url.scheme=='https' or url.scheme=='http' and url.hostname in ['127.0.0.1','localhost','::1']):p.error('HTTPS or loopback HTTP required')
    path=pathlib.Path(a.token_file);s=path.lstat()
    if not stat.S_ISREG(s.st_mode) or s.st_uid!=os.getuid() or s.st_mode&0o077 or s.st_nlink!=1:p.error('unsafe token file')
    token=path.read_text().strip()
    base=a.url.rstrip('/')+'/api/admin/remote-pool/codex-commissioning'
    data=None
    if a.command=='run':data={'profileId':a.profile_id}
    else:
        import re
        if not re.fullmatch('[a-f0-9-]{36}',a.run_id):p.error('invalid run id')
        base+='/'+a.run_id
        if a.command!='status':base+='/'+a.command
        if a.command in ['apply','revoke']:
            if not re.fullmatch('[a-f0-9]{64}',a.sha256):p.error('invalid sha256')
            data={'confirm':True,'e2eReceiptSha256':a.sha256}
    req=urllib.request.Request(base,data=None if data is None else json.dumps(data).encode(),headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
    # Never forward the admin credential through a redirect.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self,*args): return None
    with urllib.request.build_opener(NoRedirect).open(req,timeout=60) as response: print(json.dumps(json.load(response),indent=2,ensure_ascii=False))
if __name__=='__main__':main()
