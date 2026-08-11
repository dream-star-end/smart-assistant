# Aurora HarmonyOS Chat-first Design QA

## Evidence

- source visual truth path: `/Users/dengxuan/.codex/visualizations/2026/08/09/019fe5da-b0d4-7372-8913-256874c455d8/harmony-redesign/references/chatgpt.png`
- implementation screenshot path: `/Users/dengxuan/.codex/visualizations/2026/08/09/019fe5da-b0d4-7372-8913-256874c455d8/harmony-redesign/13-local-companion-chat.jpeg`
- full-view comparison evidence: `/Users/dengxuan/.codex/visualizations/2026/08/09/019fe5da-b0d4-7372-8913-256874c455d8/harmony-redesign/18-chatgpt-comparison-final.png`
- focused header/composer evidence: `/Users/dengxuan/.codex/visualizations/2026/08/09/019fe5da-b0d4-7372-8913-256874c455d8/harmony-redesign/19-header-composer-comparison-final.png`
- sessions drawer evidence: `/Users/dengxuan/.codex/visualizations/2026/08/09/019fe5da-b0d4-7372-8913-256874c455d8/harmony-redesign/15-sessions-drawer-final.jpeg`
- drawer-close restoration evidence: `/Users/dengxuan/.codex/visualizations/2026/08/09/019fe5da-b0d4-7372-8913-256874c455d8/harmony-redesign/16-chat-after-drawer-back.jpeg`
- full-screen settings evidence: `/Users/dengxuan/.codex/visualizations/2026/08/09/019fe5da-b0d4-7372-8913-256874c455d8/harmony-redesign/10-settings-from-chat.jpeg`

## Viewport and normalization

- implementation viewport: Pura 90 HarmonyOS emulator, `440 x 952vp`, density `3`, captured at `1320 x 2856px`.
- source board: `444 x 960px`; the phone-content crop was `330 x 704px` at `(57, 194)` and normalized to `444 x 960px`.
- implementation normalization: `1320 x 2856px` downsampled to `444 x 960px` for the same comparison input.
- the source is a framed marketing capture rather than a raw device screenshot. The small aspect correction is recorded and only product-shell hierarchy, density, navigation and composer treatment were judged.

## State

- light theme, active public demo conversation, phone portrait.
- the safe public `demo=1` state was used only for visual QA so no account, cookie, token or private conversation was inspected. The production app URL was restored to `https://claudeai.chat/?client=harmony` before the final build.
- the local Web companion build was used so the exact `mobile-session-v1` contract could be exercised before its protected Web branch is deployed.

## Findings

No actionable P0, P1 or P2 finding remains.

- Typography: both screens use their platform-native sans families. Aurora's Chinese hierarchy, weights, truncation and code typography remain readable at the normalized viewport. The SF Pro versus HarmonyOS system-font difference is expected platform adaptation.
- Spacing and layout: the app has one compact 52vp header, a full-height conversation canvas and a persistent bottom composer. It no longer has a dashboard, hero, card grid or intermediate CTA. The Aurora agent/model controls make the center denser than the reference, but they remain one row and are intentional product capabilities.
- Colors and tokens: neutral white/gray surfaces and black primary text follow the reference hierarchy. Aurora's purple/green identity is limited to brand and semantic accents rather than large decorative gradients.
- Image quality and assets: the source and demo contain different dynamic conversation media, so image subject fidelity is not applicable to the shell comparison. Aurora uses the real product icon, HarmonyOS Symbols and the Web product's icon set; no placeholder, emoji or CSS-drawn substitute is present.
- Copy and content: Chinese product copy is coherent and task-oriented. Dynamic demo messages were not judged as static app copy.
- Icons and affordances: the left two-line sessions control and right ellipsis control now match the reference semantics and have 44vp native hit targets. The bottom composer remains the dominant action.
- Interaction states: the sessions drawer owns its header and scrim without native controls leaking above it; system Back closes the drawer and restores the native edge controls. Settings is a full-screen native destination rather than the rejected “应用控制” popup.
- Accessibility: primary native controls retain stable IDs and accessibility labels, use system symbols, and meet the 40vp minimum touch-target guidance.

## Comparison history

1. First comparison
   - evidence: `/Users/dengxuan/.codex/visualizations/2026/08/09/019fe5da-b0d4-7372-8913-256874c455d8/harmony-redesign/04b-chatgpt-comparison-before.png`
   - P2: the native `open_sidebar` and `more` symbols rendered as a directional menu and four-tile grid, recalling the old app-control affordance rather than ChatGPT's simple menu/ellipsis pair.
   - fix: replaced them with the real HarmonyOS `line_2_horizontal` and `ellipsis_circle` symbols.
   - post-fix visual evidence: `18-chatgpt-comparison-final.png` and `19-header-composer-comparison-final.png`.

2. Drawer interaction comparison
   - earlier evidence: `/Users/dengxuan/.codex/visualizations/2026/08/09/019fe5da-b0d4-7372-8913-256874c455d8/harmony-redesign/11-sessions-drawer.jpeg`
   - P1: native edge controls remained above the Web Sheet portal; the left control crossed the Aurora logo and the right ellipsis floated above the scrim.
   - fix: the Web Sheet exposes one explicit versioned marker; the native generation-bound observer watches `document.body`, accepts at most one marker and keeps the shell active while suspending native header/offline/progress overlays. Closing the marker restores them. Duplicate markers fail closed.
   - post-fix visual evidence: `15-sessions-drawer-final.jpeg`; restoration evidence: `16-chat-after-drawer-back.jpeg`.

## Primary interactions tested

- cold launch enters the conversation surface without a workbench.
- left native control opens the Web-owned sessions drawer.
- system Back closes the top layer before Web history or app background handling.
- right ellipsis opens full-screen native settings; native Back returns to the retained conversation.
- drawer opening hides native overlays and drawer closing restores them.
- the explicit test-mode, same-origin offline fixture exercised the real native controls, drawer hide → system Back → restore, retained controller, and complete settings/reload journey fail-loud; the final instrumented run passed 53/53 with zero failures or errors.
- Back continues probing the exact versioned top-layer marker during asynchronous shell reevaluation, and ability termination remains limited to background error `16000061`.

## Residual release checks

- Repeat the same states on a signed phone after the Web companion PR is merged and deployed.
- Recheck tablet/2-in-1 resizing, keyboard overlap, microphone/document pickers and AppGallery signing on real hardware.

final result: passed
