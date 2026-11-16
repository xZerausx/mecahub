# @mecahub/blocks

The block catalogue (Icons and Advanced levels) and its translation to and from the program IR
([ADR 0003](../../docs/decisions/0003-program-ir.md)). It runs in plain Node: no DOM, no React, and
`blockly` is imported with `import type` only (ESLint enforces it). Mounting the Blockly editor and
registering these blocks happens in `apps/web`, not here.

## What is in it

| Module           | What it does                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `spec.ts`        | `BLOCK_SPECS`: one declarative row per block (Blockly type, IR node, fields, inputs, shape). The single source of truth. |
| `definitions.ts` | `blockDefinitions(messages)`: Blockly JSON block definitions, labels and tooltips from i18n.                             |
| `toolbox.ts`     | `toolbox(messages, level)`: Advanced = categories with `mh_number` shadows; Icons = a flat flyout with no text.          |
| `icons.ts`       | `ICONS` / `iconSrc(name)`: our own 48x48 SVGs as `data:image/svg+xml` URIs for the Icons level.                          |
| `compile.ts`     | `compile(state)`: `Blockly.serialization.workspaces.save` JSON to a validated IR `Program`.                              |
| `decompile.ts`   | `decompile(program)`: IR `Program` to workspace JSON for `workspaces.load`.                                              |

Block types are prefixed `mh_`. All user-visible text lives in `content/i18n` under
`blocks.<type>.message`, `.tooltip`, `.option.<value>` and `.input.<NAME>`, plus
`blocks.category.<id>`. A message keeps Blockly's `%1..%n` tokens; a translation may reorder them.

## Levels

Every row has `level: "icons" | "advanced"`. **All definitions are always registered** (so a saved
program opens on either level); the level only decides what the toolbox offers.

The Icons level is eight `mh_icon_*` blocks that compile to **existing IR** (no new nodes): start
flag, forward, backward, turn left, turn right, light, hourglass, stop (no sound block: no audio
ships). They show no words, only pictures (`field_image`, image dropdown options); their i18n keys
`blocks.<type>.tooltip`, `.alt` and `.option.<v>` are the tooltip and the alt text. There is no
`.message`: `message0` is only `%n` tokens.

- Movement blocks and the hourglass have one small number, `STEPS` / `SECONDS`, an integer 1..9
  (a `count` field). The compiler scales it to the IR literal: forward `driveForDegrees` at +50/+50
  for `steps * 360` degrees; turns at -50/+50 (left) or +50/-50 (right) for `steps * ICON_TURN_DEGREES`;
  wait `steps * 1000` ms. A value outside 1..9 or not an integer is `bad-field`.
- The speeds, directions and `ICON_TURN_DEGREES` (180) are **supuesto**: `TODO(hw)` check the motor
  orientation and calibrate a turn on the 17101 build. They live in `spec.ts` (`ICON_DRIVE`, ...).
- `fixed` holds IR properties a block always sets, now also IR literals (`{ type: "number", value:
50 }`). The compiler copies them; the decompiler matches them by deep equality.
- `decompile(program, { level })`: at `"advanced"` (default) only Advanced blocks are produced. At
  `"icons"`, an icon block is used where it holds the node exactly (for example `driveForDegrees`
  +50/+50 for a whole number of turns, 1..9) and an Advanced block otherwise, so **an Icons program
  may decompile to Advanced blocks** (and the round trip through `compile` still holds).
- The Icons level looks best with the `zelos` renderer and a start scale around 1.5 (apps/web).

## Mounting notes

- Hats get their cap from a named block style: Blockly 13.4.0 ignores a top-level `hat` in JSON
  definitions and an inline `style` object is consumed by the first instance. Add `BLOCK_STYLES`
  to the theme (`Blockly.Theme.defineTheme(name, { base, blockStyles: BLOCK_STYLES })`) or hats
  render without the cap.

## Compiling

`compile` returns `{ ok: true, program }` or `{ ok: false, errors }`, each error
`{ blockId?, code, message }`. It never throws: its input comes from files.

- Each hat block with its stack is a script. Script id = hat block id; statement id = block id (the
  runtime highlights by statement id). Expression and shadow ids are dropped.
- Stacks that do not start with a hat, and disabled blocks, are ignored.
- An input with neither a block nor a shadow is `missing-input`; nothing is defaulted.
- Codes: `missing-input`, `type-mismatch`, `unknown-block`, `bad-field`, `too-large`. The result is
  always run through `validateProgram`; its errors (`zero-speed`, `out-of-range`, ...) come back with
  the nearest statement or script id as `blockId`.
- A top-level block with the `mh_` prefix and no spec (a tampered or newer file) is `unknown-block`; other foreign floating blocks are ignored.
- Variables come from the workspace `variables` list; they compile with `initial: 0`, and a reference
  to an undeclared id is `bad-field`.

## Time is shown in seconds

Blocks show seconds, the IR keeps milliseconds. A literal converts at compile time
(`Math.round(seconds * 1000)`, so anything under half a millisecond becomes 0 ms), any other
expression is wrapped in `* 1000`. A literal above `MAX_SECONDS` (3600) is a `bad-field` error on
the block; a negative one is left to the IR validation (`out-of-range` on the statement).

Decompile does the inverse. `compile(decompile(p))` deep-equals `p` for the IR examples and the
all-nodes fixture, with these documented exceptions:

- A non-literal millisecond expression that is not `x * 1000` (or has a literal `x`) comes back as
  `(x / 1000) * 1000`: the same meaning.
- A non-integer millisecond literal comes back rounded to whole milliseconds.
- A time literal over an hour does not compile back (`MAX_SECONDS`); `decompile` reports each as `{ code: "time-over-limit", statementId }` in `warnings`.
- A variable's `initial` is not kept (blocks have no place for it; it compiles as 0).
  `decompile` reports each one as `{ code: "variable-initial-dropped", variableId }` in `warnings`.

`decompile` never throws: an unknown IR node is `unknown-node` and nesting past `MAX_DEPTH` (100)
is `too-deep`, both as `{ ok: false, errors }`.

## Adding a block

1. Add the IR node in `packages/ir` (schema, types, field tables). `spec.test.ts` fails until a block
   covers it, and the slot kinds must match the IR tables.
2. Add the row to `BLOCK_SPECS`.
3. Add its `blocks.<type>.*` keys to `content/i18n/en.json` and `es.json` (`definitions.test.ts`
   checks the keys and the tokens).
4. Add a row to the table in `compile.test.ts`.

For an icon block: tag the row `level: "icons"`, give it a `pic(...)` argument (add the drawing to
`icons.ts`; `icons.test.ts` checks every icon is used and well formed) and the `.tooltip` / `.alt`
keys instead of `.message`.

## Out of scope

Mounting Blockly, registering the blocks at runtime, and a size cap for saved files.
