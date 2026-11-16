import { decode } from "@mecahub/lwp3";
import type { PortOutputCommandMessage } from "@mecahub/lwp3";
import type { Program } from "@mecahub/ir";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { realRuntimeClock } from "./clock.js";
import { createRuntime } from "./runtime.js";
import type { Runtime } from "./runtime.js";
import { fromMoveHub } from "./from-move-hub.js";
import { advance, settle, harness } from "./test-support/harness.js";
import { countingClock } from "./test-support/clock.js";
import { onStart, program, resetIds, s, script } from "./test-support/ir.js";
import { startSim } from "./test-support/sim.js";

// Mandatory (CLAUDE.md): STOP must halt all motors in < 200 ms, always.
//
// Same scope as packages/simulator/src/stop.test.ts: these prove the app-side path (runtime ->
// hub layer -> write queue with urgent frames -> simulated hub) with a 30 ms write latency. They do
// NOT prove what the real Move Hub does on StartPower 127 or how fast: supuesto, TODO(hw).
const A = 0x00;
const B = 0x01;
const BUDGET_MS = 200;
const LATENCY_MS = 30;

const example = (name: string): Program =>
  JSON.parse(
    readFileSync(new URL(`../../ir/examples/${name}.json`, import.meta.url), "utf8"),
  ) as Program;

afterEach(() => {
  vi.useRealTimers();
  resetIds();
});

type Sim = Awaited<ReturnType<typeof startSim>>;

const still = ({ hub }: Sim) => [A, B].every((p) => hub.motorState(p).speed === 0);

/** Output commands sent to the hub from frame `from` on, decoded. */
const outputsSince = ({ sim }: Sim, from: number) =>
  sim.sentFrames
    .slice(from)
    .map((f) => decode(f))
    .filter((m): m is PortOutputCommandMessage => "type" in m && m.type === "portOutputCommand");

/** Is this output command one of the STOP frames (StartPower 127 or StartPower2 127/127)? */
const isStopFrame = ({ command: c }: PortOutputCommandMessage): boolean =>
  (c.sub === "startPower" && c.power === 127) ||
  (c.sub === "startPower2" && c.power1 === 127 && c.power2 === 127);

async function setup(options: { realTimers?: boolean } = {}) {
  const sim = await startSim({ latency: LATENCY_MS, ...options });
  const clock = countingClock(realRuntimeClock);
  const runtime = createRuntime({ device: fromMoveHub(sim.moveHub), clock });
  return { ...sim, runtime, clock, all: sim };
}

/** Runs `halt` (a STOP), steps 5 ms until every motor is still, and returns the elapsed ms. */
async function haltedIn(halt: () => void, all: Sim): Promise<number> {
  const t0 = Date.now();
  halt();
  while (!still(all) && Date.now() - t0 < 1000) await vi.advanceTimersByTimeAsync(5);
  return Date.now() - t0;
}

async function expectCleanStop(
  runtime: Runtime,
  rig: Awaited<ReturnType<typeof setup>>,
  framesBefore: number,
  result: Promise<unknown>,
  reason: string,
) {
  expect(await result).toMatchObject({ reason });
  expect(runtime.running).toBe(false);
  expect(still(rig.all)).toBe(true);
  // after the halt only STOP frames command motors, and nothing else moves them later
  const outputs = outputsSince(rig.all, framesBefore);
  expect(outputs.length).toBeGreaterThan(0);
  expect(outputs.every(isStopFrame)).toBe(true);
  await vi.advanceTimersByTimeAsync(2000);
  expect(outputsSince(rig.all, framesBefore)).toHaveLength(outputs.length);
  expect(still(rig.all)).toBe(true);
  expect(rig.clock.pending).toBe(0);
  rig.close();
}

