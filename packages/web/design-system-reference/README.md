# OpenClaude Design System

This folder is a working design system for **OpenClaude** — a Chinese-language, commercial,
multi-channel personal AI assistant built on top of Anthropic's Claude Code runtime. The
UI is Chinese-first, dark-mode-first, warm-toned, and heavily text-dense (chat product +
terminal/tool output + admin console).

> Use this system when designing any OpenClaude surface — marketing landing, the app
> (chat, sidebar, composer, settings modals), the admin console, emails, slides, decks.

---

## Source of truth

Everything here is derived from a snapshot of the repo the user attached:

- **Repo:** `github.com/dream-star-end/openclaude-v3-temp` (branch `main`)
- **Primary surface:** `packages/web/public/` — a single-page web app
  (`index.html` + `style.css` + modular ES modules under `modules/`)
- **Landing marketing page** lives in the same `index.html` under `#landing-view`
- **Admin console** lives at `admin.html`
- **Design tokens** are defined in `:root` at the top of `style.css`
  (lines ~1–130) and were ported verbatim into `colors_and_type.css` here.

Cross-reference assets (not pre-loaded — pull on demand):

```
packages/web/public/style.css       ← 4910 lines, full stylesheet (ported)
packages/web/public/index.html      ← 1046 lines, landing + login + app + modals
packages/web/public/icon.svg        ← brand mark (400B)
packages/web/public/manifest.json   ← PWA metadata
packages/web/public/modules/*.js    ← web app behavior
```

---

## Product context

OpenClaude (内部也叫「小米」/ "Smart Assistant") is pitched as **"原生 Claude Code 底座"**
— a commercial hosting of Claude Opus / Sonnet that runs each user in an isolated Docker
container with a real Claude Code agent inside, billed per token (¥1 ≈ 100 积分 ≈ $1 USD).

Core value props (as written in the landing page):

1. 官方 Claude Code Max 账号池 — multi-account pool, no rate-limit cliff
2. 满血 Opus,不降智 — unrestricted thinking budget, full tool access
3. 原生 Claude Code 为底座 — not an API wrapper, the actual agent runtime
4. 缓存命中率 > 95% — aggressive prompt cache, cheap long conversations

Product surfaces to design for:

| Surface | Where it lives in the repo | What it is |
|---|---|---|
| **Landing** | `#landing-view` in index.html | Marketing hero + pricing + FAQ |
| **Auth** | `#login-view` | Split-screen login / register / forgot / verify |
| **App** | `#app-view` | Chat app: sidebar + composer + message stream |
| **Admin console** | `admin.html` | Ops: users, models, pricing, containers |
| **Settings modals** | `#agents-modal`, `#persona-modal`, … | Agent / persona / memory / skills / tasks management |

We ship **one** UI kit for the whole web app (chat + landing + admin share a vocabulary).
See `ui_kits/openclaude-web/`.

---

## Index — what's in this folder

```
README.md                   ← this file
colors_and_type.css         ← design tokens: colors, fonts, spacing, radii, shadows
SKILL.md                    ← Agent Skills manifest (cross-compatible)
fonts/                      ← (empty — uses system + Google Fonts fallbacks, see §Typography)
assets/
  logo.svg                  ← brand mark (orange reticle, #ff7b00 on #0d1117)
  manifest.json             ← PWA manifest reference
preview/                    ← Design System tab cards (registered assets)
  color-*.html
  type-*.html
  spacing-*.html
  components-*.html
  brand-*.html
ui_kits/
  openclaude-web/           ← the only UI kit — covers landing + chat + admin
    README.md
    index.html              ← interactive click-through of the chat app
    tokens.css              ← symlink-equivalent: imports ../../colors_and_type.css
    components/
      Sidebar.jsx
      Composer.jsx
      MessageList.jsx
      Button.jsx
      IconButton.jsx
      ToolCard.jsx
      Modal.jsx
      LandingHero.jsx
```

---

## Content fundamentals

