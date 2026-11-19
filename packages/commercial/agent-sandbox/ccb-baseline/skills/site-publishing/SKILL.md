---
name: site-publishing
description: Publish and manage persistent static, SPA, and fullstack websites (/api/* worker + built-in SQLite + encrypted env vars, or external Supabase/MemFire) under *.congjianai.com using `oc-site`. Use when the user asks to deploy, host, publish, or build a persistent fullstack website.
priority: 10
---

# Persistent Site Publishing (`oc-site`) — Fullstack & Static Guide

Use `oc-site` whenever the user wants a website **persistently hosted under a public domain** (`https://<slug>.congjianai.com`) that remains online after the container hibernates.

- Temporary live debugging during development uses `http://localhost:<port>` container preview.
- Once ready, publish static/SPA assets — optionally with an isolated `/api/*` backend handler and built-in SQLite database — using `oc-site`.
- Users manage sites, analytics, SQLite tables, custom domains, secret env vars, and visibility in the left sidebar **「站点」** workspace.

## 1. Quick Commands (`oc-site`)

```bash
# Publish static/SPA build directory (must contain root index.html)
oc-site publish ./dist --slug my-app --title "我的应用"

# Publish a fullstack app with built-in /api/* backend worker
oc-site publish ./dist --api ./server/api.mjs --slug my-app --title "全栈应用"
# (Or place server/api.mjs or api/index.mjs inside the target dir; oc-site auto-packs it securely as __oc_server/api.mjs)

# Publish a single standalone HTML file / password protection / multi-page non-SPA
oc-site publish ./index.html --slug demo-card --title "交互名片"
oc-site publish ./dist --slug team-notes --visibility password --password "secret-pass"
oc-site publish ./out --slug docs-site --no-spa

# Manage slug, custom domain, env secrets, SQLite, analytics, and collaborative pull
oc-site list
oc-site info my-app
oc-site pull my-app ./my-app                      # pull published files (+ server/api.mjs if fullstack) to edit locally
oc-site rename my-app my-app-v2
oc-site update my-app --visibility disabled      # pause offline
oc-site update my-app --visibility public        # resume online
oc-site update my-app --custom-domain app.example.com
oc-site verify-domain my-app                      # verify DNS TXT record & enable custom domain routing

oc-site env-set my-app DEEPSEEK_API_KEY "sk-..." --secret
oc-site env-list my-app
oc-site env-unset my-app DEEPSEEK_API_KEY

oc-site db-sql my-app "CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP)"
oc-site db-inspect my-app --table notes
oc-site analytics my-app --days 7
oc-site delete my-app
```

Rules:
- Root `index.html` is mandatory. Single publish limit is 25 MiB / 500 files (10 MiB max per file).
- `oc-site publish` skips `.env`, `.env.*`, `.oc-site-state.json`, `.git`, `node_modules`, and symlinks, and never serves `__oc_server/*` publicly.
- `oc-site pull` saves `.oc-site-state.json` (base revision & content SHA-256) so subsequent collaborative `oc-site publish` automatically enforces optimistic concurrency (`409 STALE_REVISION` if another collaborator published newer changes; re-pull and merge before re-publishing).
- Collaborators (`editor`) can update frontend assets and keep an existing owner-approved `server/api.mjs` unchanged, but cannot introduce or modify `server/api.mjs` (owner-only, since it reads owner secrets).
- Omit `--slug` on first publish to auto-assign `site-xxxxxxxx`. Pass the same `--slug` on updates, or use `oc-site rename` to migrate while preserving SQLite and env vars.

## 2. Built-in Fullstack Mode (`/api/*` + SQLite + Secret Env)

To add backend API routes + SQLite database without running a separate backend server:

1. **Create `server/api.mjs`** exporting a default handler `async function handler(ctx)`:
   ```js
   export default async function handler(ctx) {
     // ctx.req: { method, url, pathname, query, headers, body, json(), text() }
     // ctx.env: Record<string, string> decrypted from oc-site env-set / 「设置 -> 环境变量」
     // ctx.db: { exec(sql), query(sql, ...params), get(sql, ...params), run(sql, ...params) } (per-site SQLite WAL DB)
     // ctx.site: { slug, revision }
     // ctx.json(data, status, headers?) / ctx.text(str, status, headers?)
     // globalThis.fetch: SSRF-hardened external fetch (private IPs blocked)
     const { req, env, db, json } = ctx

     if (req.pathname === '/api/notes' && req.method === 'GET') {
       const rows = db.query('SELECT id, body, created_at FROM notes ORDER BY id DESC LIMIT 50')
       return json({ notes: rows })
     }
     if (req.pathname === '/api/notes' && req.method === 'POST') {
       const payload = req.json() ?? {}
       db.run('INSERT INTO notes (body) VALUES (?)', [String(payload.body ?? '')])
       return json({ ok: true }, 201)
     }
     return json({ error: 'Not found' }, 404)
   }
   ```
2. **Initialize schema & store secrets safely**:
   - Store API keys (e.g. `DEEPSEEK_API_KEY`, `OPENAI_API_KEY`) via `oc-site env-set <slug> KEY VALUE --secret` or UI **「设置 → 环境变量」**. Never embed secret keys into frontend JS.
   - Use `oc-site db-sql <slug> "..."` or idempotent `CREATE TABLE IF NOT EXISTS` at API startup/write.
3. **Runtime constraints**:
   - Handler runs OS-sandboxed (`bwrap --unshare-all`, 8s timeout, 128 MiB V8 heap / 256 MiB RSS cap, read-only code mount + single-site SQLite `data/` mount only, only `ctx.env` exposed).
   - `verify-domain` requires a DNS TXT record `_oc-site-verify.<customDomain>` matching `customDomainTxtValue` before the custom domain participates in Edge routing and TLS.

## 3. External Supabase / MemFire Cloud ("前端即全栈")

For user accounts / multi-tenant client DB / Storage without writing `/api/*` handlers:
1. Ask only for Supabase/MemFire Project URL (`VITE_SUPABASE_URL`) and publishable **`anon`** key (`VITE_SUPABASE_ANON_KEY`) — **never expose `service_role` or `postgres://` in frontend bundles**.
2. Provide an idempotent `supabase/schema.sql` with **`ALTER TABLE ... ENABLE ROW LEVEL SECURITY;`** and explicit `CREATE POLICY` rules on every writable table.
3. Run `npm run build` (`vite build`), verify `dist/index.html` and no `service_role` in `dist/`, then publish with `oc-site publish dist --slug <slug> --title "<title>"`.
