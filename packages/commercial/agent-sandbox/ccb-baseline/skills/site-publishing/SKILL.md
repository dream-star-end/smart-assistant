---
name: site-publishing
description: Publish and update persistent static/SPA websites under *.congjianai.com using `oc-site`, including the Frontend + External Supabase / MemFire Cloud (RLS + anon key) fullstack workflow. Use when the user asks to deploy, host, publish, or update a website at a persistent domain, or build a frontend-only fullstack app backed by Supabase.
priority: 10
---

# Persistent Site Publishing (`oc-site`) & External Supabase Fullstack Guide

Use `oc-site` whenever the user wants a website **persistently hosted under a public domain** (`https://<slug>.congjianai.com`) that remains online after the container hibernates.

- Temporary live debugging during development still uses `http://localhost:<port>` container preview.
- Once the site is ready (or the user asks for a persistent/public URL), build static assets and publish with `oc-site`.

## 1. Quick Commands (`oc-site`)

```bash
# Publish a built directory (must contain root index.html)
oc-site publish ./dist --slug my-app --title "我的应用"

# Publish a single standalone HTML file
oc-site publish ./index.html --slug demo-card --title "交互名片"

# Publish with password protection (4-128 chars)
oc-site publish ./dist --slug team-notes --visibility password --password "secret-pass"

# Multi-page static site (disable SPA fallback to /index.html)
oc-site publish ./out --slug docs-site --no-spa

# Manage existing sites
oc-site list
oc-site info my-app
oc-site update my-app --visibility disabled   # pause offline
oc-site update my-app --visibility public     # resume online
oc-site delete my-app
```

Rules:
- Root `index.html` is mandatory. Single publish limit is 25 MiB / 500 files (10 MiB max per file).
- `oc-site publish` automatically skips `.env`, `.env.*`, `.git`, `node_modules`, and symlinks. Never manually copy `.env*` into `dist/`.
- If `--slug` is omitted on first publish, a random `site-xxxxxxxx` slug is assigned. Pass the same `--slug` on subsequent builds to overwrite cleanly without losing the URL.
- Users can also manage visibility, passwords, titles, SPA mode, and deletion in **「管理中心 → 站点」**.

## 2. Frontend + External Supabase / MemFire Cloud ("前端即全栈")

Static hosting pairs naturally with **Supabase** (or domestic **MemFire Cloud** for lower latency in mainland China) so the browser talks directly to Postgres + Auth + Storage without running a backend server:

### Step-by-step workflow
1. **Collect public client credentials only**:
   - Ask the user for their Supabase Project URL (`VITE_SUPABASE_URL`) and **publishable `anon` key** (`VITE_SUPABASE_ANON_KEY`).
   - **NEVER put `service_role` / `postgres://` secrets in frontend code, Vite env files that ship in JS bundles, or published files.**
2. **Design tables + mandatory Row Level Security (RLS)**:
   - Write an idempotent `supabase/schema.sql` file for the user to run in Supabase SQL Editor.
   - **Always `ALTER TABLE ... ENABLE ROW LEVEL SECURITY;`** on every user table and define explicit `CREATE POLICY` rules (e.g. `auth.uid() = user_id` for private data, or read-only `SELECT` policy for public content). Never leave RLS disabled on writable tables!
3. **Frontend client setup**:
   ```ts
   import { createClient } from '@supabase/supabase-js'

   export const supabase = createClient(
     import.meta.env.VITE_SUPABASE_URL,
     import.meta.env.VITE_SUPABASE_ANON_KEY,
   )
   ```
   - Use Supabase Auth (`signInWithPassword` / `signUp` / Magic Link) when accounts are needed.
   - Ensure SPA client routing (`BrowserRouter` or hash routing) works cleanly under `https://<slug>.congjianai.com/`. Note `oc-site` enables SPA fallback (`index.html` on unknown non-asset paths) by default!
4. **Build & Verify before Publishing**:
   - Run `npm run build` (e.g. `vite build`) and verify `dist/index.html` exists and relative/root `/assets/...` paths resolve.
   - Check that no `service_role` string appears in `dist/`.
   - Run `oc-site publish dist --slug <slug> --title "<title>"`, then verify the returned `https://<slug>.congjianai.com` URL responds cleanly.
