---
name: v5-harmony-app
description: Develop, review, debug, test, or release the independently evolved OpenClaude v5 Aurora HarmonyOS app under apps/harmony. Use for ArkUI-native UI and system capability adaptation, constrained ArkWeb compatibility, HarmonyOS security policy, DevEco emulator/device validation, HAP signing, or AppGallery delivery.
---

# V5 Harmony App

Treat the HarmonyOS client as an independently evolving native product. Keep the v5 web and server as protocol authorities, but do not use a thin WebView shell as the product architecture.

## Route the work

- Use `feat/v5-harmony-app` as the long-lived canonical app branch. Do not merge it back into `feat/v5-aurora-rewrite` and delete it like an ordinary v5 feature branch.
- Keep app code under `apps/harmony/**`. Make shared server, protocol, or web changes in a separate v5 worktree and protected PR; then deliberately sync the compatible commit into the app branch.
- Read `apps/harmony/README.md`, `docs/V5_DEV_PLAYBOOK.md`, and the nearest `AGENTS.md` / `CLAUDE.md` before editing.
- Also apply the `deveco-cli` skill. Use `devecocli` for project creation, build, test packaging, emulator/device operations, run, logs, and local HarmonyOS documentation.
- Before editing, record `git status -sb` and the base commit. Preserve unrelated work and assign disjoint files to parallel workers.

## Build native-first features

- Implement the primary mobile experience in ArkUI: app navigation, session entry points, settings, loading/error/offline states, keyboard and safe-area behavior, and system capability affordances.
- Prefer HarmonyOS system surfaces for document picking, downloads, sharing, microphone permission, notifications, external links, and lifecycle recovery.
- Reuse the server's authentication, conversation, billing, connector, and WebSocket authorities. Do not create a second client-side business state machine or store access/refresh credentials in native storage.
- Keep ArkWeb as a compatibility surface for web-only flows. Make the native shell useful even when a web selector changes or the network is unavailable.
- Support phone, tablet, and 2-in-1 layouts. Test resizing, landscape, font scaling, keyboard overlap, status/navigation avoid areas, pointer/keyboard input where applicable, and back-navigation semantics.

## Preserve the compat-v1 security contract

Apply all of these checks together; none is a substitute for another:

1. Run compatibility behavior only for the exact primary origin `https://claudeai.chat` with HTTPS, the exact hostname, and the default port. Treat lookalike hosts, credentials in URLs, non-default ports, and other schemes as external or blocked.
2. Increment a navigation generation on every main-frame navigation. Capture the generation before asynchronous work or script execution and discard any result whose generation is no longer current.
3. Put an origin check inside every injected script before it reads or changes the DOM: `location.origin === 'https://claudeai.chat'`. A native pre-check alone does not close the navigation race.
4. Treat selectors as a versioned compat-v1 contract. If a required selector is missing, ambiguous, or structurally unexpected, stop enhancement and fall back to the unmodified safe web flow. Never broaden selectors opportunistically.
5. For same-document React transitions, permit only the synchronous, no-return `auroraNativeShellLifecycleV1.contractChanged(number)` lifecycle proxy. Observe only the fixed contract fingerprint under the unique `#root`, send only the navigation generation, and independently re-run the complete native contract before changing UI. Configure both object- and method-level `permission` for HTTPS plus the exact host. Empty permission `port` and `path` mean "not checked", so synchronously validate `getLastJavascriptProxyCallingFrameUrl()` for the default port and absent URL credentials inside every proxy call.
6. Serialize evaluation and rollback within the navigation generation and component lifecycle epoch. Coalesce a busy signal into at most one pending retry. On teardown, first make the proxy object inactive and invalidate its epoch, then call `deleteJavaScriptRegister`, whose deletion only takes effect after the next reload.
7. Do not expose cookies, bearer tokens, local storage, page text, business payloads, return data, native navigation, or arbitrary script execution to native code. Keep commands allowlisted, minimal, and idempotent.

Do not introduce `WebMessagePort` merely to avoid polling or selector work. Migrate only after the first-party web app exposes a reviewed, versioned handshake and a sustained bidirectional event stream is genuinely required. The migration must bind the exact origin, navigation generation, schema version, per-navigation nonce, and a narrow command/event allowlist; fail closed on mismatch and never carry authentication secrets. Until then, keep compat-v1 one-way and bounded, and never add a general JavaScript bridge.

## Keep navigation and capabilities constrained

- Keep normal external HTTPS links in the system browser. For OAuth that must retain an HttpOnly state cookie, show the full provider hostname in native UI and require explicit confirmation before loading it in ArkWeb.
- Grant web permissions only to the exact primary origin and only after the matching HarmonyOS runtime permission succeeds. Deny other requests.
- Disable local file access, mixed content, uncontrolled multi-window behavior, and script-created popups.
- Use system document pickers for uploads and saves. Sanitize filenames, use app cache as the intermediate download location, and clean up temporary files on success, failure, and cancellation.
- Keep application backup disabled while ArkWeb authentication state is present unless a separately reviewed credential-migration design replaces it.

## Validate behavior, not only compilation

From `apps/harmony` run the relevant sequence:

```bash
devecocli build clean
devecocli build
devecocli build --modules entry@ohosTest
devecocli device list
devecocli run --module entry@ohosTest --ability TestAbility --device <serial> --skip-build
devecocli log --keyword "total cases" --from 30s --tail 20 --bundle-name chat.claudeai.aurora --device <serial>
devecocli run --module entry --device <serial>
devecocli log --crash --bundle-name chat.claudeai.aurora --device <serial>
devecocli log --level E --from 5m --tail 200 --bundle-name chat.claudeai.aurora --device <serial>
```

- The user must personally accept emulator licenses in an interactive terminal. Do not accept them, delete a partial image, or retry a failed image download on the user's behalf.
- On an emulator, verify cold/warm launch, native navigation, back behavior, loading/offline/retry states, keyboard and layout resizing, selector-missing fallback, generation-stale result rejection, constrained lifecycle-proxy transitions, external-link/OAuth confirmation, and upload/download journeys.
- On a signed real device, verify no-refresh login activates the native bar, SPA logout removes it, rapid auth-state transitions do not leave a double header, microphone permission, document picker/save flows, system-browser round trips, background/foreground recovery, network switching, notifications/sharing if touched, crash logs, responsiveness, and power/memory behavior.
- Add pure ArkTS tests for navigation/origin/generation policy and an instrumented journey for each user-visible native interaction. Launch the generated `TestAbility` and verify Hypium reports zero failures; a compiled `ohosTest` HAP without execution is only partial evidence.
- Obtain an independent full-diff review to PASS for architecture and security before release.

## Release the app separately

- Classify `apps/harmony/**` as a manual `app-release` surface. App-only changes do not run `scripts/deploy-v5.sh`, do not enter the v5 server release queue, and never require a runtime image rebuild.
- Produce a release HAP/App, configure an authorized signing profile outside source control, install the signed artifact on a real device, and complete the AppGallery review checklist.
- If a batch also changes server, protocol, or web paths, split those changes and classify/deploy them with the normal v5 workflow. Do not deploy the app branch as a server release.
