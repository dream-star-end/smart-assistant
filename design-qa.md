# Aurora Windows Codex-style design QA

final result: passed

## Evidence

- Primary reference: `/var/folders/95/rvcv0gj15zlb211ph_fbmlr80000gn/T/codex-clipboard-178d84e6-35e5-4f2a-9f4f-0c34d5971cb1.png`
  - 2560 x 1320
  - active Codex task with the right utility inspector open
- Secondary reference: `/var/folders/95/rvcv0gj15zlb211ph_fbmlr80000gn/T/codex-clipboard-7f5eccf6-264c-4c0a-a291-7eb31070b0db.png`
  - 2560 x 1320
  - Codex settings density, grouping, borders, and pale blue-gray navigation surface
- Final normal-workspace capture: `/tmp/aurora-codex-desktop-normal-v4.png`
  - 1280 x 800, light theme, 100% zoom, animations disabled
  - 44px trusted app bar plus the visible local no-account product-isolation fixture
- Final modal capture: `/tmp/aurora-codex-desktop-v4.png`
  - 1280 x 800, light theme, 100% zoom, animations disabled
  - local no-account smoke fixture with the trusted downloads surface open
- Split-view source captures: `/tmp/aurora-codex-desktop-v4-toolbar.png` and
  `/tmp/aurora-codex-desktop-v4-product.png`
  - exact 1280 x 44 shell and 1280 x 756 product WebContents captures
- Combined comparison input: `/tmp/aurora-codex-compare-v4.png`
  - reference, normal workspace, and downloads modal placed together on normalized panels

The central remote product content is intentionally excluded from fidelity scoring. Aurora keeps the
V5 product as the only authority for projects, sessions, and chat, and does not copy or invent those
records in the trusted desktop shell. The Windows native title bar is also outside the Electron
content capture.

## Fidelity surfaces

- 44px compact application bar with a static product/workspace identity
- neutral white content surfaces and pale blue-gray workspace background
- hairline borders, restrained radius, low-elevation shadow, and compact system typography
- right-aligned utility panel hierarchy and density
- icon scale and alignment using vendored Microsoft Fluent UI System Icons
- Windows-specific high contrast, reduced transparency, keyboard focus, and minimum-window behavior

## Comparison history

### Pass 1

- P1: live download updates could replace the focused action button and let focus escape the modal.
- P1: the 520 x 360 empty state could be clipped by fixed minimum heights.
- P1: mask icons did not have an explicit forced-color rendering contract.
- P1: the application bar still used an inline approximation instead of the repository Aurora asset.
- P2: faint 11px explanatory text did not meet the intended contrast target.

Corrections: restored focus by opaque download ID, made drawer content flex within the available
height, added deterministic forced-color icon rules and smoke assertions, replaced the inline mark
with the exact Aurora asset through the allowlisted protocol, and raised the faint-text contrast.

### Pass 2

- P1: the normal product view had no proven keyboard route into the independent shell WebContents.
- P1: the narrow breakpoint removed the connection status's only readable text from the accessibility tree.
- P2: the visual evidence covered only the downloads modal, not the normal app bar plus product layout.

Corrections: added bidirectional F6 pane cycling with modal-safe focus ownership and real-input smoke
coverage; changed narrow status copy from `display:none` to a screen-reader-preserving clip; captured
the exact toolbar and product viewports and assembled the normal 1280 x 800 workspace image.

### Pass 3

- P0: none
- P1: none
- P2: none

Independent UI/accessibility review passed the frozen normal workspace, downloads modal, 520 x 360
layout, F6 focus cycle, forced-colors/reduced-transparency contracts, real assets, and product-data
boundary. Windows 10/11 Narrator, high-contrast, 200% scaling, and live V5 content remain public-release
gate items rather than claims made by this local review.

Visible differences from Codex are deliberate product/platform boundaries: Windows keeps its native
frame and Snap behavior; Aurora exposes only real download and recovery data; the remote product is
hidden while a trusted modal is active so pointer, keyboard, and accessibility focus cannot cross
between independent WebContents views.

## Verification

- Local icon references and the protocol allowlist are checked together.
- The Electron smoke uses real input events for More, Downloads, Escape, Retry, bidirectional F6,
  and restored product interaction.
- The smoke verifies modal product visibility/focus isolation, dynamic download focus preservation,
  indeterminate progress, forced-color fallback, 520 x 360 layout, and 1366 x 768 layout.
- The final reference, normal workspace, and modal implementation captures were inspected together
  after the fixes above, and the independent UI/accessibility reviewer reported PASS.
