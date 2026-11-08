#!/usr/bin/env python3
"""Codex-only fixed MCP v3. AF_UNIX bridge; never executes a model tool on the node."""
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import socket
import stat
import sys
MAX_FRAME = 8 * 1024 * 1024
MAX_REPLY = 163840
MAX_RESULT = 131072
MAX_ARGUMENTS = 98304
MAX_BODY = 196608
MAX_CATALOG = 1024 * 1024
TOOL_TIMEOUT = 720
SERVER = 'ocbridge'
IDENTITY = ('operationId','runId','generation','nativeThreadId','nativeTurnId','callId','rpcId','server','name','inputSha256')

def strict_json(value):
    def pairs(items):
        result = {}
        for key, val in items:
            if key in result:
                raise ValueError("duplicate")
            result[key] = val
        return result
    return json.loads(value, object_pairs_hook=pairs,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError("constant")))


def emit(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=True, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def failure(ident, code, message):
    emit({"jsonrpc": "2.0", "id": ident, "error": {"code": code, "message": message}})


def read_private(parent, name, limit):
    fd = os.open(parent / name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or info.st_nlink != 1 or info.st_mode & 0o077 or not 0 < info.st_size <= limit):
            raise ValueError("file-mode")
        with os.fdopen(fd, "rb", closefd=False) as source:
            data = source.read(limit + 1)
        if len(data) != info.st_size:
            raise ValueError("file-changed")
        return data
    finally:
        os.close(fd)


def valid_strings(value):
    if isinstance(value, str):
        value.encode('utf-8', errors='strict')
    elif isinstance(value, dict):
        for key, item in value.items():
            valid_strings(key)
            valid_strings(item)
    elif isinstance(value, list):
        for item in value:
            valid_strings(item)


SAFE_INTEGER = 2**53 - 1


def js_number(value):
    """ECMAScript Number::toString, the form the master hashes; Python repr has the same shortest digits."""
    if type(value) is int:
        if abs(value) > SAFE_INTEGER:
            raise ValueError('unsafe-integer')
        return str(value)
    if value != value or value in (float('inf'), float('-inf')):
        raise ValueError('non-finite')
    if value.is_integer() and abs(value) > SAFE_INTEGER:
        raise ValueError('unsafe-integer')  # The master cannot tell 1e21 from an integer and rejects both.
    if value == 0:
        return '0'
    text = repr(value)
    sign = '-' if text.startswith('-') else ''
    mantissa, _, exponent = text.lstrip('-').partition('e')
    whole, _, fraction = mantissa.partition('.')
    raw = whole + fraction
    lead = len(raw) - len(raw.lstrip('0'))
    digits = raw.lstrip('0').rstrip('0')
    n = len(whole) - lead + int(exponent or 0)
    k = len(digits)
    if k <= n <= 21:
        body = digits + '0' * (n - k)
    elif 0 < n <= 21:
        body = digits[:n] + '.' + digits[n:]
    elif -6 < n <= 0:
        body = '0.' + '0' * -n + digits
    else:
        e = n - 1
        body = (digits[0] + ('.' + digits[1:] if k > 1 else '') + 'e' + ('+' if e >= 0 else '-') + str(abs(e)))
    return sign + body


def canonical_text(value):
    if value is None:
        return 'null'
    if value is True or value is False:
        return 'true' if value else 'false'
    if isinstance(value, (int, float)):
        return js_number(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, list):
        return '[' + ','.join(canonical_text(item) for item in value) + ']'
    if isinstance(value, dict):
        # str order is code point order, which equals the master's UTF-8 byte order.
        return '{' + ','.join(json.dumps(key, ensure_ascii=False) + ':' + canonical_text(value[key])
                              for key in sorted(value)) + '}'
    raise ValueError('not-json')


def canonical(value):
    """The wire's canonical JSON, shared with the master (packages/gateway/src/cc5NativeTool.ts)."""
    valid_strings(value)
    return canonical_text(value).encode('utf-8')


def tool_arguments(catalog, name, args):
    if (not isinstance(name, str) or not isinstance(args, dict)
            or name not in {tool["name"] for tool in catalog["tools"]}):
        raise ValueError('invalid-tool')
    body = canonical(args)  # Recursive sort_keys; the master hashes the same form.
    if len(body) > MAX_ARGUMENTS:
        raise ValueError('invalid-tool')
    return hashlib.sha256(body).hexdigest()


def require(value):
    if not value:
        raise ValueError('CODEX_MCP_REJECTED')


def private_dir(path):
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid() and not info.st_mode & 0o077)
    require(path.resolve() == path.absolute())


def read_config(root):
    private_dir(root)
    config = strict_json(read_private(root, 'client.json', 16384))
    require(config.get('version') == 3 and config.get('engine') == 'codex')
    for key in ('operationId','runId','generation','catalogSha256'):
        require(isinstance(config.get(key), str) and 0 < len(config[key]) <= 128)
    return config


def read_catalog(root):
    config = read_config(root)
    data = read_private(root, 'tools.json', MAX_CATALOG)
    require(hashlib.sha256(data).hexdigest() == config['catalogSha256'])
    catalog = strict_json(data)
    require(isinstance(catalog, dict) and set(catalog) == {'tools'} and isinstance(catalog['tools'],list)
            and 1 <= len(catalog['tools']) <= 128)
    names = set()
    for tool in catalog['tools']:
        require(isinstance(tool,dict) and set(tool) == {'name','description','inputSchema'}
                and isinstance(tool['name'],str) and re.fullmatch(r'[A-Za-z0-9_-]{1,64}',tool['name'])
                and tool['name'] not in names and isinstance(tool['description'],str)
                and isinstance(tool['inputSchema'],dict))
        names.add(tool['name'])
    return catalog


