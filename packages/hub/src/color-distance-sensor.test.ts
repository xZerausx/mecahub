import { ColorId, encodePortInputFormatSetup, encodePortValueSingle } from "@mecahub/lwp3";
import type { SessionEvent } from "./session.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HubError } from "./errors.js";
import { configWithSensorOnC, startSim } from "./test-support/sim.js";

// Vector origin: setup frames are built with the lwp3 encoder (doc 3.17, 'derivado del layout');
// values follow the lwp3 mode table (pylgbst + node-poweredup, 'derivado del layout'; no 0x45 was
// captured: TODO(hw)). The capture has the sensor (0x25) on port D (0x03); a rest sensor sees no
// color (255) and distance 10 (simulator supuesto).
const D = 0x03;
const C = 0x02;
const setup = (port: number, mode: number, deltaInterval: number, notify: boolean) =>
  encodePortInputFormatSetup({ type: "portInputFormatSetup", port, mode, deltaInterval, notify });

afterEach(() => vi.useRealTimers());

const settled = (p: Promise<unknown> | undefined) =>
  (p ?? Promise.reject(new Error("no sensor"))).then(
    (v) => ({ ok: true as const, v }),
    (e: unknown) => ({ ok: false as const, e }),
  );

describe("ColorDistanceSensor (simulated hub, captured config: sensor on D)", () => {
  it("is what portD yields for io type 0x25", async () => {
    const { moveHub, close } = await startSim();
    expect(moveHub.portD?.colorDistance?.port).toBe(D);
    expect(moveHub.portD?.motor).toBeUndefined();
    close();
  });

  it("onColor (mode 0) reports typed color ids; ids outside the table are dropped", async () => {
    const { hub, sim, moveHub, close } = await startSim();
    const seen: number[] = [];
    await moveHub.portD?.colorDistance?.onColor((c) => seen.push(c));
    expect(sim.sentFrames.at(-1)).toEqual(setup(D, 0, 1, true));
    hub.setSensorMode(D, 0, [ColorId.Red]);
    hub.setSensorMode(D, 0, [42]); // not in the table
    hub.setSensorMode(D, 0, [ColorId.Blue]);
    await vi.advanceTimersByTimeAsync(10);
    expect(seen).toEqual([ColorId.None, ColorId.Red, ColorId.Blue]);
    close();
  });

  it("onDistance (mode 1) reports inches", async () => {
    const { hub, sim, moveHub, close } = await startSim();
    const seen: number[] = [];
    await moveHub.portD?.colorDistance?.onDistance((d) => seen.push(d));
    expect(sim.sentFrames.at(-1)).toEqual(setup(D, 1, 1, true));
    hub.setSensorMode(D, 1, [3]);
    await vi.advanceTimersByTimeAsync(10);
    expect(seen).toEqual([10, 3]);
    close();
  });

  it("onReflectedLight (mode 3) and onAmbientLight (mode 4) report percent", async () => {
    const { hub, sim, moveHub, close } = await startSim();
    const reflected: number[] = [];
    const ambient: number[] = [];
    const sensor = moveHub.portD?.colorDistance;
    const off = await sensor?.onReflectedLight((p) => reflected.push(p));
    expect(sim.sentFrames.at(-1)).toEqual(setup(D, 3, 1, true));
    hub.setSensorMode(D, 3, [80]);
    off?.();
    await vi.advanceTimersByTimeAsync(10);
    await sensor?.onAmbientLight((p) => ambient.push(p));
    expect(sim.sentFrames.at(-1)).toEqual(setup(D, 4, 1, true));
    hub.setSensorMode(D, 4, [35]);
    await vi.advanceTimersByTimeAsync(10);
    expect(reflected).toEqual([0, 80]);
    expect(ambient).toEqual([0, 35]);
    close();
  });

  it("onColorAndDistance (mode 8) combines color with whole + 1/partial inches", async () => {
    // [color, whole inches, ?, partial]: distance = whole + 1/partial when partial > 0
    // (pylgbst peripherals.py:677-679, node-poweredup colordistancesensor.ts:130-135)
    const { hub, sim, moveHub, close } = await startSim();
    const seen: { color: number; inches: number }[] = [];
    await moveHub.portD?.colorDistance?.onColorAndDistance((r) => seen.push(r));
    expect(sim.sentFrames.at(-1)).toEqual(setup(D, 8, 1, true));
    hub.setSensorMode(D, 8, [ColorId.Red, 3, 0, 4]);
    await vi.advanceTimersByTimeAsync(10);
    expect(seen).toEqual([
      { color: ColorId.None, inches: 10 },
      { color: ColorId.Red, inches: 3.25 },
    ]);
    close();
  });

  it("one mode at a time: onDistance while onColor is active rejects 'mode-conflict'", async () => {
    const { moveHub, close } = await startSim();
    const sensor = moveHub.portD?.colorDistance;
    const off = await sensor?.onColor(() => undefined);
    const r = await settled(sensor?.onDistance(() => undefined));
    expect(!r.ok && (r.e as HubError).code).toBe("mode-conflict");
    off?.();
    await vi.advanceTimersByTimeAsync(10);
    expect((await settled(sensor?.onDistance(() => undefined))).ok).toBe(true);
    close();
  });

  it("listeners of the same mode share one subscription", async () => {
    const { hub, sim, moveHub, close } = await startSim();
    const a: number[] = [];
    const b: number[] = [];
    const sensor = moveHub.portD?.colorDistance;
    await sensor?.onColor((c) => a.push(c));
    await sensor?.onColor((c) => b.push(c));
    hub.setSensorMode(D, 0, [ColorId.Green]);
    await vi.advanceTimersByTimeAsync(10);
    expect(a.at(-1)).toBe(ColorId.Green);
    expect(b.at(-1)).toBe(ColorId.Green);
    expect(sim.sentFrames.filter((f) => f[2] === 0x41)).toHaveLength(1);
    close();
  });

  it("dispose turns the hub's notifications off", async () => {
    const { sim, moveHub, close } = await startSim();
    await moveHub.portD?.colorDistance?.onColor(() => undefined);
    moveHub.dispose();
    await vi.advanceTimersByTimeAsync(10);
    expect(sim.sentFrames.at(-1)).toEqual(setup(D, 0, 1, false));
    close();
  });
});

