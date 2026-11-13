import { encodePortOutputCommand } from "@mecahub/lwp3";
import {
  SimulatedHub,
  SimulatorTransport,
  defaultMoveHubConfig,
  realClock,
  type MotorState,
  type SimClock,
  type SimHubConfig,
} from "@mecahub/simulator";
import { createHubProbe, type HubProbe } from "./hub-probe.js";

/** STOP must halt every motor within this many ms (CLAUDE.md). */
export const STOP_BUDGET_MS = 200;

const PORT_A = 0x00;
const PORT_B = 0x01;
const PORT_COLOR_DISTANCE = 0x03;
const PORT_TILT = 0x3a;

/** Color id reported when the sensor sees nothing. supuesto: TODO(hw) */
export const COLOR_NONE = 255;

export type DriveTarget = "a" | "b" | "ab";

export type StopStatus =
  | { status: "idle" }
  | { status: "pending" }
  /** The STOP never arrived (every write failed, or the link dropped while motors still ran). */
  | { status: "failed" }
  | { status: "done"; ms: number; withinBudget: boolean };

export interface SimSnapshot {
  /** Every motor port of the hub config, by port number. */
  motors: { port: number; state: MotorState }[];
  battery: number;
  button: boolean;
  tilt: { x: number; y: number };
  color: number;
  distance: number;
  stalled: boolean;
  writeLatencyMs: number;
  stop: StopStatus;
}

export interface SimController {
  /** The app side: connect, disconnect, name, battery and the hex log. */
  readonly probe: HubProbe;
  /** The simulated link (exposed for tests and fault injection UIs). */
  readonly transport: SimulatorTransport;
  /** Stable between changes (safe for useSyncExternalStore). */
  getSnapshot(): SimSnapshot;
  subscribe(listener: () => void): () => void;
  setBattery(percent: number): void;
  setButton(pressed: boolean): void;
  /** Signed degrees, -128..127 (port 0x3A). */
  setTilt(x: number, y: number): void;
  setColor(id: number): void;
  setDistance(value: number): void;
  dropLink(): void;
  setStalled(stalled: boolean): void;
  /** Lets the oldest stalled write through. */
  releaseWrite(): void;
  setWriteLatency(ms: number): void;
  /**
   * Starts the motor(s) at `speed` percent (immediate, no feedback). Never rejects: a dead link or
   * an invalid speed becomes a note in the probe log.
   */
  drive(target: DriveTarget, speed: number): Promise<void>;
  /**
   * STOP with urgent priority on every motor; starts the latency measurement. The result is "done"
   * only after the STOP write landed and every motor is still. A repeated STOP while pending keeps
   * the original start time. Never rejects.
   */
  stop(): Promise<void>;
  dispose(): void;
}

export interface SimControllerOptions {
  /** Time source of hub, link and the STOP measurement. Defaults to the real clock. */
  clock?: SimClock;
  config?: SimHubConfig;
}

const byteIn = (v: number, min: number, max: number, what: string): number => {
  if (!Number.isInteger(v) || v < min || v > max) {
    throw new RangeError(`${what} must be an integer ${min}..${max}`);
  }
  return v;
};

const NO_PROFILE = { acc: false, dec: false } as const;

/**
 * Hub + link + app probe wired together for the simulator page, plus the STOP latency
 * measurement. Plain TypeScript (no DOM, no React) so it is unit-testable in Node.
 */
