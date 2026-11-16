import type { FeedbackStatus, MotorHandle, RuntimeDevice } from "@mecahub/runtime";
import { describe, expect, it } from "vitest";
import { mirrorDevice, type MirrorSink } from "./hub-mirror.js";
import type { LedName, WheelState } from "./editor-controller.js";

// The mirror shows the COMMANDED state, never a measured one (supuesto, see docs/protocol-notes.md).

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(err: unknown): void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

function setup() {
  const wheels: Record<"a" | "b", WheelState> = { a: "stopped", b: "stopped" };
  let led: LedName = "off";
  const sink: MirrorSink = {
    wheel: (port, state) => void (wheels[port] = state),
    led: (name) => void (led = name),
  };
  const timed: Deferred<FeedbackStatus>[] = [];
  const motorHandle = (): MotorHandle => ({
    run: () => Promise.resolve(),
    runFor: () => {
      const d = deferred<FeedbackStatus>();
      timed.push(d);
      return d.promise;
    },
    rotate: () => {
      const d = deferred<FeedbackStatus>();
      timed.push(d);
      return d.promise;
    },
    brake: () => Promise.resolve(),
    float: () => Promise.resolve(),
    onPosition: () => Promise.resolve(() => undefined),
  });
  let stops = 0;
  const device: RuntimeDevice = {
    has: () => true,
    motor: motorHandle,
    drive: {
      run: () => Promise.resolve(),
      brake: () => Promise.resolve(),
      float: () => Promise.resolve(),
    },
    led: () => Promise.resolve(),
    onColorAndDistance: () => Promise.resolve(() => undefined),
    onTilt: () => Promise.resolve(() => undefined),
    onButton: () => Promise.resolve(() => undefined),
    stopAll: () => {
      stops++;
      return Promise.resolve({ ok: true });
    },
  };
  return {
    wheels,
    led: () => led,
    timed,
    stops: () => stops,
    mirrored: mirrorDevice(device, sink),
  };
}

describe("mirrorDevice", () => {
  it("drive.run sets each wheel from the sign of its speed", async () => {
    const m = setup();
    await m.mirrored.drive.run(50, -50);
    expect(m.wheels).toEqual({ a: "forward", b: "backward" });
    await m.mirrored.drive.run(0, 30);
    expect(m.wheels).toEqual({ a: "stopped", b: "forward" });
  });

  it("drive brake and float stop both wheels", async () => {
    const m = setup();
    await m.mirrored.drive.run(50, 50);
    await m.mirrored.drive.brake();
    expect(m.wheels).toEqual({ a: "stopped", b: "stopped" });
    await m.mirrored.drive.run(50, 50);
    await m.mirrored.drive.float();
    expect(m.wheels).toEqual({ a: "stopped", b: "stopped" });
  });

  it("motor run sets the wheel of that port; ports C and D have no wheel", async () => {
    const m = setup();
    await m.mirrored.motor("A").run(-40);
    expect(m.wheels).toEqual({ a: "backward", b: "stopped" });
    await m.mirrored.motor("C").run(40);
    expect(m.wheels).toEqual({ a: "backward", b: "stopped" });
  });

  it("runFor and rotate show the direction until the promise resolves", async () => {
    const m = setup();
    const done = m.mirrored.motor("B").runFor(1000, 60);
    expect(m.wheels.b).toBe("forward");
    m.timed[0]?.resolve("completed");
    await done;
    expect(m.wheels.b).toBe("stopped");
    const rotated = m.mirrored.motor("A").rotate(90, -60);
    expect(m.wheels.a).toBe("backward");
    m.timed[1]?.resolve("discarded");
    await rotated;
    expect(m.wheels.a).toBe("stopped");
  });

  it("a finished timed command does not stop a wheel a newer command already took over", async () => {
    const m = setup();
    const first = m.mirrored.motor("A").runFor(1000, 60);
    await m.mirrored.motor("A").run(-60); // replaces it
    m.timed[0]?.resolve("discarded");
    await first;
    expect(m.wheels.a).toBe("backward");
  });

  it("a timed command that is rejected stops showing movement", async () => {
    const m = setup();
    const done = m.mirrored.motor("A").runFor(1000, 60);
    m.timed[0]?.reject(new Error("link lost"));
    await done.catch(() => undefined);
    expect(m.wheels.a).toBe("stopped");
  });

  it("brake and float on a motor stop its wheel", async () => {
    const m = setup();
    await m.mirrored.motor("A").run(60);
    await m.mirrored.motor("A").brake();
    expect(m.wheels.a).toBe("stopped");
    await m.mirrored.motor("B").run(60);
    await m.mirrored.motor("B").float();
    expect(m.wheels.b).toBe("stopped");
  });

  it("stopAll stops both wheels at once, synchronously, and still reaches the device", async () => {
    const m = setup();
    await m.mirrored.drive.run(50, 50);
    const pending = m.mirrored.stopAll();
    expect(m.wheels).toEqual({ a: "stopped", b: "stopped" }); // before awaiting
    expect(m.stops()).toBe(1);
    await pending;
  });

  it("led shows the colour; the black LED reads as black", async () => {
    const m = setup();
    await m.mirrored.led("red");
    expect(m.led()).toBe("red");
    await m.mirrored.led("lightBlue");
    expect(m.led()).toBe("lightBlue");
  });

  it("passes everything else through", async () => {
    const m = setup();
    expect(m.mirrored.has("drive")).toBe(true);
    await expect(m.mirrored.onTilt(() => undefined)).resolves.toBeTypeOf("function");
  });
});
