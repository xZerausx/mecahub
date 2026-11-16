import type { Program } from "@mecahub/ir";
import { ManualClock } from "@mecahub/simulator";
import { createRuntime } from "../runtime.js";
import type { RunResult } from "../types.js";
import { FakeDevice } from "./fake-device.js";

export const flush = () => new Promise<void>((r) => setImmediate(r));

/** Lets pending microtasks (and chained continuations) run, without moving time. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await flush();
}

/** Moves the manual clock in `step` ms slices, settling after each (one macrotask yield per slice). */
export async function advance(clock: ManualClock, ms: number, step = 10): Promise<void> {
  for (let left = ms; left > 0; left -= step) {
    clock.advance(Math.min(step, left));
    await settle();
  }
}

export function harness(options: { random?: () => number } = {}) {
  const clock = new ManualClock();
  const device = new FakeDevice();
  const sounds: string[] = [];
  const enters: string[] = [];
  const events: string[] = [];
  const errors: { scriptId?: string; statementId?: string; code: string }[] = [];
  const runtime = createRuntime({
    device,
    clock,
    sound: { play: (name) => void sounds.push(name) },
    ...(options.random ? { random: options.random } : {}),
  });
  runtime.onBlockEnter((e) => {
    enters.push(e.statementId);
    events.push(`+${e.statementId}`);
  });
  runtime.onBlockExit((e) => events.push(`-${e.statementId}`));
  runtime.onError((e) =>
    errors.push({
      ...(e.scriptId ? { scriptId: e.scriptId } : {}),
      ...(e.statementId ? { statementId: e.statementId } : {}),
      code: e.error.code,
    }),
  );
  let result: RunResult | undefined;
  return {
    clock,
    device,
    runtime,
    sounds,
    enters,
    events,
    errors,
    /** Starts the program and lets the first synchronous stretch run. */
    async start(program: Program): Promise<void> {
      void runtime.run(program).then((r) => (result = r));
      await settle();
    },
    get result(): RunResult | undefined {
      return result;
    },
  };
}