describe("STOP through the runtime and the simulated hub (30 ms write latency)", () => {
  it("halts a forever example (dance) mid-motion in < 200 ms", async () => {
    const rig = await setup();
    const result = rig.runtime.run(example("07-dance-forever"));
    await vi.advanceTimersByTimeAsync(800);
    expect(still(rig.all)).toBe(false);
    const before = rig.sim.sentFrames.length;
    const elapsed = await haltedIn(() => rig.runtime.stop(), rig.all);
    expect(elapsed).toBeLessThan(BUDGET_MS);
    await expectCleanStop(rig.runtime, rig, before, result, "stopped");
  });

  it("halts motors whose statements are waiting for the hub's feedback", async () => {
    const rig = await setup();
    const result = rig.runtime.run(
      program([
        onStart("a", [s.forTime("A", 60, 20_000)]),
        onStart("b", [s.forTime("B", -60, 20_000)]),
      ]),
    );
    await vi.advanceTimersByTimeAsync(300);
    expect(still(rig.all)).toBe(false);
    const before = rig.sim.sentFrames.length;
    const elapsed = await haltedIn(() => rig.runtime.stop(), rig.all);
    expect(elapsed).toBeLessThan(BUDGET_MS);
    await expectCleanStop(rig.runtime, rig, before, result, "stopped");
  });

  it("halts a tight loop that only sets a variable (a yielding loop never starves STOP)", async () => {
    const rig = await setup();
    const result = rig.runtime.run(
      program(
        [onStart("a", [s.driveStart(50, 50)]), onStart("spin", [s.forever([s.change("v", 1)])])],
        [{ id: "v", name: "v", initial: 0 }],
      ),
    );
    await vi.advanceTimersByTimeAsync(300);
    expect(still(rig.all)).toBe(false);
    const before = rig.sim.sentFrames.length;
    const elapsed = await haltedIn(() => rig.runtime.stop(), rig.all);
    expect(elapsed).toBeLessThan(BUDGET_MS);
    await expectCleanStop(rig.runtime, rig, before, result, "stopped");
  });

  it("the stopAll statement halts everything in < 200 ms and ends the run with reason stopAll", async () => {
    const rig = await setup();
    const stopAll = s.stopAll();
    let t0 = 0;
    rig.runtime.onBlockEnter((e) => {
      if (e.statementId === stopAll.id) t0 = Date.now();
    });
    const result = rig.runtime.run(
      program([
        onStart("go", [s.driveStart(50, -50), s.forTime("A", 40, 20_000)]),
        onStart("halt", [s.wait(400), stopAll]),
      ]),
    );
    await vi.advanceTimersByTimeAsync(399);
    expect(still(rig.all)).toBe(false);
    const before = rig.sim.sentFrames.length;
    while (t0 === 0) await vi.advanceTimersByTimeAsync(1);
    while (!still(rig.all) && Date.now() - t0 < 1000) await vi.advanceTimersByTimeAsync(5);
    expect(Date.now() - t0).toBeLessThan(BUDGET_MS);
    await expectCleanStop(rig.runtime, rig, before, result, "stopAll");
  });
});

