---
name: openclaude-design
description: Use this skill to generate well-branded interfaces and assets for OpenClaude (原生 Claude Code 底座 · 商用 Claude Opus 托管服务), either for production or throwaway prototypes/mocks/slides. Contains essential design guidelines, colors, type, iconography rules, and a UI kit for prototyping the landing page, auth flow, chat app, and admin console.
user-invocable: true
---

Read the `README.md` file within this skill first — it contains full content
fundamentals (Chinese-first copywriting, tone, punctuation), visual foundations
(warm terracotta accent on ink/cream neutrals, stroke-2 Lucide iconography, 1px
border + shadow elevation, no hand-drawn illustrations), and an index of the
other files here.

Then, depending on the job:

- **If creating visual artifacts** (slides, mocks, throwaway prototypes, landing
  pages, deck exports): copy `colors_and_type.css` and any needed `assets/*`
  (logo.svg especially) into your output folder, reference them with `<link>`
  and `<img>`, and create static HTML. The tokens already define three-theme
  support — set `<html data-theme="dark">` or `"light"`; dark is default.

- **If working on the real OpenClaude codebase**: mirror the conventions in
  `packages/web/public/style.css` — CSS variables at `:root`, semantic
  component classes, no utility framework, Chinese copy only.

- **If prototyping specific UI** (chat view, composer, sidebar, login card,
  landing hero): start from `ui_kits/openclaude-web/` — the components there
  are cosmetic recreations you can copy and adapt. Don't invent new layouts
  for surfaces that already exist in the kit.

If the user invokes this skill without any other guidance, ask them:

1. What are they building? (landing section, app screen, deck slide, email, etc.)
2. Audience — Chinese-only, or bilingual?
3. Theme — dark (default) or light?
4. Does it need to be pixel-accurate to the existing app, or is it a new surface
   where you can push the visual system further?

Then act as an expert designer who outputs HTML artifacts or production code,
depending on the need. Always use `你` (not `您`), never sprinkle emoji into
product copy, and resist introducing colors outside the terracotta accent +
warm neutral scale.
