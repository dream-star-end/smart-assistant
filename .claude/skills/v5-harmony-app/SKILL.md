---
name: v5-harmony-app
description: Develop, review, debug, test, or release the independently evolved OpenClaude v5 Aurora HarmonyOS app under apps/harmony. Use for ArkUI-native UI and system capability adaptation, constrained ArkWeb compatibility, HarmonyOS security policy, DevEco emulator/device validation, HAP signing, or AppGallery delivery.
---

# V5 Harmony App

Treat the HarmonyOS client as an independently evolving, ChatGPT-style chat-first product. Keep the v5 web and server as the protocol and business authorities while using a constrained native shell for HarmonyOS navigation, lifecycle, security, and system integrations; do not turn it into either a marketing workbench or an unmanaged thin WebView.

## Route the work

- Use `feat/v5-harmony-app` as the long-lived canonical app branch. Do not merge it back into `feat/v5-aurora-rewrite` and delete it like an ordinary v5 feature branch.
- Keep app code under `apps/harmony/**`. Make shared server, protocol, or web changes in a separate v5 worktree and protected PR; then deliberately sync the compatible commit into the app branch.
- Read `apps/harmony/README.md`, `docs/V5_DEV_PLAYBOOK.md`, and the nearest `AGENTS.md` / `CLAUDE.md` before editing.
- Also apply the `deveco-cli` skill. Use `devecocli` for project creation, build, test packaging, emulator/device operations, run, logs, and local HarmonyOS documentation.
- Before editing, record `git status -sb` and the base commit. Preserve unrelated work and assign disjoint files to parallel workers.

## Build the chat-first native shell

- Make the conversation the home experience. Only when a cold launch finds an empty Navigation path stack may the native layer auto-enter the Web destination; warm launch or an existing stack must not push a duplicate destination.
- Keep sessions, messages, agent/model selection, and the Composer under Web authority. ArkUI may supply only the edge session control, settings, loading/error/offline state, keyboard and safe-area behavior, OAuth confirmation, and HarmonyOS system capability affordances.
- Prefer HarmonyOS system surfaces for document picking, downloads, sharing, microphone permission, notifications, external links, and lifecycle recovery.
- Reuse the server's authentication, conversation, billing, connector, and WebSocket authorities. Do not create a second client-side business state machine or store access/refresh credentials in native storage.
- Render one 52vp conversation header: retain the Web-owned agent/model controls in the center and overlay only the native session and settings controls at the edges. If the versioned selector contract fails, roll back every enhancement and expose the complete unmodified safe Web flow.
- While the explicit `mobile-session-v1` Sheet marker is open, keep the validated Web shell active but suspend every native header/offline/progress overlay; restore those overlays only after the same generation-bound observer sees the marker close. This prevents native controls from leaking above the Web drawer and its scrim.
- Use `?client=harmony` for the Harmony Web entry. Its logged-out AuthGate is a shared Web companion change that must be developed on a separate branch from `feat/v5-aurora-rewrite`, pass protected review, and then be deliberately synced into the app branch. Never deploy shared Web or server code from the app branch.
- Support phone, tablet, and 2-in-1 layouts. Test resizing, landscape, font scaling, keyboard overlap, status/navigation avoid areas, pointer/keyboard input where applicable, and back-navigation semantics.

## Keep the chat-first lifecycle

- Do not add a workbench, “enter conversation” CTA, dashboard, or floating “app control” sheet. Keep Web, full-screen settings, privacy, and about as explicit routes; opening settings above Web must retain the same Web controller and conversation.
- Reconcile ArkWeb lifecycle through one idempotent function gated by both destination-active and controller-attached state. Pair exactly one native activation/deactivation with proxy attach/detach, and reject stale async callbacks with the lifecycle epoch.
- Queue native requests such as reload while Web is covered. Consume a queued request exactly once only after Web is active and attached; retain it if the controller is not ready.
- Bind downloads to a Web-instance epoch. Before actual Web-instance destruction, invalidate the epoch, cancel every active `WebDownloadItem`, and clear its target cache. A stale delegate finish/fail callback may clean up only its matching epoch/item; it must never delete a newer same-GUID target, open the save picker, or show a toast after the user has left that Web instance.
- Make system back a pure ordered policy: dismiss pending OAuth confirmation; navigate or cancel the active OAuth flow; dismiss a Web top layer only through the explicit, versioned mobile-session contract; navigate ordinary Web history; then call `moveAbilityToBackground()`. Use ability termination only as the fallback on 2-in-1 devices that do not support moving the app to the background. Never pop to a workbench, dispose the retained controller, or manufacture a new controller for a later entry CTA.
- Use ShareKit for the action named “系统分享” with the system share symbol. Share only the fixed public URL `https://claudeai.chat/`; never derive a session URL or read page text, storage, cookies, or tokens.
- Treat touch haptics as optional enhancement: use a supported soft preset, keep intensity restrained, and never block or fail an action when vibration is unavailable.
- Give primary native screens and controls stable component IDs. Drive instrumented tests by ID rather than coordinates or visible localized text.


