import type { MoveHub, TachoMotor } from "@mecahub/hub";
import type { MotorPort } from "@mecahub/ir";
import { COLOR_ID_BY_NAME, colorName } from "./colors.js";
import type { DriveHandle, MotorHandle, Resource, RuntimeDevice } from "./device.js";

const motorOf = (hub: MoveHub, port: MotorPort): TachoMotor | undefined => {
  switch (port) {
    case "A":
      return hub.motors.a;
    case "B":
      return hub.motors.b;
    case "C":
      return hub.portC?.motor;
    case "D":
      return hub.portD?.motor;
  }
};

const sensorOf = (hub: MoveHub, port: "C" | "D") =>
  (port === "C" ? hub.portC : hub.portD)?.colorDistance;

const absent = (what: string): never => {
  throw new Error(`${what} is not connected`);
};

/** Turns a synchronous throw (a missing device) into a rejection, still calling at once. */
const safe = <T>(call: () => Promise<T>): Promise<T> => {
  try {
    return call();
  } catch (err) {
    return Promise.reject(err as Error);
  }
};

/** Adapts the hub layer to what the interpreter needs. Devices are looked up at call time. */
export function fromMoveHub(hub: MoveHub): RuntimeDevice {
  const motor = (port: MotorPort): MotorHandle => {
    const m = () => motorOf(hub, port) ?? absent(`motor ${port}`);
    return {
      run: (speed) => safe(() => m().run(speed)),
      runFor: (ms, speed) => safe(() => m().runFor(ms, speed)),
      rotate: (degrees, speed) => safe(() => m().rotate(degrees, speed)),
      brake: () => safe(() => m().brake()),
      float: () => safe(() => m().float()),
      onPosition: (listener) => safe(() => m().onPosition(listener)),
    };
  };
  // When the hub has not announced its virtual AB port, A and B are driven one by one.
  const drive: DriveHandle = {
    run: async (a, b) => {
      const ab = hub.motors.ab;
      if (ab) await ab.run(a, b);
      else await Promise.all([hub.motors.a.run(a), hub.motors.b.run(b)]);
    },
    brake: async () => {
      const ab = hub.motors.ab;
      if (ab) await ab.brake();
      else await Promise.all([hub.motors.a.brake(), hub.motors.b.brake()]);
    },
    float: async () => {
      const ab = hub.motors.ab;
      if (ab) await ab.float();
      else await Promise.all([hub.motors.a.float(), hub.motors.b.float()]);
    },
  };
  return {
    has(resource: Resource): boolean {
      if (resource === "drive") return true;
      if (resource === "tilt" || resource === "button" || resource === "led") return true;
      if (resource.startsWith("motor:"))
        return motorOf(hub, resource.slice(6) as MotorPort) !== undefined;
      return sensorOf(hub, resource.slice(14) as "C" | "D") !== undefined;
    },
    motor,
    drive,
    led: (color) => hub.led.setColor(COLOR_ID_BY_NAME[color]),
    onColorAndDistance: (port, listener) =>
      safe(() =>
        (sensorOf(hub, port) ?? absent(`color sensor on ${port}`)).onColorAndDistance((r) =>
          listener({ color: colorName(r.color), distance: r.inches }),
        ),
      ),
    onTilt: (listener) => hub.tilt.onTilt(listener),
    onButton: (listener) => hub.button.onChange(listener),
    async stopAll() {
      const result = await hub.stopAll();
      return { ok: result.ok };
    },
  };
}
