# Account-bound Sand Box transport

This is an explicit per-account opt-in for an already configured, running Grok Bot Box. It does not modify the account pool credentials, create a Box for an absent account, upgrade a Box, or fall back to ordinary Cursor quota. CCB/tools remain local.

- Product policy: host authDir `.sand-box-policy.json`, root-owned mode 0600. Contents are account id and SHA-256 subject/machine bindings, never bearer tokens.
- Account session credentials remain in the normal encrypted account store. Official GetSandBoxRunState/EnsureSandBox provide gateway credentials held in memory for at most 60 seconds.
- Use `configure-policy.mts` only as the exclusive operator of that authDir, after independently verifying the account/Box. Arguments carry **hashes**, not credentials. Default is dry-run; `--apply` writes a backup and atomically updates only this policy.

```sh
node --import tsx scripts/cursor-sand-box-relay/configure-policy.mts \
  --auth-dir /etc/openclaude/cursor-v5-u3 --account-id 19 \
  --expected-token-sha256 <verified-64-hex> \
  --expected-machine-sha256 <verified-64-hex> [--apply]
```

For execution through a host mapping where container node_modules symlinks are invalid, bundle this same reviewed entry with the existing esbuild JS API (`bundle: true, platform: node, format: esm`), verify its SHA, and run that generated file on the host. Do not copy any bearer into arguments or generated files.

`relay.cjs` runs inside the Box via the existing reviewed `handleSandStreamRelay` hook, `getGrokBotToken` closure and normal `createNodeHttpClient`. Replace only the verified module, preserve a hash-checked backup, verify syntax, and reload only the known Sand host process when other Box work is idle. Default limits: four requests, 64 MiB inbound, 30 minutes per request. Client cancellation terminates upstream work. A host upgrade may remove the custom hook: fail closed and re-verify the new upstream source instead of blindly patching it.

Box-local errors never poison Cursor account health or rotate the account. Upstream response marker `x-oc-sand-box-upstream: 1` distinguishes provider quota responses from local Box capacity. Gateway tickets are never substituted for account session tokens.

Live smoke (explicitly consumes Sand quota, one-shot guarded):

```sh
node --import tsx scripts/cursor-sand-box-relay/real-ccb-smoke.mjs --run
```

The live smoke uses the real product Adapter and CCB process, not a fake runner. Its result must have a real Read tool invocation/result and exact unpredictable file content. It does not prove browser rendering or deployment; those are separate release checks.