describe("STOP at the device seam", () => {
  it("stop() hands STOP to the device synchronously and cancels what was about to run", async () => {
    const h = harness();
    await h.start(
      program([onStart("a", [s.forTime("A", 50, 1000), s.led("red"), s.start("B", 5)])]),
    );
    h.device.complete(); // the next statement is now one microtask away...
    h.runtime.stop(); // ...but STOP comes first, in the same tick
    expect(h.device.log).toEqual(["motor.A.runFor(1000,50)", "stopAll"]);
    await settle();
    expect(h.device.log).toEqual(["motor.A.runFor(1000,50)", "stopAll"]);
    expect(h.result).toEqual({ reason: "stopped" });
    expect(h.clock.pending).toBe(0);
  });

  it("is idempotent: the result and onFinished come once; every stop() call re-sends STOP", async () => {
    const h = harness();
    const finished: string[] = [];
    h.runtime.onFinished((r) => finished.push(r.reason));
    await h.start(program([onStart("a", [s.forever([s.wait(10)])])]));
    h.runtime.stop();
    h.runtime.stop(); // nothing is running now: an extra STOP, which is cheap and wanted
    h.runtime.stop();
    await settle();
    expect(finished).toEqual(["stopped"]);
    expect(h.result).toEqual({ reason: "stopped" });
    expect(h.device.log.filter((l) => l === "stopAll")).toHaveLength(3);
  });

  it("a program that completes on its own sends STOP, so no motor is left running", async () => {
    const h = harness();
    await h.start(program([onStart("a", [s.start("A", 50)])]));
    expect(h.result).toEqual({ reason: "completed" });
    expect(h.device.log).toEqual(["motor.A.run(50)", "stopAll"]);
  });

  it("stop() with nothing running still sends STOP", async () => {
    const h = harness();
    await h.start(program([onStart("a", [s.start("A", 50)])]));
    h.runtime.stop();
    expect(h.device.log).toEqual(["motor.A.run(50)", "stopAll", "stopAll"]);
  });

  it("on the simulator, a completed program leaves every motor still within the budget", async () => {
    vi.useFakeTimers();
    const all = await setup();
    const done = all.runtime.run(program([onStart("a", [s.start("A", 50), s.start("B", -50)])]));
    let ms = 0;
    let finished = false;
    void done.then(() => (finished = true));
    while (!finished && ms < 1000) {
      await vi.advanceTimersByTimeAsync(5);
      ms += 5;
    }
    expect(await done).toEqual({ reason: "completed" });
    const t0 = ms;
    while (!still(all) && ms - t0 < 1000) {
      await vi.advanceTimersByTimeAsync(5);
      ms += 5;
    }
    expect(still(all)).toBe(true);
    expect(ms - t0).toBeLessThan(BUDGET_MS);
    const sent = outputsSince(all, 0);
    expect(sent.some((m) => !isStopFrame(m))).toBe(true); // the program did command the motors
    expect(isStopFrame(sent.at(-1)!)).toBe(true); // and the run ended with STOP (StartPower2 on AB)
  });

  it("a script that has not started its statement yet never sends after STOP", async () => {
    const h = harness();
    await h.start(
      program([
        onStart("a", [s.wait(100), s.start("A", 50)]),
        onStart("b", [s.wait(100), s.led("red")]),
      ]),
    );
    h.clock.advance(100); // both timers fire, continuations are queued
    h.runtime.stop();
    await settle();
    expect(h.device.log).toEqual(["stopAll"]);
  });

  it("a hub error stops everything and says so through onError", async () => {
    const h = harness();
    h.device.failNext = { prefix: "led(", error: new Error("link lost") };
    await h.start(
      program([onStart("a", [s.forever([s.wait(10)])]), onStart("b", [s.wait(30), s.led("red")])]),
    );
    h.clock.advance(30);
    await settle();
    expect(h.errors).toMatchObject([{ scriptId: "b", code: "hub-error" }]);
    expect(h.device.log.at(-1)).toBe("stopAll");
    expect(h.result?.reason).toBe("error");
    expect(h.clock.pending).toBe(0);
  });

  it("reports a failed STOP write through onError", async () => {
    const h = harness();
    h.device.stopResult = { ok: false };
    await h.start(program([onStart("a", [s.forever([s.wait(10)])])]));
    h.runtime.stop();
    await settle();
    expect(h.errors).toMatchObject([{ code: "stop-failed" }]);
  });
});

describe("STOP when the device misbehaves", () => {
  it.each(["throw", "reject"] as const)(
    "a stopAll that %ss still ends the run, drops subscriptions and reports stop-failed",
    async (failure) => {
      const h = harness();
      h.device.stopFailure = failure;
      await h.start(
        program([
          script("b", { type: "buttonPressed" }, [s.forTime("A", 50, 1000)]),
          onStart("w", [s.forever([s.wait(10)])]),
        ]),
      );
      expect(() => h.runtime.stop()).not.toThrow();
      await settle();
      expect(h.result).toEqual({ reason: "stopped" });
      expect(h.runtime.running).toBe(false);
      expect(h.device.subscriptions).toEqual([]);
      expect(h.errors).toMatchObject([{ code: "stop-failed" }]);
      expect(h.clock.pending).toBe(0);
    },
  );

  it("STOP is the first thing finish() does: before listeners or aborts run", async () => {
    const h = harness();
    await h.start(program([onStart("a", [s.forever([s.wait(10)])])]));
    const order: string[] = [];
    h.runtime.onFinished(() => order.push(`finished after ${h.device.log.at(-1)}`));
    h.runtime.stop();
    expect(order).toEqual(["finished after stopAll"]);
  });
});

