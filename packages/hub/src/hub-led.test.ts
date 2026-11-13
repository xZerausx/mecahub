import { ColorId, encodePortInputFormatSetup } from "@mecahub/lwp3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startSim } from "./test-support/sim.js";

// Vector origin: 'derivado del layout', never captured (TODO(hw)). The LED write is the direct-mode
// frame both refs send: 0x81, port, startup/completion, 0x51, mode, data (node-poweredup
// hubled.ts:36,57 + device.ts:138; pylgbst peripherals.py:244-259). Startup "immediate", no
// feedback (0x10) is our choice, like the motor commands; both refs ask for feedback.
// The port mode is set (0x41, no notifications) before the first write of each mode, as both refs do.
const LED = 0x32;
const setupFrame = (mode: number) =>
  encodePortInputFormatSetup({
    type: "portInputFormatSetup",
    port: LED,
    mode,
    deltaInterval: 1,
    notify: false,
  });
const colorFrame = (id: number) => Uint8Array.of(0x08, 0x00, 0x81, LED, 0x10, 0x51, 0x00, id);
const rgbFrame = (r: number, g: number, b: number) =>
  Uint8Array.of(0x0a, 0x00, 0x81, LED, 0x10, 0x51, 0x01, r, g, b);

afterEach(() => vi.useRealTimers());

describe("HubLed (simulated hub)", () => {
  it("setColor writes color index mode 0 after setting the port mode, and the LED changes", async () => {
    const { hub, sim, moveHub, close } = await startSim();
    await moveHub.led.setColor(ColorId.Red);
    await vi.advanceTimersByTimeAsync(10);
    expect(sim.sentFrames).toEqual([setupFrame(0), colorFrame(9)]);
    expect(hub.led).toEqual({ kind: "index", color: 9 });
    close();
  });

  it("setRgb writes mode 1 with the three bytes", async () => {
    const { hub, sim, moveHub, close } = await startSim();
    await moveHub.led.setRgb(255, 128, 0);
    await vi.advanceTimersByTimeAsync(10);
    expect(sim.sentFrames).toEqual([setupFrame(1), rgbFrame(255, 128, 0)]);
    expect(hub.led).toEqual({ kind: "rgb", r: 255, g: 128, b: 0 });
    close();
  });

  it("sets the port mode only when the mode changes", async () => {
    const { sim, moveHub, close } = await startSim();
    await moveHub.led.setColor(ColorId.Blue);
    await moveHub.led.setColor(ColorId.Green);
    await moveHub.led.setRgb(1, 2, 3);
    await moveHub.led.setRgb(4, 5, 6);
    await moveHub.led.setColor(ColorId.None);
    await vi.advanceTimersByTimeAsync(10);
    expect(sim.sentFrames).toEqual([
      setupFrame(0),
      colorFrame(3),
      colorFrame(6),
      setupFrame(1),
      rgbFrame(1, 2, 3),
      rgbFrame(4, 5, 6),
      setupFrame(0),
      colorFrame(255),
    ]);
    close();
  });

  it("sets the port mode again after the link was lost", async () => {
    const { sim, moveHub, close } = await startSim();
    await moveHub.led.setColor(ColorId.Blue);
    await vi.advanceTimersByTimeAsync(10);
    sim.dropLink();
    const reconnecting = moveHub.connect();
    await vi.advanceTimersByTimeAsync(300);
    await reconnecting;
    sim.sentFrames.length = 0;
    await moveHub.led.setColor(ColorId.Blue);
    await vi.advanceTimersByTimeAsync(10);
    expect(sim.sentFrames).toEqual([setupFrame(0), colorFrame(3)]);
    close();
  });

  it("rejects what is not a color or a byte before anything is written", async () => {
    const { sim, moveHub, close } = await startSim();
    await expect(moveHub.led.setColor(42 as never)).rejects.toThrow(RangeError);
    await expect(moveHub.led.setRgb(256, 0, 0)).rejects.toThrow(RangeError);
    await expect(moveHub.led.setRgb(1.5, 0, 0)).rejects.toThrow(RangeError);
    await expect(moveHub.led.setRgb(-1, 0, 0)).rejects.toThrow(RangeError);
    expect(sim.sentFrames).toEqual([]);
    close();
  });

  it("keeps calls in order when they overlap", async () => {
    const { sim, moveHub, close } = await startSim();
    void moveHub.led.setColor(ColorId.Red);
    void moveHub.led.setRgb(1, 2, 3);
    await vi.advanceTimersByTimeAsync(10);
    expect(sim.sentFrames).toEqual([
      setupFrame(0),
      colorFrame(9),
      setupFrame(1),
      rgbFrame(1, 2, 3),
    ]);
    close();
  });
});
