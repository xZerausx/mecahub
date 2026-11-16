# @mecahub/web

The PWA. The main page (`/`) is the block editor; `dev/*.html` are developer pages (simulator, lab,
connect) that are not part of the production bundle.

## Run the editor

```sh
pnpm dev     # http://localhost:5173/
pnpm e2e     # Playwright: drags blocks, runs, stops (needs `pnpm exec playwright install chromium` once)
```

The editor runs the program on the **simulator** (`SimulatorTransport` -> `MoveHub` -> `fromMoveHub`
-> `createRuntime`), see `src/editor/editor-controller.ts`. The preview in the top bar shows the
simulated hub light and the two wheels; it exposes `data-led`, `data-wheel-a` and `data-wheel-b` for
the e2e tests.

- **Levels**: Icons (default; pictures only, zelos renderer, scale 1.5, a flat flyout) and Advanced
  (categories, the full catalogue). Switching re-injects Blockly and keeps the program, but not the undo history, scroll position or zoom; both levels'
  blocks are always registered.
- **STOP** is always enabled, so is Esc; both call `runtime.stop()` synchronously. The mandatory
  budget test is in `editor-controller.test.ts` (`STOP_BUDGET_MS` = 200 ms, simulator with 30 ms
  write latency; it does not prove what the real hub does: supuesto, `TODO(hw)`).
- **Compile errors** mark the offending block (a red glow, no text) and send nothing to the hub.

## How Blockly is wired (`src/editor/blockly-setup.ts`)

`packages/blocks` stays Node-only; everything that needs the Blockly runtime lives here.

- `ensureBlockly(locale)` registers the Blockly UI messages and `blockDefinitions(messages)` once.
- `mecahubTheme()` is `Theme.defineTheme("mecahub", { base: Classic, blockStyles: BLOCK_STYLES })`.
  `BLOCK_STYLES` is what gives the hats their cap; without it they render flat.
- `workspaceOptions(level, locale)` builds the `Blockly.inject` options. It sets `media` to
  `public/blockly-media/` (a copy of the sprites and cursors of the `blockly` package, no audio) and
  `sounds: false`, because Blockly otherwise loads them from `static.blockly.com` and the app makes no
  network requests (the e2e suite checks it).
- `BlocklyWorkspace.tsx` injects in an effect and disposes in the cleanup (StrictMode safe).

## Assumptions still to verify on hardware (`TODO(hw)`)

All in `packages/blocks/src/spec.ts`: `ICON_DRIVE` (50) and the wheel directions (forward = +A,+B;
turn left = -A,+B), `ICON_STEP_DEGREES` (360 per forward step) and `ICON_TURN_DEGREES` (180 per turn
step; calibrate on the 17101 build).

## Follow-ups

- A real hub: build the `BleTransport` for Web Bluetooth (`@mecahub/transport`) and pass it to `MoveHub`
  instead of the simulator; a device picker (connect button) is needed for the user gesture.
- Saving and loading programs, sound, a mobile (Capacitor) shell.