describe("a STOP that did not come from the runtime", () => {
  it("ends the run when a pending command is discarded by a hub-level stop", async () => {
    const h = harness();
    await h.start(program([onStart("a", [s.forTime("A", 50, 1000), s.led("red")])]));
    h.device.complete("motor.A", "discarded"); // what hub.stopAll() does to pending feedback
    await settle();
    expect(h.result).toEqual({ reason: "stopped" });
    expect(h.device.log).toEqual(["motor.A.runFor(1000,50)", "stopAll"]);
  });

  it("the same for rotate and for a pending chunk of a long timed command", async () => {
    const h = harness();
    await h.start(
      program([
        onStart("a", [s.forDegrees("A", 50, 90), s.led("red")]),
        onStart("b", [s.forTime("B", 50, 70_000), s.led("blue")]),
      ]),
    );
    h.device.complete("motor.B", "completed"); // first chunk done, second goes out
    await settle();
    h.device.complete("motor.A", "discarded");
    await settle();
    expect(h.result).toEqual({ reason: "stopped" });
    expect(h.device.log).not.toContain("led(red)");
    expect(h.device.log).not.toContain("led(blue)");
  });

  it("a takeover by another script still just ends the replaced statement", async () => {
    const h = harness();
    await h.start(
      program([
        onStart("a", [s.forTime("A", 50, 5000), s.led("red")]),
        onStart("b", [s.wait(100), s.start("A", -20)]),
      ]),
    );
    await advance(h.clock, 120); // b took over A: a's statement ended, both scripts finished
    await settle();
    // The completion STOP settles a's abandoned runFor as "discarded" after the run is done: that
    // late "discarded" must not count as an external STOP (no second STOP, result unchanged).
    expect(h.device.pending).toHaveLength(0);
    expect(h.device.log).toEqual([
      "motor.A.runFor(5000,50)",
      "motor.A.run(-20)",
      "led(red)",
      "stopAll",
    ]);
    expect(h.runtime.running).toBe(false); // both scripts simply finished
    expect(h.result).toEqual({ reason: "completed" });
  });
});

describe("STOP edge cases", () => {
  it("run() right after stop() starts a fresh run while the old STOP is in flight", async () => {
    const h = harness();
    await h.start(program([onStart("a", [s.forever([s.wait(10)])])]));
    h.runtime.stop();
    const second = h.runtime.run(program([onStart("b", [s.led("red")])]));
    await settle();
    expect(await second).toEqual({ reason: "completed" });
    expect(h.device.log).toEqual(["stopAll", "led(red)", "stopAll"]);
  });

  it("stop() called from an onBlockEnter listener cancels that very statement", async () => {
    const h = harness();
    const led = s.led("red");
    h.runtime.onBlockEnter((e) => e.statementId === led.id && h.runtime.stop());
    await h.start(program([onStart("a", [s.wait(5), led, s.led("blue")])]));
    await advance(h.clock, 20);
    expect(h.device.log).toEqual(["stopAll"]);
    expect(h.result).toEqual({ reason: "stopped" });
  });

  it("STOP while an event script's statement awaits a hub write", async () => {
    const h = harness();
    await h.start(
      program([script("b", { type: "buttonPressed" }, [s.forTime("A", 50, 1000), s.led("red")])]),
    );
    h.device.pushButton(true);
    await settle();
    expect(h.device.pending).toHaveLength(1);
    h.runtime.stop();
    await settle();
    expect(h.device.log).toEqual([
      "subscribe(button)",
      "motor.A.runFor(1000,50)",
      "stopAll",
      "unsubscribe(button)",
    ]);
    expect(h.result).toEqual({ reason: "stopped" });
    expect(h.clock.pending).toBe(0);
  });
});

describe("STOP on the wall clock (real timers, performance.now)", () => {
  it("halts both motors in < 200 ms of real time", async () => {
    vi.useRealTimers();
    const rig = await setup({ realTimers: true });
    const result = rig.runtime.run(
      program([
        onStart("a", [s.driveStart(60, 60)]),
        onStart("spin", [s.forever([s.forTime("A", 60, 5000)])]),
      ]),
    );
    await new Promise((r) => setTimeout(r, 250));
    expect(still(rig.all)).toBe(false);
    const t0 = performance.now();
    rig.runtime.stop();
    while (!still(rig.all) && performance.now() - t0 < 1000) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(BUDGET_MS);
    expect(await result).toEqual({ reason: "stopped" });
    expect(rig.clock.pending).toBe(0);
    rig.close();
  });
});
