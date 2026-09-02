import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, test } from 'node:test'

const dockerfile = readFileSync(
  resolve(process.cwd(), 'packages/commercial/agent-sandbox/Dockerfile.openclaude-runtime'),
  'utf8',
)
const buildScript = readFileSync(
  resolve(process.cwd(), 'packages/commercial/agent-sandbox/build-image.sh'),
  'utf8',
)
const selfhostProfile = readFileSync(
  resolve(process.cwd(), 'deploy/v5-selfhost/runtime-build.env'),
  'utf8',
)

describe('official Claude Code runtime pin', () => {
  test('Dockerfile keeps the stock CLI opt-in, pinned, and build-verified', () => {
    assert.match(dockerfile, /ARG OC_INCLUDE_OFFICIAL_CLAUDE=0/)
    assert.match(dockerfile, /ARG OC_OFFICIAL_CLAUDE_VERSION=2\.1\.258/)
    assert.match(dockerfile, /@anthropic-ai\/claude-code@\$\{OC_OFFICIAL_CLAUDE_VERSION\}/)
    assert.match(dockerfile, /claude --version/)
    assert.match(dockerfile, /test -x \/usr\/local\/bin\/claude/)
  })

  test('image identity includes official CLI content args, labels, and capability token', () => {
    assert.match(buildScript, /OC_INCLUDE_OFFICIAL_CLAUDE=\$\{OC_INCLUDE_OFFICIAL_CLAUDE:-0\}/)
    assert.match(buildScript, /OC_OFFICIAL_CLAUDE_VERSION=\$\{OFFICIAL_CLAUDE_VERSION\}/)
    assert.match(buildScript, /oc\.runtime\.include_official_claude=\$\{OC_INCLUDE_OFFICIAL_CLAUDE:-0\}/)
    assert.match(buildScript, /oc\.runtime\.official_claude_version=\$OFFICIAL_CLAUDE_VERSION/)
    assert.match(buildScript, /official_claude_code_v1/)
  })

  test('slim image build context includes unconditional Dockerfile helper inputs', () => {
    assert.match(
      buildScript,
      /cp "\$SANDBOX_DIR\/scripts\/patch-cursor-agent-sand\.mjs" "\$BUILD_CTX\/scripts\/patch-cursor-agent-sand\.mjs"/,
    )
  })

  test('selfhost rebuild profile opts into exactly the audited official version', () => {
    assert.match(selfhostProfile, /^OC_INCLUDE_OFFICIAL_CLAUDE=1$/m)
    assert.match(selfhostProfile, /^OC_OFFICIAL_CLAUDE_VERSION=2\.1\.258$/m)
  })
})
