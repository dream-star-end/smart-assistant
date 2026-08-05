# V5 Qwen China relay

`qwen3.8-max` uses Alibaba Model Studio's Beijing Token Plan endpoint. The V5
production host reaches that endpoint over an unstable cross-region streaming
path, while the owned test host `42.240.170.145` reaches the same two NLB
addresses reliably. This bridge keeps the provider request encrypted between
the two hosts without exposing a public relay.

## Data path and trust boundary

```text
V5 internal Codex relay
  -> http://127.0.0.1:18999 (production loopback)
  -> restricted SSH local-forward
  -> 127.0.0.1:19080 (test-host loopback)
  -> https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/responses
```

- The China relay accepts only `GET /healthz` and
  `POST /compatible-mode/v1/responses`.
- It constant-time validates the same server-owned Bailian bearer key, strips
  the incoming authorization header, and injects its systemd credential.
- Request and response bodies are streamed with backpressure. They are never
  logged, buffered as a whole, truncated, or written to disk.
- SSH uses a dedicated password-locked account and key. `permitopen` limits the
  destination to the relay loopback port; an sshd `Match` block allows local
  forwarding only and denies PTY, agent, X11, tunnel, and remote forwarding.

## Manual installation gates

These files are intentionally `manual_required` deployment surfaces:

- `scripts/v5-qwen-china-relay.mjs`
- `deploy/v5/openclaude-v5-qwen-china-relay.service`
- `deploy/v5/openclaude-v5-qwen-tunnel.service`
- `deploy/v5/90-openclaude-qwen-relay.conf`

Before installation, record the exact credential `base_url`, Qwen visibility,
support-unit state, sshd drop-in state, and root/default effective sshd config.
Never print the Bailian key.

The test-host secret must be copied without logging from the existing root-only
V5 environment into `/root/.secrets/bailian-token-plan.key` with mode `0600`.
The relay unit reads it only through systemd `LoadCredential`.

The SSH authorized-key entry must have this option prefix (followed by the
dedicated public key):

```text
restrict,port-forwarding,permitopen="127.0.0.1:19080",command="/bin/false"
```

Install the sshd drop-in with a terminal `Match all`. Run `sshd -t` before
reload, then compare `sshd -T -C ...` for a representative root/default user
against the pre-change snapshot. The relay user must show local-only forwarding
and all listed interactive features disabled.

Acceptance must prove:

1. required `ssh -N -L 127.0.0.1:18999:127.0.0.1:19080` succeeds;
2. remote command, shell, PTY, agent/X11 forwarding, `-R`, and an alternate
   `-L` destination fail;
3. a `-D` listener cannot connect to any destination except the permitted relay;
4. production listens only on `127.0.0.1:18999`;
5. the captured 48 KiB Codex request succeeds repeatedly through the tunnel.

Only after these checks may an audited admin operation change the credential
base URL to `http://127.0.0.1:18999/compatible-mode/v1`. Keep Qwen hidden until
the official V5 canary/finalize and billing acceptance complete.

## Failure reconciliation

During a V5 rollout anomaly, run the required official `--abort` or `--rollback`
first. After the old stable release is verified:

1. use an audited admin operation to restore the recorded credential base URL;
2. verify Qwen remains hidden;
3. stop/disable/remove the production tunnel and test relay if this task added
   them;
4. restore the exact prior authorized key, sshd drop-in, known-hosts, and unit
   state; run `sshd -t` before reload and re-check the root/default effective
   configuration.

Do not claim rollback complete until both the official V5 state and these
external support surfaces are reconciled.
