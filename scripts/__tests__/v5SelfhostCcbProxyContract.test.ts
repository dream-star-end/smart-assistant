import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (relative: string) => readFileSync(join(root, relative), 'utf8')

describe('v5 selfhost CCB HTTPS proxy deployment contract', () => {
  it('keeps port 18991 behind the v5-only host firewall allow-before-drop rule', () => {
    const net = read('packages/commercial/scripts/setup-host-net.sh')
    assert.match(net, /v5\)[\s\S]*CCB_HTTPS_PROXY_PORT="18991"/)
    assert.match(
      net,
      /--dport "\$CCB_HTTPS_PROXY_PORT" -j RETURN[\s\S]*-d "\$GATEWAY" -j DROP/,
    )
    assert.match(net, /allow proto tcp from "\$SUBNET" to any port "\$CCB_HTTPS_PROXY_PORT"/)
  })

  it('keeps Cursor port 18992 behind a separate v5-only allow-before-drop rule', () => {
    const net = read('packages/commercial/scripts/setup-host-net.sh')
    assert.match(net, /v5\)[\s\S]*CURSOR_HTTPS_PROXY_PORT="18992"/)
    assert.match(
      net,
      /--dport "\$CURSOR_HTTPS_PROXY_PORT" -j RETURN[\s\S]*-d "\$GATEWAY" -j DROP/,
    )
    assert.match(
      net,
      /allow proto tcp from "\$SUBNET" to any port "\$CURSOR_HTTPS_PROXY_PORT"/,
    )
  })

  it('installs a dedicated bridge after hostnet and the stable sing-box service', () => {
    const unit = read('deploy/v5-selfhost/openclaude-v5-selfhost-ccb-proxy.service')
    assert.match(unit, /Requires=openclaude-egress\.service openclaude-v5-selfhost-hostnet\.service/)
    assert.match(
      unit,
      /TCP-LISTEN:18991,bind=172\.31\.0\.1,reuseaddr,fork TCP:127\.0\.0\.1:18991/,
    )
  })

  it('installs the Cursor-only sing-box unit without embedding credentials', () => {
    const unit = read('deploy/v5-selfhost/openclaude-v5-selfhost-cursor-proxy.service')
    assert.match(unit, /ConditionPathExists=\/etc\/sing-box\/openclaude-cursor-egress-proxy\.json/)
    assert.match(unit, /Requires=docker\.service openclaude-v5-selfhost-hostnet\.service/)
    assert.match(
      unit,
      /ExecStart=\/usr\/local\/bin\/sing-box run -c \/etc\/sing-box\/openclaude-cursor-egress-proxy\.json/,
    )
  })

  it('upserts transport env and refreshes listener/firewall before cutover', () => {
    const deploy = read('scripts/deploy-v5-selfhost.sh')
    assert.match(deploy, /OC_CLAUDE_CODE_HTTPS_PROXY "http:\/\/172\.31\.0\.1:18991"/)
    assert.match(deploy, /OC_CLAUDE_CODE_TZ "Asia\/Tokyo"/)
    assert.match(deploy, /install_unit "\$UNIT_DIR\/\$V5_CCB_PROXY_UNIT"/)
    assert.match(deploy, /install_unit "\$UNIT_DIR\/\$V5_CURSOR_PROXY_UNIT"/)
    assert.match(deploy, /systemctl restart "\$V5_HOSTNET_UNIT"/)
    assert.match(deploy, /systemctl enable --now "\$V5_CCB_PROXY_UNIT"/)
    assert.match(
      deploy,
      /iptables -C V5_EGRESS_IN[\s\S]*--dport 18991[\s\S]*--comment "v5 CCB -> stable HTTPS proxy" -j RETURN/,
    )
    assert.match(
      deploy,
      /iptables -C V5_EGRESS_IN[\s\S]*--dport 18992[\s\S]*--comment "v5 Cursor -> dedicated HTTPS proxy" -j RETURN/,
    )
    assert.match(deploy, /install_aux_units\n  refresh_ccb_proxy_path\n  ensure_model_authority/)
  })

  it('syncs flavor helper next to breakglass hostnet when the source has it', () => {
    const deploy = read('scripts/deploy-v5-selfhost.sh')
    assert.match(deploy, /flavor_lib_src="\$src\/scripts\/lib\/assert-flavor\.sh"/)
    assert.match(deploy, /flavor_rules_src="\$src\/scripts\/lib\/flavor-rules\.json"/)
    assert.match(deploy, /BOOT_SCRIPT_DIR\/scripts\/lib/)
  })

  it('setup-host-net skips flavor check when helper is missing and reinserts SSH RETURN after flush', () => {
    const net = read('packages/commercial/scripts/setup-host-net.sh')
    assert.match(net, /\[WARN\] flavor helper missing for setup-host-net\.sh; skipping flavor identity check/)
    assert.equal(net.includes('[ABORT] flavor helper missing for setup-host-net.sh'), false)
    assert.match(
      net,
      /iptables -F "\$V3_HOST_GUARD_CHAIN"[\s\S]*--dport 22 -j RETURN/,
    )
  })

  it('cursor-proxy ExecStartPre does not fail-loop when live helper is missing', () => {
    const unit = read('deploy/v5-selfhost/openclaude-v5-selfhost-cursor-proxy.service')
    assert.match(unit, /ExecStartPre=/)
    assert.match(unit, /flavor helper missing on live; skip cursor-proxy flavor check/)
    assert.equal(
      /^ExecStartPre=\/usr\/bin\/bash \/opt\/openclaude\/openclaude-v5-selfhost-live\/scripts\/lib\/assert-flavor\.sh /m.test(
        unit,
      ),
      false,
    )
  })
})