**Language.** Chinese-first (Simplified, `zh-CN`), with English technical terms embedded
inline — typical of Chinese dev products. Never translate technical nouns (`token`,
`Opus`, `Claude Code`, `prompt cache`, `SSE`). The landing page mixes them freely:
*"原生 Claude Code 底座"*, *"prompt cache 命中率 > 95%"*, *"满血 Opus,不降智"*.

**Punctuation.** Chinese full-width for Chinese sentences (`,` `。` `:` `「」`), ASCII for
code and numbers. Em dashes `——` are used heavily for connective asides — emulate them
exactly when rewriting copy. Middle dot `·` separates inline meta ("官方 Claude Code Max 通道 · 满血 Opus 4.7").

**Casing.** Product nouns are lowercase by default (`openclaude`, `claude-opus-4-7`) except
when appearing as a proper name in prose (`OpenClaude`, `Claude Opus 4.7`). Model IDs
stay kebab-case. Never title-case Chinese.

**Pronoun.** *你* (informal "you") throughout — never *您*. We're a dev tool, not a bank.

**Tone.**
- *Confident, technical, a little swaggery.* "不降智", "满血", "token 账单比直接走 API 通常便宜一个数量级".
- *Specific > vague.* Always name the model, always cite the number, always show the
  unit. "¥1 = 100 积分 ≈ $1 美元" beats "便宜".
- *Dev-peer, not marketing-consumer.* Assumes the reader knows what `prompt cache`,
  `SSE`, `Docker`, and `MCP` mean. Don't explain them.
- *No hype emoji in prose.* Emoji appear only as section flags in the codebase README
  (✨ 🤖 🧠 🛠 📱 🎨) and in *agent avatars* (🤖 is the default avatar emoji). Never
  sprinkle them into product copy or UI.

**Examples pulled from the real landing page (cite verbatim when appropriate):**

- Hero: *"原生 Claude Code 底座 — 满血 Opus,不降智"*
- Sub: *"多账号轮询 · prompt cache 命中率 > 95% —— token 成本压到极低,你只为真正消耗的部分买单。"*
- Pricing eyebrow: *"充得越多,送得越多"*
- CTA: *"准备好让 AI 替你干活了吗?"*
- Empty-state greeting: *"你好!我是你的 AI 助手"*

**Microcopy patterns.**
- Buttons: verb-only (`登录`, `注册`, `发送`, `新建会话`). Avoid "点击 xxx".
- Placeholders: imperative + object (`发消息给 agent…`, `搜索会话...`, `邮箱`).
- Empty states: greeting + gentle nudge (`你好!` + `按 ⌘N 新建会话`).
- Status: present-continuous verbs (`连接中…`, `正在等待邮箱验证`).
- Errors: diagnostic, not apologetic — state what happened, then what to do.

---

## Visual foundations

### Palette

The system has **one accent** (warm terracotta orange) and a cream/char neutral scale.
No blue, no purple (except `--thinking: #b594ef` reserved for extended-thinking UI).

| Role | Dark | Light |
|---|---|---|
| `--accent` | `#d97757` Terracotta | `#bc4f22` Burnt orange |
| `--bg` | `#1a1a1d` Ink | `#faf9f6` Cream |
| `--bg-elevated` | `#212125` | `#ffffff` |
| `--fg` | `#eceae6` Off-white | `#1a1a1d` Ink |
| `--success` | `#86c781` | `#3f9f4a` |
| `--danger` | `#e06c6c` | `#c4393d` |

The dark palette is deliberately *warm* — near-blacks carry a small amount of red, not
the pure `#000` / `#1e1e1e` of VS Code dark. Light is *cream*, not paper white.

### Typography

Three families:

- **Sans** `-apple-system, Inter, "PingFang SC", "Microsoft YaHei"` — 95% of UI
- **Mono** `JetBrains Mono, ui-monospace, "SF Mono"` — tool output, code, timestamps, kbd
- **Serif** `"Source Serif Pro", "Noto Serif SC"` — reserved for the empty-state greeting
  (the *one* "hello" moment). Don't sprinkle it elsewhere.

