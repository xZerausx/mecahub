import { validateProgram } from "@mecahub/ir";
import type { Program } from "@mecahub/ir";
import { ColorId } from "@mecahub/lwp3";
import { readdirSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fromMoveHub } from "./from-move-hub.js";
import { createRuntime } from "./runtime.js";
import type { RunResult } from "./types.js";
import { startSim } from "./test-support/sim.js";

// Integration: every example program of @mecahub/ir validates and then runs on the simulated hub
// through fromMoveHub, with fake timers. The simulator's kinematics are its own (supuesto, not a
// measurement), so positions are checked with a tolerance and sensor values are driven by hand.
const EXAMPLES = new URL("../../ir/examples/", import.meta.url);
const load = (name: string): Program =>
  JSON.parse(readFileSync(new URL(`${name}.json`, EXAMPLES), "utf8")) as Program;

const A = 0x00;
const B = 0x01;
const D = 0x03;
const TILT = 0x3a;
const NONE = ColorId.None;
// mode 8: [color, whole inches, ?, partial]
const sensor = (color: number, inches: number) => [color, inches, 0, 0];

afterEach(() => vi.useRealTimers());

async function launch(name: string, options: { random?: () => number } = {}) {
  const rig = await startSim();
  const { hub, moveHub } = rig;
  hub.setSensorMode(D, 8, sensor(NONE, 20));
  hub.setSensorMode(TILT, 0, [0, 0]);
  const leds: number[] = [];
  hub.onLedChange((l) => leds.push(l.kind === "index" ? l.color : -1));
  const sounds: { sound: string; at: number }[] = [];
  const t0 = Date.now();
  const runtime = createRuntime({
    device: fromMoveHub(moveHub),
    sound: { play: (sound) => void sounds.push({ sound, at: Date.now() - t0 }) },
    ...(options.random ? { random: options.random } : {}),
  });
  let result: RunResult | undefined;
  void runtime.run(load(name)).then((r) => (result = r));
  const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
  const until = async (done: () => boolean, limitMs = 60_000) => {
    for (let t = 0; t < limitMs && !done(); t += 50) await advance(50);
  };
  return {
    ...rig,
    runtime,
    leds,
    sounds,
    advance,
    until,
    get result() {
      return result;
    },
    motor: (port: number) => hub.motorState(port),
  };
}

const files = readdirSync(EXAMPLES)
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.replace(".json", ""))
  .sort();

describe("IR examples", () => {
  it("covers all ten examples", () => {
    expect(files).toHaveLength(10);
  });

  it.each(files)("%s validates", (name) => {
    expect(validateProgram(load(name)).ok).toBe(true);
  });
});

