# @mecahub/ir

The program IR: the JSON the block compiler emits and the runtime interprets. Pure TypeScript, no browser APIs and no React, so it runs in Node and in the browser.

- `schema/program.schema.json`: JSON Schema (draft 2020-12), the normative description.
- `src/types.ts`: the hand-written TypeScript types; `src/schema.test.ts` checks they match the schema.
- `examples/`: ten valid programs (also used by the tests).

```ts
import { validateProgram } from "@mecahub/ir";

const result = validateProgram(JSON.parse(text));
if (result.ok) run(result.program);
else for (const e of result.errors) console.log(e.path, e.code, e.message);
```

`validateProgram` never throws. Layer 1 is the schema, layer 2 (unique ids, declared variables, literal `random` ranges) runs only if layer 1 passed. `code` is a stable key for UI i18n; `message` is developer-facing.

Design, versioning and the execution rules (parallel scripts, event re-trigger, loop yielding, STOP) are in [docs/decisions/0003-program-ir.md](../../docs/decisions/0003-program-ir.md).

Validation uses [Ajv](https://ajv.js.org/) 8 (MIT license).
