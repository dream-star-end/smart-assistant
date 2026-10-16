# OCV5-425 OpenCode Go models + effort tiers (selfhost only)

Data and apply logic: `packages/commercial/src/admin/openCodeGoCatalog.ts` (prices from https://opencode.ai/docs/go/, fen = floor(usd*100/2), min 1).
Routing and effort tiers: protocol `OPENCODE_GO_MESSAGES_MODELS` and the opencodego spec's
`modelOutputConfigEfforts`.

After the release train is committed and live verification passed:

```bash
cd /opt/openclaude/openclaude-v5-selfhost
( set -a; . /etc/openclaude/commercial-v5-selfhost.env; set +a
  node --import tsx scripts/ocv5-425/catalog.ts --check
  node --import tsx scripts/ocv5-425/catalog.ts --on --sha <merge-sha> )
```

`--off` disables and hides the new models and switches Gemini 4 back to no effort tiers
(the bridge then uses its old fixed LOW). The script refuses any drift from the reviewed rows.
