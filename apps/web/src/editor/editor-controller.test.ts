import { afterEach, describe, expect, it, vi } from "vitest";
import {
  STOP_BUDGET_MS,
  createEditorController,
  type EditorController,
} from "./editor-controller.js";

// Vectors: workspace JSON written by hand from the Blockly serialization layout
// ('derivado del layout', same as packages/blocks compile tests).

type Raw = Record<string, unknown>;
const block = (type: string, id: string, fields?: Raw, next?: Raw): Raw => ({
  type,
  id,
  ...(fields ? { fields } : {}),
  ...(next ? { next: { block: next } } : {}),
});
const state = (...blocks: Raw[]): Raw => ({
  blocks: { languageVersion: 0, blocks },
  variables: [],
});
/** flag -> forward x9 -> led. */
const forwardProgram = (): Raw =>
  state(
    block(
      "mh_icon_when_start",
      "h",
      undefined,
      block("mh_icon_forward", "f", { STEPS: 9 }, block("mh_icon_led", "l", { COLOR: "red" })),
    ),
  );

const made: EditorController[] = [];
const make = async (latency = 30): Promise<EditorController> => {
  vi.useFakeTimers();
  const c = createEditorController({ simWriteLatencyMs: latency });
  made.push(c);
  const connecting = c.connect();
  await vi.advanceTimersByTimeAsync(300);
  await connecting;
  return c;
};

afterEach(() => {
  for (const c of made.splice(0)) c.dispose();
  vi.useRealTimers();
});

const moving = (c: EditorController) =>
  c.getSnapshot().wheels.a !== "stopped" || c.getSnapshot().wheels.b !== "stopped";

describe("run", () => {
  it("compiles and runs the program on the simulator: wheels move, the LED shows", async () => {
    const c = await make();
    const result = c.run(forwardProgram());
    await vi.advanceTimersByTimeAsync(500);
    expect(c.getSnapshot()).toMatchObject({
      running: true,
      wheels: { a: "forward", b: "forward" },
    });
    expect(moving(c)).toBe(true);
    c.stop();
    await vi.advanceTimersByTimeAsync(500);
    expect(await result).toBe("stopped");
    expect(c.getSnapshot().running).toBe(false);
  });

  it("shows the LED colour a program sets", async () => {
    const c = await make();
    const result = c.run(
      state(
        block("mh_icon_when_start", "h", undefined, block("mh_icon_led", "l", { COLOR: "red" })),
      ),
    );
    await vi.advanceTimersByTimeAsync(500);
    expect(await result).toBe("completed");
    expect(c.getSnapshot().led).toBe("red");
    expect(moving(c)).toBe(false); // a finished program leaves nothing running
  });

  it("reports compile errors on the offending block and sends nothing to the hub", async () => {
    const c = await make();
    const frames = c.sentFrames();
    const bad = state(
      block("mh_icon_when_start", "h", undefined, block("mh_icon_forward", "f", { STEPS: 99 })),
    );
    expect(await c.run(bad)).toBe("invalid");
    expect(c.getSnapshot().errorBlockIds).toEqual(["f"]);
    expect(c.getSnapshot().running).toBe(false);
    expect(c.sentFrames()).toBe(frames);
    // the next valid run clears the marks
    void c.run(forwardProgram());
    expect(c.getSnapshot().errorBlockIds).toEqual([]);
  });

  it("highlights the running block and clears it when the block ends", async () => {
    const c = await make();
    const seen: (string | undefined)[] = [];
    c.subscribe(() => seen.push(c.getSnapshot().highlightedBlockId));
    void c.run(forwardProgram());
    await vi.advanceTimersByTimeAsync(300);
    expect(seen).toContain("f");
    expect(c.getSnapshot().highlightedBlockId).toBe("f");
    c.stop();
    await vi.advanceTimersByTimeAsync(500);
    expect(c.getSnapshot().highlightedBlockId).toBeUndefined();
  });

  it("refuses a second run while one is running instead of stacking them", async () => {
    const c = await make();
    void c.run(forwardProgram());
    await vi.advanceTimersByTimeAsync(300);
    expect(await c.run(forwardProgram())).toBe("busy");
  });
});

describe("STOP", () => {
  // Mandatory (CLAUDE.md): STOP must halt all motors in < 200 ms, always. Same scope as
  // packages/runtime/src/stop.test.ts: the app-side path with a 30 ms write latency; what the real
  // hub does on StartPower 127 and how fast is supuesto, TODO(hw).
  it("halts a running forward program within STOP_BUDGET_MS", async () => {
    expect(STOP_BUDGET_MS).toBe(200);
    const c = await make(30);
    const result = c.run(forwardProgram());
    await vi.advanceTimersByTimeAsync(800);
    expect(moving(c)).toBe(true);
    const t0 = Date.now();
    c.stop();
    while (moving(c) && Date.now() - t0 < 1000) await vi.advanceTimersByTimeAsync(5);
    expect(moving(c)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(STOP_BUDGET_MS);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await result).toBe("stopped");
    expect(moving(c)).toBe(false);
  });

  it("is synchronous and always safe: before connecting, when idle, and twice in a row", async () => {
    vi.useFakeTimers();
    const c = createEditorController({});
    made.push(c);
    expect(() => {
      c.stop();
      c.stop();
    }).not.toThrow();
    expect(c.getSnapshot().running).toBe(false);
  });

  it("cancels a run that is still waiting for the connection", async () => {
    vi.useFakeTimers();
    const c = createEditorController({});
    made.push(c);
    const result = c.run(forwardProgram());
    c.stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toBe("stopped");
    expect(moving(c)).toBe(false);
  });
});

describe("STOP frames", () => {
  it("an idle STOP writes one burst, not two (every urgent write must meet its deadline)", async () => {
    const c = await make(0);
    const before = c.sentFrames();
    c.stop();
    await vi.advanceTimersByTimeAsync(100);
    const once = c.sentFrames() - before;
    expect(once).toBeGreaterThan(0); // it always reaches the hub
    const mid = c.sentFrames();
    c.stop();
    await vi.advanceTimersByTimeAsync(100);
    expect(c.sentFrames() - mid).toBe(once); // each STOP is the same single burst
    expect(once).toBeLessThanOrEqual(3); // A, B (and the virtual AB): never doubled
  });

  it("stopSettled resolves after the STOP writes went out, and never rejects", async () => {
    const c = await make(30);
    expect(await c.stopSettled()).toBeUndefined(); // no STOP yet
    const before = c.sentFrames();
    c.stop();
    let settled = false;
    void c.stopSettled().then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false); // the writes are still in flight
    await vi.advanceTimersByTimeAsync(200);
    expect(settled).toBe(true);
    expect(c.sentFrames()).toBeGreaterThan(before);
  });
});

describe("a dropped link", () => {
  // A STOP write that cannot be sent within its 150 ms deadline (a busy main thread, e.g. while
  // Blockly re-injects on a level change) makes the transport declare the link dead. The next Run
  // must reconnect instead of failing with "not-connected" and showing nothing.
  it("is recovered: after a STOP that missed its deadline, Run connects again and runs", async () => {
    const c = await make(200); // slow writes: a STOP write misses its 150 ms deadline
    c.stop(); // idle STOP, as on a level change
    await vi.advanceTimersByTimeAsync(1500);
    expect(c.getSnapshot().connection).toBe("idle"); // it noticed the link is gone
    const result = c.run(forwardProgram());
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toBe("completed");
  });
});