describe("unknown values (diagnostics)", () => {
  const unknownValues = (events: SessionEvent[]) =>
    events.filter((e) => e.kind === "unknown-value");

  it("a color id outside the table is dropped for the listener but reported as a session event", async () => {
    const { hub, moveHub, close } = await startSim();
    const events: SessionEvent[] = [];
    moveHub.session.onEvent((e) => events.push(e));
    const seen: number[] = [];
    await moveHub.portD?.colorDistance?.onColor((c) => seen.push(c));
    hub.setSensorMode(D, 0, [42]);
    await vi.advanceTimersByTimeAsync(10);
    expect(seen).toEqual([ColorId.None]);
    expect(unknownValues(events)).toEqual([
      { kind: "unknown-value", port: D, mode: 0, raw: Uint8Array.of(42) },
    ]);
    close();
  });

  it("a value the mode table cannot map (wrong length) is reported too", async () => {
    const { hub, moveHub, close } = await startSim();
    const events: SessionEvent[] = [];
    moveHub.session.onEvent((e) => events.push(e));
    await moveHub.portD?.colorDistance?.onColor(() => undefined);
    hub.injectRaw(encodePortValueSingle(D, Uint8Array.of(1, 2)));
    expect(unknownValues(events)).toEqual([
      { kind: "unknown-value", port: D, mode: 0, raw: Uint8Array.of(1, 2) },
    ]);
    close();
  });

  it("a mode 8 reading with an unknown color is reported with all four bytes", async () => {
    const { hub, moveHub, close } = await startSim();
    const events: SessionEvent[] = [];
    moveHub.session.onEvent((e) => events.push(e));
    await moveHub.portD?.colorDistance?.onColorAndDistance(() => undefined);
    hub.setSensorMode(D, 8, [99, 3, 0, 4]);
    expect(unknownValues(events)).toEqual([
      { kind: "unknown-value", port: D, mode: 8, raw: Uint8Array.of(99, 3, 0, 4) },
    ]);
    close();
  });
});

describe("ColorDistanceSensor on C", () => {
  it("works the same on the other external port", async () => {
    const { hub, moveHub, close } = await startSim({ config: configWithSensorOnC() });
    expect(moveHub.portC?.colorDistance?.port).toBe(C);
    expect(moveHub.portD).toBeUndefined();
    const seen: number[] = [];
    await moveHub.portC?.colorDistance?.onColor((c) => seen.push(c));
    hub.setSensorMode(C, 0, [ColorId.Yellow]);
    await vi.advanceTimersByTimeAsync(10);
    expect(seen).toEqual([ColorId.None, ColorId.Yellow]);
    close();
  });
});
