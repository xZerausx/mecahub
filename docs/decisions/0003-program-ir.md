# 0003. Program IR

Status: accepted

## Context

[0001](0001-monorepo-structure.md) decided that blocks compile to an intermediate representation (IR) that `runtime` interprets. This ADR fixes what that IR is: its package, format, versioning and the semantics both sides must agree on.

## Decision

### A separate package, `@mecahub/ir`

The IR has three consumers: the block compiler (`blocks`), the interpreter (`runtime`) and, later, a Pybricks Python exporter. `blocks` must not depend on `runtime` (the compiler has nothing to do with Bluetooth or scheduling), and `runtime` must not depend on Blockly. A package both depend on is the only shape that keeps those arrows apart. It is pure TypeScript with no browser APIs, so it runs in Node and in the browser.

### JSON plus a JSON Schema

A program is plain JSON, described by `packages/ir/schema/program.schema.json` (draft 2020-12, `$id` `https://mecahub.invalid/schema/program-v1.json`: an identifier, never fetched). The schema is the normative description; `src/types.ts` is its hand-written TypeScript mirror, and `src/schema.test.ts` fails when enums, discriminants or field names drift apart. Objects are closed (`additionalProperties: false`) and statements, expressions and triggers carry a `type` discriminator. Plain JSON can be saved with a project, diffed, shared and fed to other tools.

### Versioning

`irVersion` is an integer, currently 1. A change that old readers could misread bumps it, and the new version ships with a migration from the previous one. The validator rejects any other value with the code `unsupported-version`.

### Symbolic ports and fixed units

Programs name ports (`A`-`D`; `AB` is the drive pair, addressed by the drive statements) and never LWP3 port ids, which the hub assigns. Units are fixed: speed in percent (-100..100), time in milliseconds, angles in degrees. Colors use the LWP3 color table names. Distance is the sensor's raw level until calibrated (`TODO(hw)`). Tilt names directions (`forward`, `backward`, `left`, `right`); the hub-frame signs are still open (`docs/protocol-notes.md`), so mapping them is the runtime's job. Sound names (`beep`, `horn`, `laser`, `robot`, `cheer`) are ours; the hub has no speaker, so sounds play on the device running the app, and no audio ships yet.

### Two-layer validation

`validateProgram(value)` never throws and returns either the typed program or a list of `{ path, code, message }`.

1. Schema layer: shape, enums, port rules (color and distance sensors only on C or D, tilt sensors take no port), and range of number _literals_ (speed -100..100, durations, angles and counts integers >= 0).
2. Semantic layer, only if the schema passed: unique ids across scripts and statements, unique variable ids and names, declared variables, `random` with literal `min <= max`.

Ranges of computed values (a variable used as a speed) are not statically known: the runtime clamps them. `message` is developer-facing English; the UI will map `code` to i18n strings.

### Execution semantics

Scheduling:

- Scripts run in parallel.
- Triggers are edge-triggered: an event fires on the transition into its condition and re-arms once the condition is false again. An event whose script is still running is ignored: the script is not restarted and the event is not queued.
- Every loop construct must yield to the scheduler: `forever` and `while` on every iteration, `repeat` on every iteration (also with an empty body) and `waitUntil` on every poll of its condition. Otherwise one script could starve the others and STOP.
- `stopAll` halts every script and every motor (the STOP path, under 200 ms). `stopScript` ends only its own script.
- Every statement has an `id` (the source block id) so the UI can highlight the running block.

Motors:

- Last command wins per port: a new command on a port replaces the running one on that port. A drive statement on AB replaces the commands on A and on B, and a command on A or B replaces the drive.
- There is no separate "set speed" statement: use `motorStart` / `driveStart` again with the new speed.
- Turning in place is `driveForDegrees` with opposite speeds; `degrees` is the rotation of each motor.
- Speed 0 in a `*ForTime` statement waits the time with the motor stopped. A `*ForDegrees` statement with a literal speed of 0 is rejected by the validator (`zero-speed`; for the pair, only when both speeds are literal 0, since a pivot turn uses one wheel); a computed speed that evaluates to 0 skips the command.
- The runtime clamps computed values: speed to -100..100, times, angles and counts to integers >= 0.

Values:

- Variables are numbers only in v1; the runtime resets them to `initial` when the program starts.
- Division by zero gives 0. `mod` is the floored modulo (the result has the sign of the divisor) and `mod` by zero gives 0.
- `playSound` does not block the script; to wait for a sound, use `wait`.
- `motorPosition` is relative to the position at connect time. There is no reset block in v1 (a candidate for v2).