describe("IR examples on the simulated hub", () => {
  it("01-square: four sides and four turns, then done", async () => {
    const r = await launch("01-square");
    await r.until(() => r.result !== undefined);
    expect(r.result).toEqual({ reason: "completed" });
    // 4 x (720 forward + 280 turn) on A, 4 x (720 - 280) on B
    expect(r.motor(A).position).toBeGreaterThan(3990);
    expect(r.motor(A).position).toBeLessThan(4010);
    expect(r.motor(B).position).toBeGreaterThan(1750);
    expect(r.motor(B).position).toBeLessThan(1770);
    r.close();
  });

  it("02-traffic-light: red, green, yellow, red... until STOP", async () => {
    const r = await launch("02-traffic-light");
    await r.advance(7500);
    expect(r.leds).toEqual([ColorId.Red, ColorId.Green, ColorId.Yellow, ColorId.Red]);
    r.runtime.stop();
    await r.advance(100);
    expect(r.result).toEqual({ reason: "stopped" });
    r.close();
  });

  it("03-obstacle-stop: drives until the distance drops below 3, then stops, lights red and honks", async () => {
    const r = await launch("03-obstacle-stop");
    await r.advance(500);
    expect(r.motor(A).speed).toBe(50);
    expect(r.motor(B).speed).toBe(50);
    expect(r.result).toBeUndefined();
    r.hub.setSensorMode(D, 8, sensor(NONE, 2));
    await r.advance(200);
    expect(r.motor(A).running || r.motor(B).running).toBe(false);
    expect(r.leds).toEqual([ColorId.Red]);
    expect(r.sounds.map((s) => s.sound)).toEqual(["horn"]);
    expect(r.result).toEqual({ reason: "completed" });
    r.close();
  });

  it("04-color-reaction: red stops everything, green runs A for a second, no color shows white", async () => {
    const r = await launch("04-color-reaction");
    await r.advance(100);
    expect(r.leds).toEqual([ColorId.White]); // "none" is true at the start: the first edge
    r.hub.setSensorMode(D, 8, sensor(ColorId.Green, 20));
    await r.advance(300);
    expect(r.leds.at(-1)).toBe(ColorId.Green);
    expect(r.motor(A).speed).toBe(60);
    await r.advance(1500);
    expect(r.motor(A).running).toBe(false);
    expect(r.leds.at(-1)).toBe(ColorId.Black);
    r.hub.setSensorMode(D, 8, sensor(NONE, 20));
    await r.advance(100);
    expect(r.leds.at(-1)).toBe(ColorId.White);
    r.hub.setSensorMode(D, 8, sensor(ColorId.Red, 20));
    await r.advance(200);
    expect(r.leds.at(-1)).toBe(ColorId.Red);
    expect(r.result).toEqual({ reason: "stopAll" });
    r.close();
  });

  it("05-tilt-drive: tilting drives in that direction", async () => {
    const r = await launch("05-tilt-drive");
    await r.advance(100);
    expect(r.motor(A).position).toBe(0);
    r.hub.setSensorMode(TILT, 0, [0, 30]); // forward
    await r.advance(1200);
    const forward = r.motor(A).position;
    expect(forward).toBeGreaterThan(0);
    expect(r.motor(B).position).toBeGreaterThan(0);
    expect(r.motor(A).running).toBe(false);
    r.hub.setSensorMode(TILT, 0, [0, 0]);
    await r.advance(100);
    r.hub.setSensorMode(TILT, 0, [-30, 0]); // left: A backwards, B forwards
    await r.advance(800);
    expect(r.motor(A).position).toBeLessThan(forward);
    expect(r.motor(B).position).toBeGreaterThan(forward);
    expect(r.result).toBeUndefined();
    r.runtime.stop();
    await r.advance(100);
    expect(r.result).toEqual({ reason: "stopped" });
    r.close();
  });

  it("06-button-counter: beeps twice, cheers on the third press and starts over", async () => {
    const r = await launch("06-button-counter");
    for (let i = 0; i < 4; i++) {
      r.hub.setButton(true);
      await r.advance(100);
      r.hub.setButton(false);
      await r.advance(100);
    }
    expect(r.sounds.map((s) => s.sound)).toEqual(["beep", "beep", "cheer", "beep"]);
    r.runtime.stop();
    r.close();
  });

  it("07-dance-forever: keeps dancing until STOP", async () => {
    const r = await launch("07-dance-forever");
    await r.advance(5000);
    expect(r.leds.slice(0, 4)).toEqual([ColorId.Pink, ColorId.Cyan, ColorId.Yellow, ColorId.Pink]);
    expect(r.motor(A).position).not.toBe(0);
    expect(r.result).toBeUndefined();
    r.runtime.stop();
    await r.advance(300);
    expect(r.result).toEqual({ reason: "stopped" });
    expect(r.motor(A).speed).toBe(0);
    expect(r.motor(B).speed).toBe(0);
    r.close();
  });

  it("08-parallel-scripts: drives for four seconds while the LED blinks eight times", async () => {
    const r = await launch("08-parallel-scripts");
    await r.until(() => r.result !== undefined);
    expect(r.result).toEqual({ reason: "completed" });
    expect(r.leds).toEqual(Array.from({ length: 8 }, () => [ColorId.Blue, ColorId.Black]).flat());
    expect(r.motor(A).position).toBeGreaterThan(0);
    expect(r.motor(A).position).toBe(r.motor(B).position);
    r.close();
  });

  it("09-sounds: five sounds half a second apart", async () => {
    const r = await launch("09-sounds");
    await r.until(() => r.result !== undefined);
    expect(r.sounds.map((s) => s.sound)).toEqual(["beep", "laser", "robot", "horn", "cheer"]);
    r.sounds.forEach((s, i) => expect(s.at).toBeGreaterThanOrEqual(i * 500));
    expect(r.sounds[4]!.at).toBeLessThan(2200);
    expect(r.result).toEqual({ reason: "completed" });
    r.close();
  });

  it("10-random-choice: an odd roll turns A, otherwise B turns back and the LED goes orange", async () => {
    const odd = await launch("10-random-choice", { random: () => 0.4 }); // roll 3
    await odd.until(() => odd.result !== undefined);
    expect(odd.motor(A).position).toBeGreaterThan(350);
    expect(odd.motor(B).position).toBe(0);
    expect(odd.leds).toEqual([]);
    odd.close();
    vi.useRealTimers();

    const even = await launch("10-random-choice", { random: () => 0 }); // roll 1
    await even.until(() => even.result !== undefined);
    expect(even.motor(B).position).toBeLessThan(-350);
    expect(even.motor(A).position).toBe(0);
    expect(even.leds).toEqual([ColorId.Orange]);
    even.close();
  });
});
