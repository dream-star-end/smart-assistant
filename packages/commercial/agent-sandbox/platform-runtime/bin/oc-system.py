#!/usr/bin/env python3
"""Load trusted help or request scoped reads/proposals. No approval/execution command."""
import argparse
import json
import os
from pathlib import Path
import re
import stat
import sys
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener

SELF_ROOT = Path(__file__).resolve().parent.parent
GUIDES = SELF_ROOT / "prompts" / "system-assistant"
TOPICS = ('index', 'account-privacy', 'preferences', 'models', 'sessions-goals', 'projects-files', 'memory-profile', 'skills-market', 'plugins', 'schedules', 'usage-billing', 'sharing-notices', 'collaboration-media', 'organization-admin', 'tasks', 'ui-system-actions', 'ui', 'ui-preview', 'input-prediction')
MAX_BYTES = 4 * 1024 * 1024
UUID = re.compile(r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def current_context():
    path = os.environ.get('OPENCLAUDE_SYSTEM_HELP_CONTEXT_FILE', '')
    if not path or not Path(path).is_absolute():
        raise ValueError('UNAVAILABLE')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > 16384:
            raise ValueError('INVALID_CONTEXT')
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            raw = stream.read(16385)
        value = json.loads(raw)
        if not isinstance(value, dict) or set(value) != {'version', 'context', 'nonce'} or type(value['version']) is not int or value['version'] != 1 or not isinstance(value['context'], str) or not 0 < len(value['context']) <= 4096 or not isinstance(value['nonce'], str) or not UUID.fullmatch(value['nonce']):
            raise ValueError('INVALID_CONTEXT')
        return value
    finally:
        os.close(fd)


def request_help(command):
    context = current_context()
    raw_port = os.environ.get('OPENCLAUDE_GATEWAY_PORT', '')
    if not re.fullmatch(r'[1-9][0-9]{0,4}', raw_port) or not 1 <= int(raw_port) <= 65535:
        raise ValueError('UNAVAILABLE')
    body = json.dumps({'nonce': context['nonce'], 'context': context['context'], 'command': command}, ensure_ascii=False).encode('utf-8')
    if len(body) > MAX_BYTES:
        raise ValueError('INVALID_INPUT')
    req = Request('http://127.0.0.1:' + raw_port + '/api/internal/system-help', data=body, headers={'Content-Type': 'application/json'}, method='POST')
    # Proxy environment is intentionally ignored for the fixed loopback endpoint.
    from urllib.request import ProxyHandler
    with build_opener(ProxyHandler({}), NoRedirect()).open(req, timeout=25) as response:
        raw = response.read(MAX_BYTES + 1)
        if len(raw) > MAX_BYTES:
            raise ValueError('UNAVAILABLE')
        return json.loads(raw)


def arguments(options):
    if options.command in ('read', 'prepare'):
        if not re.fullmatch(r'[a-z][a-z0-9.-]{1,99}', options.operation):
            raise ValueError('INVALID_INPUT')
        if options.args_file:
            with open(options.args_file, 'rb') as stream:
                raw = stream.read(MAX_BYTES + 1)
        else:
            raw = options.args.encode('utf-8')
        if len(raw) > MAX_BYTES:
            raise ValueError('INVALID_INPUT')
        value = {'kind': options.command, 'operationId': options.operation, 'args': json.loads(raw)}
        if options.command == 'prepare':
            if not re.fullmatch(r'[A-Za-z0-9._:-]{1,128}', options.request_id):
                raise ValueError('INVALID_INPUT')
            value['idempotencyKey'] = options.request_id
        return value
    if options.command == 'result':
        if not UUID.fullmatch(options.proposal):
            raise ValueError('INVALID_INPUT')
        return {'kind': 'result', 'proposalId': options.proposal}
    value = {'kind': 'catalog', 'limit': options.limit}
    if options.after is not None:
        value['after'] = options.after
    return value


def main(argv=None):
    args = sys.argv[1:] if argv is None else argv
    parser = argparse.ArgumentParser(prog='oc-system', description='按需系统指南、只读状态与待用户确认的操作提议。')
    subparsers = parser.add_subparsers(dest='command')
    skill = subparsers.add_parser("skill", help='读取静态指南；不带topic读取总索引')
    skill.add_argument('topic', nargs='?', default='index', choices=TOPICS)
    catalog = subparsers.add_parser("catalog", help='只列出本人当前可用的固定操作')
    catalog.add_argument('--after')
    catalog.add_argument('--limit', type=int, choices=range(1, 51), default=20, metavar='1..50')
    read = subparsers.add_parser("read", help='只读状态')
    prepare = subparsers.add_parser("prepare", help='冻结提议；不执行写操作')
    for name, operation in (('read', read), ('prepare', prepare)):
        operation.add_argument('operation')
        inputs = operation.add_mutually_exclusive_group()
        inputs.add_argument('--args', default='{}', help='操作参数JSON')
        inputs.add_argument('--args-file', help='从数据文件读取JSON；不执行文件')
        if name == 'prepare':
            operation.add_argument('--request-id', required=True, help='本次提议的唯一请求标识；断流重试复用同一值')
    result = subparsers.add_parser("result", help='只读取本人提议的状态/脱敏回执')
    result.add_argument('proposal')
    if not args or args == ['help']:
        parser.print_help()
        return 0
    options = parser.parse_args(args)
    if options.command == 'skill':
        path = GUIDES / ('SKILL.md' if options.topic == 'index' else 'references/' + options.topic + '.md')
        if path.is_symlink() or not path.resolve().is_relative_to(GUIDES.resolve()):
            parser.error('指南路径不受信')
        try:
            text = path.read_text(encoding='utf-8')
        except OSError:
            parser.exit(1, '系统指南暂不可用，请使用现有界面或稍后重试。\n')
        sys.stdout.write(text)
        return 0
    try:
        value = request_help(arguments(options))
        if options.command == 'prepare' and isinstance(value, dict) and isinstance(value.get('id'), str) and UUID.fullmatch(value['id']):
            value = {'proposal': value, 'reference': {'type': 'system_action', 'proposalId': value['id']}}
        print(json.dumps(value, ensure_ascii=False))
        return 0
    except HTTPError as error:
        code = 'UNAVAILABLE' if error.code >= 500 else 'CONTEXT_OR_OPERATION_REJECTED'
    except (OSError, URLError, ValueError, TypeError, KeyError):
        code = 'CONTEXT_OR_OPERATION_UNAVAILABLE'
    print(json.dumps({'error': {'code': code, 'message': '系统帮助未完成；请重新读取状态。写操作必须经用户确认，不能改用旧工具绕过。'}}, ensure_ascii=False), file=sys.stderr)
    return 1


if __name__ == '__main__':
    raise SystemExit(main())