### Limits

`validateProgram` takes untrusted input, so it is bounded: at most 200 scripts, 500 variables and 1000 statements per list (schema `maxItems`, code `too-many`), and at most 20,000 objects and arrays in the whole program, counted iteratively before the schema runs (code `too-large`). With those bounds Ajv can report every error (`allErrors`) in bounded time, so there is a single validator. At most 100 errors are returned. On success the program is returned as a copy (`structuredClone`).

## Runtime (`@mecahub/runtime`)

The interpreter that executes these semantics. It runs in Node (no browser APIs, no React) and reaches the robot only through a narrow `RuntimeDevice` interface; `fromMoveHub(hub)` adapts the hub layer to it. A recording test double lives in the package's `src/test-support/` and is not exported.

- `createRuntime({ device, clock?, sound?, random? })` returns `run(program)` (never rejects; resolves `completed`, `stopped`, `stopAll` or `error`), a synchronous idempotent `stop()`, `running`, and `onBlockEnter` / `onBlockExit` / `onError` / `onFinished`. `run()` validates first (`invalid-program`), refuses a second program while one runs (`busy`) and refuses programs that need a missing motor or sensor before anything moves (`missing-device`).
- One `AbortController` per run and one per script (`stopScript` aborts only its own). Every wait goes through an abortable `sleep` / `race`, and every device call is preceded by an `aborted` check, so nothing is sent after STOP. `stop()` aborts, hands the STOP frames to the device and drops the subscriptions, all synchronously. `stop()` hands STOP to the device first, then aborts. Every `stop()` call sends STOP, also when nothing is running: the result and `onFinished` come once, the extra STOPs are deliberate. A `stopAll` that throws or rejects still ends the run and is reported as `stop-failed` through `onError`.
- Stop through `runtime.stop()`. If the app stops the hub directly (`hub.stopAll()`, `disconnect()`), a pending timed command resolves "discarded" with its port claim intact; the runtime reads that as an external STOP and ends the run as `stopped`, so nothing is sent after it.
- Loops yield one macrotask (`clock.setTimeout(0)`) on every iteration and on every `waitUntil` poll.
- The runtime subscribes only to the sensors the program reads and waits for their first value (2 s, then `sensor-timeout`). Event scripts use one edge detector each. A condition that is already true when the run starts fires once. A program with event scripts never finishes by itself.
- A hub error ends the run: STOP first, then `onError`, then the result.
- Last command wins per port through a `PortArbiter`: a statement waiting on a port that another command replaces ends and its script continues. If a `driveFor*` with unequal speeds is replaced on one wheel only, the other wheel's timed command keeps running on the hub until it expires.

Assumptions (`supuesto`, all `TODO(hw)`):

- Tilt directions: forward is +y, backward -y, right +x, left -x, firing at 20 degrees and re-arming below 15 (hysteresis). The hub-frame signs are not measured.
- `distance` and `distanceBelow` use the units of the sensor's mode 8 (inches). Calibration to cm is open.
- `motorPosition` is relative to the first position reading of the run, not to connect time. This differs from the semantics above ("relative to the position at connect time"); the runtime cannot see connect time through the device seam.
- The hub reports the current value right after a sensor subscription is set up. Without it the run ends with `sensor-timeout`.
- `driveForTime` / `driveForDegrees` have no hub command for the virtual port, so they run `runFor` / `rotate` on A and B in parallel. The two motors finish independently, so unequal speeds do not draw a straight line the way the virtual port might. With one speed at 0, that wheel is held (brake) instead of left alone. Times above 32767 ms are sent as chunks.
- Sounds go to an injected `SoundSink` and are not awaited; the default plays nothing.
- A program that completes on its own ends with a STOP, like any other run: a finished program never leaves a motor running (decided 2026-11-15, safety for young users). `onFinished` fires after that STOP is handed to the device, so a run started from it is ordered after the STOP; a late `stop-failed` from the finished run may still reach `onError` while the next run is active.

## Consequences

- Validation uses Ajv 8, which compiles the schema to code with `new Function`. A future Content-Security-Policy without `unsafe-eval` would need a precompiled (Ajv standalone) validator generated at build time. The schema and the `validateProgram` contract do not change.
- The schema and `types.ts` are maintained by hand; the drift tests are the safety net.
- Adding statement types, sensors or colors is a schema, type and runtime change reviewed together; changing the meaning of an existing one is an `irVersion` bump.