## Preserve the compat-v1 security contract

Apply all of these checks together; none is a substitute for another:

1. Run compatibility behavior only for the exact primary origin `https://claudeai.chat` with HTTPS, the exact hostname, and the default port. Treat lookalike hosts, credentials in URLs, non-default ports, and other schemes as external or blocked.
2. Increment a navigation generation on every main-frame navigation. Capture the generation before asynchronous work or script execution and discard any result whose generation is no longer current.
3. Put an origin check inside every injected script before it reads or changes the DOM: `location.origin === 'https://claudeai.chat'`. A native pre-check alone does not close the navigation race.
4. Treat the single-header selectors as a versioned compat-v1 contract. The Web ChatHeader and its agent/model controls must satisfy the reviewed unique structure before native edge controls or 52vp styling appear. If a required selector is missing, ambiguous, or structurally unexpected, roll back all enhancement and fall back to the complete unmodified safe Web flow. Never broaden selectors opportunistically.
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
devecocli build --modules entry@default --build-mode test
devecocli build --modules entry@ohosTest --build-mode test
devecocli device list
devecocli run --module entry --build-mode test --device <serial> --skip-build
devecocli run --module entry@ohosTest --build-mode test --ability TestAbility --device <serial> --skip-build
HDC_BIN="/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/toolchains/hdc"
"$HDC_BIN" -t <serial> shell "aa test -b chat.claudeai.aurora -m entry_test -s timeout 30000 -s unittest OpenHarmonyTestRunner -w 60000"
devecocli run --module entry --device <serial>
devecocli log --crash --bundle-name chat.claudeai.aurora --device <serial>
devecocli log --level E --from 5m --tail 200 --bundle-name chat.claudeai.aurora --device <serial>
```

- The user must personally accept emulator licenses in an interactive terminal. Do not accept them, delete a partial image, or retry a failed image download on the user's behalf.
- On an emulator, verify empty-stack cold launch enters the conversation, warm launch does not duplicate it, the conversation has one 52vp header, full-screen settings retain the Web controller, the complete back-policy order, loading/offline/retry states, keyboard and layout resizing, selector-missing unmodified-Web fallback, generation-stale result rejection, constrained lifecycle-proxy transitions, external-link/OAuth confirmation, and upload/download journeys.
- On a signed real device, verify the logged-out `?client=harmony` AuthGate, no-refresh login activates the native bar, SPA logout removes it, rapid auth-state transitions do not leave a double header, microphone permission, document picker/save flows, system-browser round trips, phone/tablet background behavior, 2-in-1 terminate fallback, foreground recovery, network switching, notifications/sharing if touched, crash logs, responsiveness, and power/memory behavior.
- Add pure ArkTS tests for navigation/origin/generation policy and an instrumented journey for each user-visible native interaction. Install the freshly built `test`-mode main HAP before installing the matching `entry@ohosTest`; the test HAP alone does not refresh the main HAP. Then execute the generated `OpenHarmonyTestRunner` through `aa test`; directly starting `TestAbility` leaves `AbilityDelegator` unavailable and is not valid UI-test evidence. Require `Failure: 0, Error: 0`; a compiled `ohosTest` HAP without execution is only partial evidence.
- Build the deterministic instrumented journey in the explicit `test` build mode. Only that mode may bootstrap at `about:blank`, use `WebviewController.loadData` to load a local account-free compat document with the exact primary origin as `baseUrl`, and allow the generated internal data-document URL. `debug` and `release` must always resolve the production `?client=harmony` URL. The journey must fail loudly if real compat controls or settings are unavailable, verify visible bounds/interactivity and the absence of the removed workbench, exercise drawer overlay suspend → system Back → restore, and prove the retained Web controller identity survives settings and reload.
- Obtain an independent full-diff review to PASS for architecture and security before release.

## Release the app separately

- Classify `apps/harmony/**` as a manual `app-release` surface. App-only changes do not run `scripts/deploy-v5.sh`, do not enter the v5 server release queue, and never require a runtime image rebuild.
- Produce a release HAP/App, configure an authorized signing profile outside source control, install the signed artifact on a real device, and complete the AppGallery review checklist.
- If a batch also changes server, protocol, or web paths, split those changes and classify/deploy them with the normal v5 workflow. Do not deploy the app branch as a server release.
