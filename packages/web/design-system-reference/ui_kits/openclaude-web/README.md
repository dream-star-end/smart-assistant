# OpenClaude Web — UI Kit

Interactive recreation of the OpenClaude web app, covering the three main surfaces:

1. **Landing** (`#landing-view` in original) — marketing hero, pricing card, CTA
2. **Auth** (`#login-view`) — split-screen login card over aurora background
3. **App** (`#app-view`) — sidebar + composer + chat stream with tool cards

Open `index.html` and toggle between surfaces from the floating **Surface** switcher
in the top-right. Each surface is wired up with fake interactive state — the composer
actually "sends" messages, the sidebar selects conversations, modals open/close.

## Component index

| File | Used by |
|---|---|
| `Button.jsx` | Primary, secondary, ghost, icon variants |
| `Chip.jsx` | Status pills, model badges, segmented toggles |
| `Sidebar.jsx` | App left rail (conversation list, brand mark, new-chat button) |
| `MessageList.jsx` | Chat stream + user/assistant bubbles + tool cards |
| `Composer.jsx` | Sticky bottom input w/ model picker, attach, send |
| `ToolCard.jsx` | Running / done / error cards with left-accent bar |
| `Modal.jsx` | Settings / agents / persona dialogs |
| `LandingHero.jsx` | Marketing hero + pricing + FAQ surface |
| `LoginCard.jsx` | Auth card over aurora aside |

Tokens come from `../../colors_and_type.css`. Components are deliberately cosmetic —
no real routing, no real API calls, fake state only.

## Cross-referenced source

- `packages/web/public/index.html` lines 10–1046
- `packages/web/public/style.css` (full file, 4910 lines)
- Brand mark: `assets/logo.svg`
