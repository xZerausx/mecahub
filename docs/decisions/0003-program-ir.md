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

- Scripts run in parallel.
- An event whose script is still running is ignored: the script is not restarted and the event is not queued.
- `forever` and `while` must yield to the scheduler on every iteration, so other scripts and STOP are never starved.
- `stopAll` halts every script and every motor (the STOP path, under 200 ms). `stopScript` ends only its own script.
- Every statement has an `id` (the source block id) so the UI can highlight the running block.
- Variables are numbers only in v1; the runtime resets them to `initial` when the program starts.

## Consequences

- Validation uses Ajv 8, which compiles the schema to code with `new Function`. A future Content-Security-Policy without `unsafe-eval` would need a precompiled (Ajv standalone) validator generated at build time. The schema and the `validateProgram` contract do not change.
- The schema and `types.ts` are maintained by hand; the drift tests are the safety net.
- Adding statement types, sensors or colors is a schema, type and runtime change reviewed together; changing the meaning of an existing one is an `irVersion` bump.
