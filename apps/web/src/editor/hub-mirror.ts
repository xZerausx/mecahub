import type { MotorHandle, RuntimeDevice } from "@mecahub/runtime";
import type { LedName, WheelState } from "./editor-controller.js";

// What the preview of a REAL hub shows. The hub reports no motor state worth drawing (the app
// sends commands and gets feedback at most), so the preview mirrors the COMMANDED state: the
// direction a command asked for, until something replaces or ends it. It is not a measurement
// (supuesto, TODO(hw): compare with the real robot). The simulator keeps drawing its own measured state.

export interface MirrorSink {
  wheel(port: "a" | "b", state: WheelState): void;
  led(led: LedName): void;
}

const directionOf = (speed: number): WheelState =>
  speed === 0 ? "stopped" : speed > 0 ? "forward" : "backward";

const wheelOf = (port: string): "a" | "b" | undefined =>
  port === "A" ? "a" : port === "B" ? "b" : undefined;

/** Wraps a device so that every command that moves a wheel or lights the LED is reported to `sink`. */
export function mirrorDevice(device: RuntimeDevice, sink: MirrorSink): RuntimeDevice {
  // The latest command per wheel owns its state: a late end of an older timed command is ignored.
  const owner = { a: 0, b: 0 };
  const set = (wheel: "a" | "b", state: WheelState): number => {
    sink.wheel(wheel, state);
    return ++owner[wheel];
  };
  const release = (wheel: "a" | "b", token: number): void => {
    if (owner[wheel] === token) sink.wheel(wheel, "stopped");
  };
  const stopWheel = (wheel: "a" | "b"): void => void set(wheel, "stopped");
  /** Shows `speed`; the wheel stops showing it when `end` settles (unless replaced meanwhile). */
  const move = <T>(
    wheel: "a" | "b" | undefined,
    speed: number,
    command: () => Promise<T>,
    untilSettled: boolean,
  ): Promise<T> => {
    if (wheel === undefined) return command();
    const token = set(wheel, directionOf(speed));
    const pending = command();
    pending.then(
      () => {
        if (untilSettled) release(wheel, token);
      },
      () => release(wheel, token),
    );
    return pending;
  };

  const motor = (port: Parameters<RuntimeDevice["motor"]>[0]): MotorHandle => {
    const inner = device.motor(port);
    const wheel = wheelOf(port);
    return {
      ...inner,
      run: (speed) => move(wheel, speed, () => inner.run(speed), false),
      runFor: (ms, speed) => move(wheel, speed, () => inner.runFor(ms, speed), true),
      rotate: (degrees, speed) => move(wheel, speed, () => inner.rotate(degrees, speed), true),
      brake: () => {
        if (wheel) stopWheel(wheel);
        return inner.brake();
      },
      float: () => {
        if (wheel) stopWheel(wheel);
        return inner.float();
      },
    };
  };

  return {
    ...device,
    has: (resource) => device.has(resource),
    motor,
    drive: {
      run: async (a, b) => {
        set("a", directionOf(a));
        set("b", directionOf(b));
        const tokens = { a: owner.a, b: owner.b };
        try {
          await device.drive.run(a, b);
        } catch (err) {
          release("a", tokens.a);
          release("b", tokens.b);
          throw err;
        }
      },
      brake: () => {
        stopWheel("a");
        stopWheel("b");
        return device.drive.brake();
      },
      float: () => {
        stopWheel("a");
        stopWheel("b");
        return device.drive.float();
      },
    },
    led: (color) => {
      sink.led(color);
      return device.led(color);
    },
    onColorAndDistance: (port, listener) => device.onColorAndDistance(port, listener),
    onTilt: (listener) => device.onTilt(listener),
    onButton: (listener) => device.onButton(listener),
    stopAll: () => {
      // Synchronous, before anything else: the picture never lags behind a STOP.
      stopWheel("a");
      stopWheel("b");
      return device.stopAll();
    },
  };
}