Sizes go `11 / 12.5 / 14 / 15 / 17 / 20 / 24 / 30`. Body is `14`; composer input bumps
to `16` to prevent iOS zoom. Letter-spacing tightens on display (`-0.01em` to `-0.02em`).

> **Font files:** the system ships *no* webfonts — it relies on platform fonts with Noto
> / PingFang fallbacks. If designing for a print or export surface where platform fonts
> aren't available, substitute **Inter** (sans) + **JetBrains Mono** (mono) + **Source
> Serif 4** (serif) from Google Fonts. Flagged to user: real `.ttf` files are not
> available in the repo.

### Spacing & radii

Spacing is a clean 4px scale: `4 8 12 16 20 24 32 40 48 64`.
Radii escalate: `6 (sm) / 10 (md) / 14 (lg) / 18 (xl) / 24 (2xl) / 9999 (full)`.

Surfaces: chips + segmented pills → `full`. Inputs, menu items, tool cards → `md`.
Message bubbles, composer, login card → `xl` / `2xl`. The *brand mark* inside the
sidebar uses `md`; the *empty-state brand* uses a custom `22px` radius.

### Backgrounds

- **Solid surfaces** dominate. No hand-drawn illustrations, no repeating patterns, no
  grain.
- **Aurora gradients** appear in exactly two places: the login `aside` and the landing
  hero eyebrow — radial gradients of `--accent` variants, blurred 60px, slowly
  animated (`aurora-float` 18–22s). Never use gradient backgrounds elsewhere.
- **Protection gradients** on the composer footer (`linear-gradient(180deg, transparent
  0%, var(--bg) 40%)`) fade the bottom of the message list into the input — always do
  this for sticky bottom composers.

### Elevation & shadow

Four-step shadow ramp: `sm (hairline) / md (cards) / lg (popovers) / xl (modals)`.
Shadows are *warm-tinted* in light mode (`rgba(30, 25, 10, …)`) and deep-black in dark.

Elevation method: **1px border + shadow**, not just shadow. Every surface has a
`border: 1px solid var(--border)` — strokes do the structural work, shadow adds depth.

### Motion

- **Easing:** `cubic-bezier(0.4, 0, 0.2, 1)` for everything. No bouncy / elastic.
- **Durations:** `120ms (fast)` for button/hover state, `180ms (base)` for modals and
  reveals, `280ms (slow)` for page-level transitions.
- **Signature animations:** `fade-up` (8px + opacity) for entering messages;
  `aurora-float` (gentle scale/translate loop) for the login background;
  `gentle-bob` (4s sine) for the empty-state brand mark.
- **No bounces, no overshoots, no spring physics.**

### Hover / press states

- **Hover:** background step up one level (`--bg` → `--bg-hover`), border goes
  `--border` → `--border-strong`. Do **not** change color on hover for the accent
  button — use `--accent-hover` which is `+` luminosity.
- **Press:** `transform: scale(0.98)` on buttons, `scale(0.94)` on icon buttons. No
  color change. `translateY(1px)` on the big gradient login CTA.
- **Focus:** `box-shadow: var(--ring)` — a 3px semi-transparent accent halo. Input
  border also turns `--accent` on focus.

### Borders, dividers

- **Subtle dividers** (`--border-subtle`) for section breaks inside a panel.
- **Strong dividers** (`--border-strong`) only on button boundaries that hover.
- **Dashed** only for empty/placeholder states (e.g. `.tool-output` placeholder) and
  the research-tools row separator.
- **Left accent bars** (`border-left: 3px solid var(--accent)`) are a signature motif
  for cron-push messages, permission cards, and tool cards showing state (`running`
  = accent, `done` = success, `error` = danger).

### Glass / blur

- `backdrop-filter: blur(12px)` on the login aside mark and `blur(6px)` on the mobile
  sidebar backdrop. Use sparingly — it's a *mobile* + *login* flourish, not an
  app-chrome staple.