def request_body(config, catalog, ident, params):
    require(isinstance(params,dict) and type(ident) in (str,int))
    if isinstance(ident, str): require(0 < len(ident) <= 256)
    else: require(abs(ident) <= SAFE_INTEGER)
    meta = params.get('_meta'); require(isinstance(meta,dict))
    turn = meta.get('x-codex-turn-metadata'); require(isinstance(turn,dict))
    call_id, thread_id, turn_id = meta.get('callId'), meta.get('threadId'), turn.get('turn_id')
    for value in (call_id, thread_id, turn_id):
        require(isinstance(value,str) and re.fullmatch(r'[A-Za-z0-9._:-]{1,256}',value))
    name, args = params.get('name'), params.get('arguments')
    digest = tool_arguments(catalog,name,args)
    return {'version':3,'engine':'codex', 'operationId':config['operationId'],'runId':config['runId'],
            'generation':config['generation'], 'nativeThreadId':thread_id, 'nativeTurnId':turn_id,
            'callId':call_id, 'rpcId':ident, 'server':SERVER, 'name':name,'arguments':args,'inputSha256':digest}


def validate_request(body, config, catalog):
    require(isinstance(body,dict) and set(body) == set(IDENTITY) | {'version','engine','arguments'})
    params = {'name':body['name'],'arguments':body['arguments'],'_meta':{
        'callId':body['callId'],'threadId':body['nativeThreadId'],
        'x-codex-turn-metadata':{'turn_id':body['nativeTurnId']}}}
    require(canonical(request_body(config,catalog,body['rpcId'],params)) == canonical(body))


def validate_response(value, body):
    required = set(IDENTITY) | {'version','engine','ok','result'}
    require(isinstance(value,dict) and required <= set(value) <= required | {'receipt'}
            and value['version'] == 3 and value['engine'] == 'codex' and value['ok'] is True)
    for key in IDENTITY:
        require(type(value[key]) is type(body[key]) and value[key] == body[key])
    result = value['result']
    require(isinstance(result,dict) and set(result)=={'content','isError'} and type(result['isError']) is bool
            and isinstance(result['content'],list) and all(isinstance(x,dict) and isinstance(x.get('type'),str)
                                                        for x in result['content'])
            and len(canonical(result)) <= MAX_RESULT)
    return result


def call_tool(root, body):
    require(not (root/'STOPPING.json').exists())
    path = root/'tool.sock'; info=path.lstat()
    require(stat.S_ISSOCK(info.st_mode) and info.st_uid==os.getuid() and not info.st_mode & 0o077)
    data=canonical(body); require(len(data)<=MAX_BODY)
    connection=http.client.HTTPConnection('localhost',timeout=TOOL_TIMEOUT)
    connection.sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM); connection.sock.settimeout(TOOL_TIMEOUT)
    try:
        connection.sock.connect(str(path))
        connection.request('POST','/roundtrip',body=data,headers={'Content-Type':'application/json','Connection':'close'})
        response=connection.getresponse(); data=response.read(MAX_REPLY+1)
        require(response.status==200 and len(data)<=MAX_REPLY)
        return validate_response(strict_json(data),body)
    finally: connection.close()


def main():
    require(len(sys.argv)==2)
    root=Path(sys.argv[1]); config=read_config(root); catalog=read_catalog(root)
    seen=set(); calls=set()
    while True:
        line=sys.stdin.buffer.readline(MAX_FRAME+1)
        if not line: return 0
        require(len(line)<=MAX_FRAME and line.endswith(b'\n'))
        request=strict_json(line); require(isinstance(request,dict))
        ident,method=request.get('id'),request.get('method')
        if ident is None: continue
        require(type(ident) in (str,int) and isinstance(method,str))
        key=(type(ident),ident); require(key not in seen and len(seen)<10000); seen.add(key)
        if method=='initialize':
            result={'protocolVersion':request.get('params',{}).get('protocolVersion','2025-06-18'),
                    'capabilities':{'tools':{}},'serverInfo':{'name':'oc-codex-fixed','version':'3'}}
        elif method=='tools/list': result=catalog
        elif method in ('ping','resources/list','resources/templates/list'):
            result={'resources':[]} if method=='resources/list' else {'resourceTemplates':[]} if method=='resources/templates/list' else {}
        elif method=='tools/call':
            try:
                body=request_body(config,catalog,ident,request.get('params'))
                require(body['callId'] not in calls); calls.add(body['callId'])
                result=call_tool(root,body)
            except (ValueError,OSError,http.client.HTTPException):
                failure(ident,-32000,'Tool delivery unknown or rejected; never retry'); return 1
        else:
            failure(ident,-32601,'Method not found'); continue
        emit({'jsonrpc':'2.0','id':ident,'result':result})

if __name__=='__main__':
    try: sys.exit(main())
    except (ValueError,OSError,KeyError,TypeError,RecursionError):
        sys.stderr.write('CODEX_FIXED_MCP_REJECTED\n'); sys.exit(126)
