# Kimi K3.1 Pro standard — OCV5-611

The exact upstream ID is `k3.1-pro`, using the existing Moonshot Coding key and
Anthropic endpoint. Vendor `/coding/v1/models` declares 1,048,576 context,
text/image/video input, thinking-only, low/high/max effort (default max), and
dynamic tools. No maximum output is invented. The existing K3 product window
policy also applies: admin 1M, ordinary users 512000. Old K3 1M and 256K remain.
Highspeed and OpenCode aliases are excluded.

The user approved PLATFORM prices of input/output/cache-read/write
609/3046/61/0 fen per million tokens, multiplier 1, default effort max, on
2026-10-24 05:07 (rounded two-thirds of the prior 914/4569/92/0 platform price).
Both existing K3 rows retain their prices. These are not a vendor cost claim.

The user selected the existing Kimi Code subscription on 2026-10-24 05:02,
knowingly accepting the observed 33–40% higher quota increments. This explicit
cost decision supersedes the earlier release hold; no lower upstream cost is
claimed. OpenCode Go is stopped. Commercial PR #1045 has release authorization,
conditional on full personal acceptance and prior disclosure of non-Kimi diff.

## Preparation and acceptance

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

Activation is separate: after the accepted cost decision and release verification, use
the existing `admin/modelCatalogOps.activateEntry(entryId, lockVersion, ctx)`
operation. It checks semantics and creates `model_catalog.activate` audit;
catalog->pricing trigger mirrors enabled in the same transaction. Never set
pricing.enabled first or directly write active state. The new script contains
no activation command or cost override. Emergency disable uses the existing
`disableEntry` for `k3.1-pro` only.

Before activation, use existing audited patchPricing with lock_version to set
visibility hidden, then add only the target canary grant. activateEntry mirrors
enabled from catalog state; never patch enabled. Personal uid765 must pass real
multi-turn, a Bash result, same-session continuation after at least 300 seconds,
old-K3 regression, concurrent sessions and usage/journal/ledger reconciliation
at the new frozen prices. Only then remove the temporary grant and change
visibility to public. On failure revoke only the owned grant and disable the
new hidden entry. Direct upstream probes do not count as this acceptance.

After personal acceptance, commercial uid247 repeats the release and billing
verification under the official queue and production-mutation lease. Report
all non-Kimi release differences before deployment. The selfhost-only stage
script remains selfhost-only; a separately reviewed commercial operator must
verify commercial DB/release identity and use the same product catalog APIs.
