"""One-account egress file operation. Never changes the pool, login or service."""
import json
import os
import stat
from pathlib import Path


def _safe_directory(path):
    st = os.lstat(path)
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != 0 or stat.S_IMODE(st.st_mode) != 0o700:
        raise RuntimeError('UID_DIRECTORY_UNSAFE')


def enable_box_egress(root, config_path):
    # Match the already configured dedicated selfhost listener, not a general proxy.
    config = json.loads(Path(config_path).read_text())
    inbound = [item for item in config.get('inbounds', [])
               if item.get('type') == 'mixed' and item.get('listen') == '172.31.0.1'
               and item.get('listen_port') == 18992 and not item.get('users')]
    if len(inbound) != 1:
        raise RuntimeError('DEDICATED_INBOUND_NOT_UNIQUE')
    value = ('http://' + inbound[0]['listen'] + ':' + str(inbound[0]['listen_port']) + '\n').encode()
    parent = Path(root) / 'cursor-v5-u765'
    path = parent / '.https-proxy'
    before = {'directory': parent.exists() or parent.is_symlink(),
              'file': path.exists() or path.is_symlink()}
    try:
        os.mkdir(parent, 0o700)
    except FileExistsError:
        pass
    _safe_directory(parent)
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    except FileExistsError:
        st = os.lstat(path)
        if (not stat.S_ISREG(st.st_mode) or st.st_uid != 0 or st.st_nlink != 1
                or stat.S_IMODE(st.st_mode) != 0o600):
            raise RuntimeError('UID_PROXY_UNSAFE')
        if path.read_bytes() != value:
            raise RuntimeError('UID_PROXY_ALREADY_CONFIGURED_DIFFERENTLY')
        return {'uid': 765, 'action': 'unchanged', 'before': before, 'mode': '0600'}
    try:
        os.fchown(fd, 0, 0)
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'wb', closefd=False) as stream:
            stream.write(value)
            stream.flush()
            os.fsync(fd)
    finally:
        os.close(fd)
    dirfd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(dirfd)
    finally:
        os.close(dirfd)
    return {'uid': 765, 'action': 'created', 'before': before, 'directoryMode': '0700', 'mode': '0600'}


if __name__ == '__main__':
    if os.geteuid() != 0:
        raise SystemExit('ROOT_REQUIRED')
    print(json.dumps(enable_box_egress('/etc/openclaude', '/etc/sing-box/openclaude-cursor-egress-proxy.json')))
