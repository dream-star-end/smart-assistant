/** A theme page or a logged-out page must fail before the ready budget. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const hostPy = join(dirname(fileURLToPath(import.meta.url)), '../../../box-bridge-mod/host.py')

const driver = `
import importlib.util, os, sys, threading, time
spec = importlib.util.spec_from_file_location("oc_box_host", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
class Fake:
    def __init__(self):
        self.ready = threading.Event()
        self.print_mode = False
        self.fatal = None
        self.run_dir = "/tmp"
        self.users = 0
        self.results = 0
        self.stdin_closed = False
    def launch(self):
        return True
    def read_stdin(self):
        return None
    def alive(self):
        return True
    def pane(self):
        return os.environ.get("PANE", "")
start = time.monotonic()
code = mod.run(Fake(), None, threading.Event())
sys.stdout.write("%s %.3f\\n" % (code, time.monotonic() - start))
`

function screen(pane, readyMs) {
  return spawnSync('python3', ['-I', '-c', driver, hostPy], {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', PANE: pane, OC_BOX_READY_MS: readyMs },
  })
}

function immediate(pane, code) {
  const result = screen(pane, '2000')
  assert.equal(result.status, 0, result.stderr)
  const [exitCode, seconds] = result.stdout.trim().split(' ')
  assert.equal(exitCode, '1')
  assert.ok(Number(seconds) < 0.8, result.stdout)
  assert.equal(result.stderr.trim(), code)
  assert.equal(result.stderr.includes('  | '), false)
  assert.equal(result.stderr.includes(pane.trim()), false)
}

test('a first-start theme page fails immediately as BOX_INTERACTIVE_ONBOARDING', () => {
  immediate('Choose a theme\ncolorblind-friendly\n', 'BOX_INTERACTIVE_ONBOARDING')
})

test('a logged-out page fails immediately as BOX_INTERACTIVE_LOGIN_REQUIRED', () => {
  immediate('Select login method:\n', 'BOX_INTERACTIVE_LOGIN_REQUIRED')
  immediate('Not logged in \u00b7 Run /login\n', 'BOX_INTERACTIVE_LOGIN_REQUIRED')
  immediate('Select login method:\ncolorblind-friendly\n', 'BOX_INTERACTIVE_LOGIN_REQUIRED')
})

test('an ordinary pane still waits out BOX_INTERACTIVE_NOT_READY timeout', () => {
  const result = screen('Claude Code\n', '600')
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stderr, /BOX_INTERACTIVE_NOT_READY timeout/)
  const seconds = Number(result.stdout.trim().split(' ')[1])
  assert.ok(seconds >= 0.5, result.stdout)
})