### Card pattern

Default card = `background: var(--bg-elevated); border: 1px solid var(--border);
border-radius: var(--radius-lg); padding: var(--space-5); box-shadow: var(--shadow-sm)`.
Elevate to `--shadow-md` on hover if interactive.

### Layout rules

- Chat content column caps at **780px** (`.messages-inner` / `.composer-inner` both use
  `max-width: 780px; margin: 0 auto`).
- App grid is `272px sidebar | 1fr main` on desktop; sidebar slides off-canvas below 860px.
- Safe-area insets (`env(safe-area-inset-*)`) are honored everywhere — this is a real
  PWA, not a desktop-only site.
- `overflow: hidden` on the body; internal scrollers do their own work. No page-level
  scroll in the app.

### Imagery

The product has **no photography**. The only "image" in the brand is the logo mark.
Agent avatars are either single-letter initials on the accent color, or emoji. For
marketing mocks, suggest abstract product screenshots (terminal output, chat bubbles)
rather than stock photos.

### Corner radii in use

- `brand-mark` (small, 30px) → `md` (10px)
- `login-brand-mark` (48px) → `lg` (14px)
- `empty-brand` (72px) → custom 22px
- `msg.user` bubble → `xl` (18px)
- `composer-inner` → `xl` (18px)
- `login-card` → `2xl` (24px)
- Status dots, pills, toggle track → `full`

---

## Iconography

**System:** the entire app uses **inline SVG with `stroke="currentColor"`,
`stroke-width="2"`, `stroke-linecap="round"`, `stroke-linejoin="round"`** — the
*Feather* / *Lucide* visual family. Icon sizes are `14 / 15 / 16 / 18` for UI and
`22` for landing feature cards. All icons inherit color from context (muted in
default, accent on hover, success/danger for status).

**Library:** not a package — icons are hand-authored SVG literals inlined in HTML and
JS. When you need an icon that doesn't already exist in the repo, pull the closest
match from [Lucide](https://lucide.dev/) (CDN: `https://cdn.jsdelivr.net/npm/lucide@latest/dist/umd/lucide.js`)
— same stroke weight, same visual family. **Flagged substitution:** Lucide is not
bundled in the repo; I'm recommending it as the closest match.

**No icon font.** No `fa-` classes, no Material Icons. Don't introduce one.

**Emoji:**
- **Avatars** — agents have emoji avatars (`🤖` is the default; users can pick their own).
- **Section flags** — only in the codebase README, never in product UI.
- **Success ticks** — the auth success states use `✓` (U+2713) at 32px, not a checkmark SVG.
- **Otherwise: no.** Never sprinkle emoji into buttons, headings, or body copy.

**Unicode chars as icons:** yes, sparingly — `×` for modal close, `→` for landing CTAs
(`立即开始 →`), `✓` for success, `···` for overflow menus. Kept tight.

**Logo:** see `assets/logo.svg`. It's an orange reticle (bullseye + crosshairs) in
`#ff7b00` on `#0d1117`. The PWA `theme_color` (`#0d1117`) is a legacy deeper black
than the app's `--bg` (`#1a1a1d`) — keep both; the logo is designed for the deeper.

---

## UI kits

Only one: **`ui_kits/openclaude-web/`**. It covers landing + chat app + admin console
because they share tokens, components, and language. See its README for component
index and the interactive `index.html`.

---

## Caveats

- **No font files shipped.** Substituted platform/Google fallbacks. Ask user to
  attach real TTFs if they're hosting Inter / JetBrains Mono / Source Serif locally.
- **No Figma link provided.** Everything is derived from the code. If a Figma source
  exists, share the link and I'll reconcile.
- **Admin console partially covered.** The chat/landing surfaces are the focus; admin
  is summarized in the UI kit but not drilled into component-by-component.
- **Screenshot reference is zero.** The design is reverse-engineered from CSS tokens
  and DOM structure only — some subjective color calls (exact shadow opacities,
  hover delta) are my best reading of the tokens, not pixel-measured.
