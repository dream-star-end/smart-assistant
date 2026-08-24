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

  it('installs a dedicated bridge after hostnet and the stable sing-box service', () => {
    const unit = read('deploy/v5-selfhost/openclaude-v5-selfhost-ccb-proxy.service')
    assert.match(unit, /Requires=openclaude-egress\.service openclaude-v5-selfhost-hostnet\.service/)
    assert.match(
      unit,
      /TCP-LISTEN:18991,bind=172\.31\.0\.1,reuseaddr,fork TCP:127\.0\.0\.1:18991/,
    )
  })

  it('upserts transport env and refreshes listener/firewall before cutover', () => {
    const deploy = read('scripts/deploy-v5-selfhost.sh')
    assert.match(deploy, /OC_CLAUDE_CODE_HTTPS_PROXY "http:\/\/172\.31\.0\.1:18991"/)
    assert.match(deploy, /OC_CLAUDE_CODE_TZ "Asia\/Tokyo"/)
    assert.match(deploy, /install_unit "\$UNIT_DIR\/\$V5_CCB_PROXY_UNIT"/)
    assert.match(deploy, /systemctl restart "\$V5_HOSTNET_UNIT"/)
    assert.match(deploy, /systemctl enable --now "\$V5_CCB_PROXY_UNIT"/)
    assert.match(
      deploy,
      /iptables -C V5_EGRESS_IN[\s\S]*--dport 18991 -j RETURN[\s\S]*--comment "v5 CCB -> stable HTTPS proxy"/,
    )
    assert.match(deploy, /install_aux_units\n  refresh_ccb_proxy_path\n  ensure_model_authority/)
  })
})
