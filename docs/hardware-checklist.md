# Hardware checklist (real Move Hub, set 17101)

What the editor assumes about a real hub and nobody has measured yet. Every item is a `supuesto`
marked `TODO(hw)` in the code or in `docs/protocol-notes.md`. Run them with the editor in Chrome or
Edge (press "Connect the robot") and the lab page (`pnpm lab`) for the measurements. Record each
result in the table at the end, with the date, the hub firmware, the browser and the OS. A captured
result wins over the assumption: fix the assumption, not the capture (ADR 0002).

Safety for every step: lift the robot so the wheels spin free, keep a hand near the hub, and have the
STOP button (and Esc) ready.

## 1. ICON_DRIVE sign: +A, +B really is forward

- Where: `packages/blocks/src/spec.ts` (`ICON_DRIVE` = 50, forward = +A,+B, back = -A,-B).
- Steps: build "when flag, Forward x1" in the Icons level, press Connect the robot, pick the hub, Run.
  Then "Back x1".
- Expected: Forward drives the robot toward the end the 17101 build calls the front; Back the opposite.
  The preview's arrows (drawn from the sign of the commanded speed) agree with the real wheels.
- If not: flip the sign in `spec.ts` (one constant per direction) and update the compile tests; the
  preview then follows by itself.

## 2. ICON_TURN_DEGREES = 180 per step

- Where: `packages/blocks/src/spec.ts` (`ICON_TURN_DEGREES`, `ICON_STEP_DEGREES` = 360 per forward step).
- Steps: on the floor, "Turn left x1", then x4. Mark the start heading.
- Expected: one step turns the robot about 90 degrees (a quarter turn); four steps come back to the
  start heading, within what a child would call "the same way".
- Record: measured degrees of turn per step and the surface. Calibrate the constant on the 17101 build.

## 3. STOP latency on the real hub (mandatory budget: < 200 ms)

- Where: `docs/protocol-notes.md` ("STOP by frames needs a write latency budget"), lab page.
- Steps: (a) lab page, "Measure write latency": record p50, p95, max. (b) In the editor, run a
  program that drives forward for a long time, film the robot and the screen at 60 fps or more, press
  STOP; count the frames from the press to the wheels standing. Repeat with Esc, 10 times each.
- Expected: write p95 well under 37 ms; wheels stopped < 200 ms after the press, every time.
- Record: the latency numbers, the worst of the 10 stops for each of STOP and Esc, and the video file.

## 4. Link drop with the motors running

Two different cases, because the hub is not known to react the same way.

- Clean disconnect (the app closes the link): Run a long forward program, then press "Back to the
  simulator". Expected: the wheels stop (STOP frames go out first, then the link closes); the hub's own
  stop on a clean GATT disconnect is already captured (2026-11-15).
- Silent loss (the hub goes out of range or loses power to the radio): Run a long forward program, walk
  the robot out of range or switch the hub off and on. Expected in the app: the preview dims, the wheels
  show "unknown", the badge shows the link-lost pictogram, STOP never throws. Open question: how long the
  hub takes to notice the dead link (supervision timeout) and whether it stops its motors then.
- Record: seconds until the hub stopped, or "never"; what the screen showed.

## 5. Reconnect without the chooser

- Steps: connect the hub, Run, switch the hub off and on (or walk out of range and back), press Run
  again without touching the Bluetooth button.
- Expected: the editor reconnects to the same hub with no chooser and runs. If Chrome asks to pick the
  device again, the browser forgot the permission: record it, the editor would then show the
  connect-failed pictogram and the child has to press Connect the robot again.
- Record: browser, OS, whether the chooser appeared, seconds to reconnect.

## 6. The unsupported message in Firefox and Safari

- Steps: open the app in Firefox, then in Safari (desktop and iOS).
- Expected: the "Connect the robot" button is disabled and the note "This browser can't use Bluetooth.
  Open the app in Chrome or Edge." (or the Spanish one) is visible next to it; the simulator works.
- Record: browser and version, a screenshot.

## 7. Chooser left open while switching back

- Steps: press Connect the robot, leave the chooser open, press Back to the simulator (or Esc), then
  pick the hub in the chooser; also try hub -> simulator -> hub quickly.
- Expected: no link to the hub survives (the editor refuses the late connect); a second chooser opens
  normally. TODO(hw): what Chrome does on a second requestDevice while the first chooser is still
  open is unverified.

## Results

| Item | Date | Firmware | Browser / OS | Result | Evidence (file, video) |
| ---- | ---- | -------- | ------------ | ------ | ---------------------- |
| 1    |      |          |              |        |                        |
| 2    |      |          |              |        |                        |
| 3    |      |          |              |        |                        |
| 4    |      |          |              |        |                        |
| 5    |      |          |              |        |                        |
| 6    |      |          |              |        |                        |
| 7    |      |          |              |        |                        |
