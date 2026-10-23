# Kimi K3.1 Pro standard — OCV5-611

The exact upstream ID is `k3.1-pro`, using the existing Moonshot Coding key and
Anthropic endpoint. Vendor `/coding/v1/models` declares 1,048,576 context,
text/image/video input, thinking-only, low/high/max effort (default max), and
dynamic tools. No maximum output is invented. The existing K3 product window
policy also applies: admin 1M, ordinary users 512000. Old K3 1M and 256K remain.
Highspeed and OpenCode aliases are excluded.

The steward approved temporary PLATFORM prices of input/output/cache-read/write
914/4569/92/0 fen per million tokens, multiplier 1, default effort max.
These are not a claim about the new upstream unit cost.

## Release hold: upstream cost has not passed

Official `/coding/v1/usages` currently exposes aggregate subscription ratios.
Direct bounded requests identify the correct models and return token counts,
but no monetary cost or unit rate. A rounded ratio change, a zero wallet delta,
or platform usage/journal/ledger agreement cannot prove equal upstream price.
Do not merge, deploy or activate while that evidence is missing or new rates
exceed K3. Keep both PRs draft. Do not create a synthetic cost-passed receipt.

## Preparation after the hold is resolved

Use the reviewed default Codex + required CI result, load<6, two FREE checks,
>=8GiB free, no other train/turn, and the official personal ride/lease. Verify
master, runtime/CCB, frontend and active egress are serving the reviewed release.
No dependency installation, shared DB reset or manual remote cleanup.

Like the existing Go/Box operator batches, this is migration-free. A fresh
installation needs explicit catalog preparation; migrations alone do not
publish this model. All keys remain in the server environment; never print it.

With the existing selfhost app/admin environment loaded in memory and OC_USER_ID=3:

```bash
npx tsx scripts/ocv5-611/catalog.ts plan
# Only from the verified live release directory, with its exact 40-character SHA:
npx tsx scripts/ocv5-611/catalog.ts stage --sha <reviewed-live-sha>
```

`plan` reads only. `stage` calls `createStaged`, then inserts disabled pricing
and `pricing.create` audit in one short transaction. Strict exact-state checks
make a completed stage repeatable and reject changed profiles/prices or an
already-active entry. Interrupted preparation leaves a non-executable staged
entry. Existing K3 rows are never updated.

Activation is separate: after actual cost proof and release verification, use
the existing `admin/modelCatalogOps.activateEntry(entryId, lockVersion, ctx)`
operation. It checks semantics and creates `model_catalog.activate` audit;
catalog->pricing trigger mirrors enabled in the same transaction. Never set
pricing.enabled first or directly write active state. The new script contains
no activation command or cost override. Emergency disable uses the existing
`disableEntry` for `k3.1-pro` only.

Accept with personal uid765: real multi-turn including an unpredictable tool
result, 300s same-session continuation, old K3 regression and three-ledger
formula reconciliation. Direct upstream metadata probes are not this acceptance.
Commercial uid247 is reserved if any commercial testing is later authorized;
commercial production and egress are untouched. The commercial PR stays draft
and explicitly DO NOT MERGE until the user says to release.
