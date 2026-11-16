# @mecahub/web

The PWA. The main page (`/`) is the block editor; `dev/*.html` are developer pages (simulator, lab,
connect) that are not part of the production bundle.

## Run the editor

```sh
pnpm dev     # http://localhost:5173/
pnpm e2e     # Playwright: drags blocks, runs, stops (needs `pnpm exec playwright install chromium` once)
```

The editor runs the program on the **simulator** (`SimulatorTransport` -> `MoveHub` -> `fromMoveHub`
-> `createRuntime`) or, on request, on a **real hub** over Web Bluetooth, see
`src/editor/editor-controller.ts`. The preview in the top bar shows the hub light and the two wheels;
it exposes `data-source` (`simulator` or `hub`), `data-led`, `data-wheel-a`, `data-wheel-b` and, when
a hub link dropped, `data-stale` for the e2e tests.

- **One controller, two rigs.** A rig is a transport, a `MoveHub` and a runtime that belong together;
  exactly one is current. `useHub()` builds the hub rig and must be called synchronously from the
  click (the Bluetooth chooser needs the user gesture); `useSimulator()` halts the robot, drops the
  link and rebuilds the simulator. `connect()` (called on mount) never opens the chooser. Without Web
  Bluetooth (`hubAvailable` false, e.g. Firefox or Safari) the button is disabled and explains why.
- **Connection**: `snapshot.source` is `simulator` or `hub`; `snapshot.connection` adds `dropped`
  (a hub link that ended without being asked: the next Run reconnects without the chooser). A dismissed
  chooser goes back to the simulator silently.
- **The hub preview mirrors the commanded wheels and LED** (`hub-mirror.ts`), not measured motion; after
  a drop the wheels are `unknown` and the robot is dimmed. The simulator keeps drawing what its motors do.
- **Problems** (`problem.ts`, `ProblemBadge.tsx`): errors reach the child as one pictogram inside the
  preview (`role="status"`, hidden text for screen readers), cleared by the next Run or by tapping it.
  The block that was running when a runtime error happened gets the red glow.
- **Browser tests of the hub flow** run against a simulator-backed hub transport that exists only on
  the dev server (`VITE_E2E_FAKE_HUB=1`, set by `playwright.config.ts`, and `?fakeHub=1` in the URL).
  `vite.config.ts` pins the flag to `"0"` in a build, and `e2e/hub-source.spec.ts` reads the production
  bundle to prove the fake is not in it.

- **Levels**: Icons (default; pictures only, zelos renderer, scale 1.5, a flat flyout) and Advanced
  (categories, the full catalogue). Switching to Advanced asks first in an in-app modal (Cancel has the focus; Esc cancels and still stops). Switching re-injects Blockly and keeps the program, but not the undo history, scroll position or zoom; both levels'
  blocks are always registered.
- **STOP** is always enabled, so is Esc; both call `runtime.stop()` synchronously. The mandatory
  budget tests are in `editor-controller.test.ts` (simulator rig) and `editor-controller.hub.test.ts`,
  `EditorPage.hub-stop.test.tsx` (hub rig: the Web Bluetooth adapter over a scripted
  `navigator.bluetooth` bridged to a simulated hub); `STOP_BUDGET_MS` = 200 ms, 30 ms write latency.
  They do not prove what the real hub does: supuesto, `TODO(hw)` (see `docs/hardware-checklist.md`).
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

More in `docs/hardware-checklist.md`: the steps to verify the real hub (drive sign, turn degrees, STOP
latency, link drops, reconnect, the unsupported message).

## Follow-ups

- Saving and loading programs, sound, a mobile (Capacitor) shell.
