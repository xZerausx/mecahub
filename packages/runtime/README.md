# @mecahub/runtime

Interpreter for the program IR (`@mecahub/ir`). It runs in Node (no browser APIs, no React) and
talks to the robot through a small `RuntimeDevice` interface.

```ts
import { createRuntime, fromMoveHub } from "@mecahub/runtime";

const runtime = createRuntime({ device: fromMoveHub(moveHub), sound });
runtime.onBlockEnter(({ statementId }) => highlight(statementId));
const result = await runtime.run(program); // never rejects: { reason, error? }
runtime.stop(); // synchronous, idempotent: STOP is handed to the link before it returns
```

- `RuntimeClock` (`now`, `setTimeout`, `clearTimeout`) is injectable; tests pass the simulator's
  `ManualClock`. The default uses the global timers.
- `src/test-support/` has `FakeDevice` and a simulator helper for tests.
- Semantics and the list of hardware assumptions: [ADR 0003](../../docs/decisions/0003-program-ir.md).
