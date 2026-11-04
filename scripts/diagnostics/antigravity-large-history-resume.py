#!/usr/bin/env python3
"""Offline Antigravity large-native-history resume regression (Python stdlib).

Run: python3 SCRIPT --old /path/to/1.4.0 --new /path/to/1.5.0 --output DIR
Only synthetic data and a loopback Gemini stub are used. No credentials inherited.
Both resumes start from the exact same native-state snapshot and write one byte
to their isolated cwd. The old CLI must fail observation despite that write;
the candidate must expose steps and succeed without duplicating the write.
"""
import argparse
import http.server
import json
import os
from pathlib import Path
import selectors
import shutil
import signal
import sqlite3
import subprocess
import threading
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--old', required=True, type=Path)
    parser.add_argument('--new', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    opts = parser.parse_args()
    root = opts.output.resolve()
    root.mkdir(parents=True, exist_ok=False)
    home, cwd = root / 'home', root / 'cwd'
    cwd.mkdir()
    config = home / '.gemini/antigravity-cli'
    config.mkdir(parents=True)
    (config / 'settings.json').write_text('{"modelProvider":"gemini"}')
    marker = cwd / 'write-count'
    state = {'phase': 'seed', 'calls': {}, 'requests': []}

    def command_schema(value):
        if isinstance(value, dict):
            if value.get('name') == 'run_command':
                return value.get('parameters', value.get('parametersJsonSchema',
                    value.get('parameters_json_schema')))
            for child in value.values():
                found = command_schema(child)
                if found:
                    return found
        if isinstance(value, list):
            for child in value:
                found = command_schema(child)
                if found:
                    return found
        return None

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            data = self.rfile.read(int(self.headers.get('Content-Length', '0')))
            phase = state['phase']
            state['requests'].append({'phase': phase, 'path': self.path,
                                      'bytes': len(data), 'time': time.time()})
            parts = [{'text': 'PROBE_OK'}]
            if 'flash-lite' not in self.path:
                state['calls'][phase] = state['calls'].get(phase, 0) + 1
                if phase == 'seed':
                    parts = [{'text': 'x' * 800000}]
                elif state['calls'][phase] == 1:
                    spec = command_schema(json.loads(data))
                    if not spec:
                        self.send_error(500, 'run_command schema missing')
                        return
                    (root / (phase + '.schema.json')).write_text(json.dumps(spec, indent=2))
                    choices = {
                        'CommandLine': "printf x >> '" + str(marker) + "'",
                        'Cwd': str(cwd), 'WaitMsBeforeAsync': 1000,
                        'toolSummary': 'Isolated fixture write',
                        'toolAction': 'Writing fixture marker',
                    }
                    args = {k: v for k, v in choices.items() if k in spec['properties']}
                    parts = [{'functionCall': {'name': 'run_command', 'args': args}}]
            payload = {'candidates': [{'content': {'role': 'model', 'parts': parts},
                        'finishReason': 'STOP', 'index': 0}],
                       'usageMetadata': {'promptTokenCount': 10,
                        'candidatesTokenCount': 3, 'totalTokenCount': 13}}
            stream = 'streamGenerateContent' in self.path
            raw = (('data: ' + json.dumps(payload) + '\n\n') if stream
                   else json.dumps(payload)).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream' if stream else 'application/json')
            self.send_header('Content-Length', str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    env = {'HOME': str(home), 'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8',
           'XDG_CACHE_HOME': str(root / 'cache'), 'XDG_CONFIG_HOME': str(root / 'config'),
           'GEMINI_API_KEY': 'local-fixture-not-a-secret',
           'GOOGLE_GEMINI_BASE_URL': f'http://127.0.0.1:{server.server_port}',
           'AGY_CLI_DISABLE_AUTO_UPDATE': 'true'}

    def launch(name, binary, cid=None):
        state['phase'] = name
        args = [str(binary.resolve()), '--input-format', 'stream-json', '--output-format',
                'stream-json', '--model', 'gemini-3.8-flash-high',
                '--dangerously-skip-permissions', '--disable-slash-commands']
        if cid:
            args += ['--conversation', cid]
        started = time.monotonic()
        counts, result, first_step = {}, None, None
        with (root / (name + '.stderr')).open('wb') as err, \
             (root / (name + '.stdout')).open('wb') as out:
            process = subprocess.Popen(args, cwd=cwd, env=env, stdin=subprocess.PIPE,
                stdout=subprocess.PIPE, stderr=err, start_new_session=True)
            selector = selectors.DefaultSelector()
            selector.register(process.stdout, selectors.EVENT_READ)
            prompt = 'Reply PROBE_OK.' + ('x' * 280000 if name == 'seed' else '')
            process.stdin.write((json.dumps({'event': 'user', 'message': {'content': prompt}}) + '\n').encode())
            process.stdin.flush()
            buffer = b''
            try:
                while time.monotonic() - started < 170:
                    for key, _ in selector.select(.2):
                        chunk = os.read(key.fileobj.fileno(), 65536)
                        if not chunk:
                            selector.unregister(key.fileobj)
                            continue
                        out.write(chunk)
                        buffer += chunk
                        while b'\n' in buffer:
                            line, buffer = buffer.split(b'\n', 1)
                            try:
                                event = json.loads(line)
                            except (ValueError, UnicodeDecodeError):
                                continue
                            kind = event.get('event', 'unknown')
                            counts[kind] = counts.get(kind, 0) + 1
                            if kind == 'init':
                                cid = event.get('conversation_id', cid)
                            if kind == 'step_update' and first_step is None:
                                first_step = time.monotonic() - started
                            if kind == 'result':
                                result = event.get('result')
                                process.stdin.close()
                    if process.poll() is not None and not selector.get_map():
                        break
            finally:
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGKILL)
                process.wait()
                selector.close()
        native = config / 'conversations' / (str(cid) + '.db')
        with sqlite3.connect(f'file:{native}?mode=ro', uri=True) as db:
            steps = db.execute('select idx,step_type,status from steps').fetchall()
        shutil.copyfile(native, root / (name + '.native.db'))
        log = config / 'cli.log'
        if log.exists():
            shutil.copyfile(log, root / (name + '.cli.log'))
        summary = {'exit': process.returncode, 'seconds': time.monotonic() - started,
                   'firstStepSeconds': first_step, 'events': counts, 'result': result,
                   'conversation': cid, 'nativeSteps': steps,
                   'writeCount': len(marker.read_bytes()) if marker.exists() else 0}
        (root / (name + '.summary.json')).write_text(json.dumps(summary, indent=2))
        print(name, json.dumps({k: v for k, v in summary.items() if k != 'result'}), flush=True)
        return summary

    try:
        seed = launch('seed', opts.old)
        assert seed['exit'] == 0 and seed['conversation'], seed
        shutil.copytree(home, root / 'before-resume')
        old = launch('old-resume', opts.old, seed['conversation'])
        if marker.exists():
            marker.unlink()
        shutil.rmtree(home)
        shutil.copytree(root / 'before-resume', home)
        new = launch('new-resume', opts.new, seed['conversation'])
        assert old['exit'] == 1 and old['events'].get('step_update', 0) == 0, old
        assert 'timeout waiting for cascade to start running' in json.dumps(old['result']), old
        assert new['exit'] == 0 and new['events'].get('step_update', 0) > 0, new
        assert new['events'].get('result') == old['events'].get('result') == 1
        assert old['conversation'] == new['conversation'] == seed['conversation']
        assert old['writeCount'] == new['writeCount'] == 1, (old, new)
        print('REGRESSION_RED_GREEN_PASS', flush=True)
    finally:
        (root / 'requests.json').write_text(json.dumps(state['requests'], indent=2))
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    main()