export function createSimController(options: SimControllerOptions = {}): SimController {
  const clock = options.clock ?? realClock;
  const config = options.config ?? defaultMoveHubConfig();
  const hub = new SimulatedHub(config, { clock });
  const transport = new SimulatorTransport(hub, { clock });
  const probe = createHubProbe(transport, { now: () => clock.now() });
  const motorPorts = config.ports.flatMap((p) => {
    try {
      hub.motorState(p.port);
      return [p.port];
    } catch {
      return []; // not a motor
    }
  });
  const virtualAb = config.virtualPorts.find((v) => v.portA === PORT_A && v.portB === PORT_B);
  const hasPort = (port: number) => config.ports.some((p) => p.port === port);

  const listeners = new Set<() => void>();
  let stopStartedAt = 0;
  /** Bumped by every stop(): only the latest one's outcome counts. */
  let stopGeneration = 0;
  /** The latest STOP's writes completed (the hub has the frames). */
  let stopLanded = false;
  let snapshot: SimSnapshot = {
    motors: motorPorts.map((port) => ({ port, state: hub.motorState(port) })),
    battery: config.batteryPercent,
    button: config.buttonPressed,
    tilt: { x: 0, y: 0 },
    color: COLOR_NONE,
    distance: 10,
    stalled: false,
    writeLatencyMs: 0,
    stop: { status: "idle" },
  };

  const publish = (patch: Partial<SimSnapshot>): void => {
    snapshot = { ...snapshot, ...patch };
    for (const listener of [...listeners]) listener();
  };

  const motorsStill = (): boolean => snapshot.motors.every((m) => !m.state.running);

  /** Done = the STOP landed AND every motor is still: a write still in flight cannot be missed. */
  const finishStopIfStill = (): void => {
    if (snapshot.stop.status !== "pending" || !stopLanded || !motorsStill()) return;
    const ms = Math.max(0, clock.now() - stopStartedAt);
    publish({ stop: { status: "done", ms, withinBudget: ms <= STOP_BUDGET_MS } });
  };

  const failStop = (): void => {
    if (snapshot.stop.status === "pending") publish({ stop: { status: "failed" } });
  };

  // Per-mode values from the lwp3 mode table (derivado del layout, TODO(hw)): the app gets the
  // layout of whichever mode it subscribed to. Mode 8 repeats modes 0 and 1: [color, inches, 0, 0].
  const pushColorDistance = (color: number, distance: number): void => {
    if (!hasPort(PORT_COLOR_DISTANCE)) return;
    hub.setSensorMode(PORT_COLOR_DISTANCE, 0, [color]);
    hub.setSensorMode(PORT_COLOR_DISTANCE, 1, [distance]);
    hub.setSensorMode(PORT_COLOR_DISTANCE, 8, [color, distance, 0, 0]);
  };
  const pushTilt = (x: number, y: number): void => {
    if (hasPort(PORT_TILT)) hub.setSensorMode(PORT_TILT, 0, [x, y]);
  };
  const offMotor = hub.onMotorChange((port, state) => {
    if (!motorPorts.includes(port)) return;
    publish({ motors: snapshot.motors.map((m) => (m.port === port ? { port, state } : m)) });
    finishStopIfStill();
  });
  // A link loss ends a stall (the transport clears it), so the page must not keep showing it.
  const offLink = transport.onDisconnect(() => {
    if (snapshot.stalled) publish({ stalled: false });
    // The hub heard about the loss first: motors still running now were not reached by the STOP.
    if (snapshot.stop.status === "pending" && !motorsStill()) failStop();
  });

  const outputFrame = (
    port: number,
    command: Parameters<typeof encodePortOutputCommand>[0]["command"],
  ) => encodePortOutputCommand({ port, startup: "immediate", completion: "none", command });

  const driveFrames = (target: DriveTarget, speed: number): [Uint8Array, string][] => {
    byteIn(speed, -100, 100, "speed");
    const one = (port: number, name: string): [Uint8Array, string] => [
      outputFrame(port, { sub: "startSpeed", speed, maxPower: 100, useProfile: NO_PROFILE }),
      `${name} ${speed}%`,
    ];
    if (target === "a") return [one(PORT_A, "A")];
    if (target === "b") return [one(PORT_B, "B")];
    if (virtualAb) {
      return [
        [
          outputFrame(virtualAb.port, {
            sub: "startSpeed2",
            speed1: speed,
            speed2: speed,
            maxPower: 100,
            useProfile: NO_PROFILE,
          }),
          `AB ${speed}%`,
        ],
      ];
    }
    return [one(PORT_A, "A"), one(PORT_B, "B")];
  };

  /** STOP = StartPower 127 (brake), immediate, no feedback; on the virtual AB port when there is one. */
  const stopFrames = (): Uint8Array[] => {
    const covered = virtualAb ? [PORT_A, PORT_B] : [];
    return [
      ...(virtualAb
        ? [outputFrame(virtualAb.port, { sub: "startPower2", power1: 127, power2: 127 })]
        : []),
      ...motorPorts
        .filter((port) => !covered.includes(port))
        .map((port) => outputFrame(port, { sub: "startPower", power: 127 })),
    ];
  };

  return {
    probe,
    transport,
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    setBattery: (percent) => {
      hub.setBattery(percent);
      publish({ battery: percent });
    },
    setButton: (pressed) => {
      hub.setButton(pressed);
      publish({ button: pressed });
    },
    setTilt: (x, y) => {
      byteIn(x, -128, 127, "tilt x");
      byteIn(y, -128, 127, "tilt y");
      pushTilt(x, y);
      publish({ tilt: { x, y } });
    },
    setColor: (id) => {
      byteIn(id, 0, 255, "color");
      pushColorDistance(id, snapshot.distance);
      publish({ color: id });
    },
    setDistance: (value) => {
      byteIn(value, 0, 255, "distance");
      pushColorDistance(snapshot.color, value);
      publish({ distance: value });
    },
    dropLink: () => transport.dropLink(),
    setStalled: (stalled) => {
      if (stalled) transport.stallWrites();
      else transport.resumeWrites();
      publish({ stalled });
    },
    releaseWrite: () => transport.releaseWrite(),
    setWriteLatency: (ms) => {
      transport.setWriteLatency(ms);
      publish({ writeLatencyMs: ms });
    },
    drive: async (target, speed) => {
      try {
        const frames = driveFrames(target, speed); // validates the speed before anything is sent
        await Promise.all(frames.map(([bytes, note]) => probe.send(bytes, note)));
      } catch (err) {
        probe.note(`drive failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    stop: async () => {
      const generation = ++stopGeneration;
      stopLanded = false;
      // Measured from the click, before any write (queueing and link delay count). A STOP that is
      // already being measured keeps its start: pressing again must not hide a slow one.
      if (snapshot.stop.status !== "pending") {
        stopStartedAt = clock.now();
        publish({ stop: { status: "pending" } });
      }
      try {
        const results = await Promise.all(
          stopFrames().map((bytes) => probe.send(bytes, "STOP", { priority: "urgent" })),
        );
        if (generation !== stopGeneration) return;
        if (results.some(Boolean)) {
          stopLanded = true;
          finishStopIfStill();
        } else {
          failStop();
        }
      } catch (err) {
        probe.note(`STOP failed: ${err instanceof Error ? err.message : String(err)}`);
        if (generation === stopGeneration) failStop();
      }
    },
    dispose: () => {
      offMotor();
      offLink();
      transport.dispose();
      hub.dispose();
    },
  };
}
