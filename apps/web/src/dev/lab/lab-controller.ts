import { IoTypeId, encodeHubProperty, isColorId } from "@mecahub/lwp3";
import { HubError, MoveHub, type TachoMotor } from "@mecahub/hub";
import {
  SimulatedHub,
  SimulatorTransport,
  defaultMoveHubConfig,
  realClock,
  type SimClock,
  type SimHubConfig,
} from "@mecahub/simulator";
import { TransportError, type BleTransport } from "@mecahub/transport";
import { RecordingTransport } from "./recording-transport.js";
import {
  LabError,
  STOP_BUDGET_MS,
  type LabCommandError,
  type LabController,
  type LabDevice,
  type LabDeviceKind,
  type LabDiagnostic,
  type LabDiagnosticKind,
  type LabMode,
  type LabMotor,
  type LabSnapshot,
  type MotorTarget,
} from "./lab-types.js";

export interface LabControllerOptions {
  /** Initial mode. Default: "real" when Web Bluetooth is available, else "simulator". */
  readonly mode?: LabMode;
  readonly webBluetoothAvailable?: boolean;
  /** Builds the real transport (the page passes `createWebBleTransport`). */
  readonly createRealTransport?: () => BleTransport;
  /** Time source of the simulator and the timers. Defaults to the real clock. */
  readonly clock?: SimClock;
  /** Monotonic ms clock for timings and the capture. Defaults to the `clock`. */
  readonly now?: () => number;
  /** Date written in the export. */
  readonly date?: () => Date;
  readonly simConfig?: SimHubConfig;
  /** Write latency of the simulated link. Default 0. */
  readonly simWriteLatencyMs?: number;
  /** Entries kept by the recorder (the oldest are dropped). Default 5000. */
  readonly recorderMax?: number;
}

const MAX_DIAGNOSTICS = 200;
const PORT_TILT = 0x3a;
const PORT_LED = 0x32;
const FORMAT_LINE =
  '# format: +<ms since the device was chosen>ms <dir> <hex bytes>; "# ..." lines are notes';

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" ");
const hexPort = (port: number): string => `0x${port.toString(16).padStart(2, "0")}`;
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const PORT_OF: Record<Exclude<MotorTarget, "ab">, number> = { a: 0, b: 1, c: 2, d: 3 };

function kindOf(port: number, ioType: number): LabDeviceKind {
  if (ioType === IoTypeId.ExternalMotorWithTacho || ioType === IoTypeId.InternalMotorWithTacho) {
    return "motor";
  }
  if (ioType === IoTypeId.ColorDistanceSensor) return "colorDistance";
  if (ioType === IoTypeId.InternalTilt && port === PORT_TILT) return "tilt";
  if (ioType === IoTypeId.RgbLight && port === PORT_LED) return "led";
  return "other";
}

function commandError(err: unknown): LabCommandError {
  const code =
    err instanceof HubError || err instanceof TransportError || err instanceof LabError
      ? err.code
      : err instanceof RangeError
        ? "range"
        : "unknown";
  return { code, message: errorText(err) };
}

interface SimRig {
  readonly hub: SimulatedHub;
  readonly transport: SimulatorTransport;
}

/**
 * The lab's brain, in plain TypeScript (no DOM, no React): a MoveHub over the real Web Bluetooth
 * transport or over the simulator, a recorder of every frame, and a snapshot the page renders.
 */
export function createLabController(options: LabControllerOptions = {}): LabController {
  const clock = options.clock ?? realClock;
  const now = options.now ?? (() => clock.now());
  const date = options.date ?? (() => new Date());
  const webBluetoothAvailable = options.webBluetoothAvailable ?? false;
  const listeners = new Set<() => void>();

  const empty = (mode: LabMode): LabSnapshot => ({
    mode,
    webBluetoothAvailable,
    connection: "idle",
    ready: false,
    timings: {},
    hubName: undefined,
    firmware: undefined,
    devices: [],
    hasAb: false,
    motors: [],
    tilt: undefined,
    color: undefined,
    distance: undefined,
    button: undefined,
    battery: undefined,
    led: undefined,
    stop: { status: "idle" },
    diagnostics: [],
    measurements: {},
    running: undefined,
    lastError: undefined,
  });

  const initialMode: LabMode =
    options.mode ?? (webBluetoothAvailable && options.createRealTransport ? "real" : "simulator");
  let snapshot = empty(initialMode);

  // The rig: everything that belongs to one hub over one transport.
  let sim: SimRig | undefined;
  let recorder: RecordingTransport;
  let hub: MoveHub;
  let rigOffs: (() => void)[] = [];
  /** Subscriptions of the current link (the hub forgets them with the link). */
  let linkOffs: (() => void)[] = [];
  let portOffs = new Map<number, () => void>();
  /** Bumped when the link ends: a late subscription of the old link is ignored. */
  let linkEpoch = 0;
  let commandCounter = 0;
  const lastCommand = new Map<number, number>();
  let stopStartedAt = 0;
  let chosenAt = 0;
  let connectedAt = 0;
  let clickAt = 0;
  let disposed = false;

  const publish = (patch: Partial<LabSnapshot>): void => {
    if (disposed) return;
    snapshot = { ...snapshot, ...patch };
    for (const listener of [...listeners]) listener();
  };

  const diag = (kind: LabDiagnosticKind, detail: string): void => {
    const entry: LabDiagnostic = { at: Math.round(now() - chosenAt), kind, detail };
    publish({ diagnostics: [...snapshot.diagnostics, entry].slice(-MAX_DIAGNOSTICS) });
  };

  const patchMotor = (port: number, patch: Partial<LabMotor>): void => {
    publish({ motors: snapshot.motors.map((m) => (m.port === port ? { ...m, ...patch } : m)) });
  };

  // --- hub wiring ---

  const refreshDevices = (): void => {
    const all = hub.registry.devices();
    const devices: LabDevice[] = all.flatMap((d) =>
      d.kind === "physical"
        ? [{ port: d.port, ioType: d.ioType, kind: kindOf(d.port, d.ioType) }]
        : [],
    );
    const motorPorts = devices.filter((d) => d.kind === "motor" && d.port <= 3).map((d) => d.port);
    publish({
      devices,
      hasAb: hub.registry.virtualAb !== undefined,
      motors: motorPorts.map(
        (port) =>
          snapshot.motors.find((m) => m.port === port) ?? {
            port,
            position: undefined,
            commandedSpeed: 0,
          },
      ),
    });
  };

  const motorOf = (port: number): TachoMotor | undefined => {
    if (port === 0) return hub.motors.a;
    if (port === 1) return hub.motors.b;
    return (port === 2 ? hub.portC : hub.portD)?.motor;
  };

  const track = (
    what: string,
    subscription: Promise<() => void>,
    store: (off: () => void) => void,
  ) => {
    const epoch = linkEpoch;
    subscription.then(
      (off) => {
        if (epoch === linkEpoch) store(off);
      },
      (err: unknown) => {
        if (epoch === linkEpoch) diag("subscribe-failed", `${what}: ${errorText(err)}`);
      },
    );
  };

  const subscribePort = (port: number): void => {
    if (!hub.registry.ready) return;
    const device = hub.registry.device(port);
    if (device?.kind !== "physical") return;
    portOffs.get(port)?.();
    portOffs.delete(port);
    const store = (off: () => void) => portOffs.set(port, off);
    const kind = kindOf(port, device.ioType);
    if (kind === "motor") {
      const motor = motorOf(port);
      if (motor) {
        track(
          `motor ${hexPort(port)}`,
          motor.onPosition((position) => patchMotor(port, { position })),
          store,
        );
      }
    } else if (kind === "colorDistance" && port >= 2) {
      const sensor = (port === 2 ? hub.portC : hub.portD)?.colorDistance;
      if (sensor) {
        track(
          `color sensor ${hexPort(port)}`,
          sensor.onColorAndDistance(({ color, inches }) => publish({ color, distance: inches })),
          store,
        );
      }
    }
  };

  const subscribeAll = (): void => {
    linkEpoch++;
    linkOffs = [];
    portOffs = new Map();
    const keep = (off: () => void) => void linkOffs.push(off);
    track(
      "battery",
      hub.onBattery((battery) => publish({ battery })),
      keep,
    );
    track(
      "button",
      hub.button.onChange((button) => publish({ button })),
      keep,
    );
    if (hub.registry.device(PORT_TILT)) {
      track(
        "tilt",
        hub.tilt.onTilt((tilt) => publish({ tilt })),
        keep,
      );
    }
    for (const device of hub.registry.devices()) subscribePort(device.port);
    // What the capture header wants: the advertising name and the firmware, when the hub says them.
    for (const property of ["advertisingName", "firmwareVersion"] as const) {
      hub.session
        .send(encodeHubProperty({ type: "hubProperty", operation: "requestUpdate", property }))
        .catch(() => undefined);
    }
  };

  const onLinkEnded = (): void => {
    linkEpoch++;
    linkOffs = [];
    portOffs = new Map();
    publish({ connection: "disconnected", ready: false });
  };

  const build = (mode: LabMode): void => {
    const inner: BleTransport = (() => {
      if (mode === "simulator") {
        const simHub = new SimulatedHub(options.simConfig ?? defaultMoveHubConfig(), { clock });
        const simTransport = new SimulatorTransport(simHub, {
          clock,
          ...(options.simWriteLatencyMs === undefined
            ? {}
            : { writeLatencyMs: options.simWriteLatencyMs }),
        });
        sim = { hub: simHub, transport: simTransport };
        return simTransport;
      }
      sim = undefined;
      if (!options.createRealTransport) throw new LabError("unsupported");
      return options.createRealTransport();
    })();
    recorder = new RecordingTransport(inner, {
      now,
      ...(options.recorderMax === undefined ? {} : { max: options.recorderMax }),
    });
    hub = new MoveHub(recorder);
    rigOffs = [
      recorder.onConnected((at) => {
        connectedAt = at;
        publish({
          connection: "connected",
          timings: { ...snapshot.timings, connectMs: Math.round((at - chosenAt) * 10) / 10 },
        });
      }),
      recorder.onDisconnect(onLinkEnded),
      hub.onAttach((device) => {
        refreshDevices();
        subscribePort(device.port);
      }),
      hub.onDetach((device) => {
        portOffs.get(device.port)?.();
        portOffs.delete(device.port);
        refreshDevices();
      }),
      hub.onStopFailed((result) => diag("stop-failed", `${result.errors.length} write(s) failed`)),
      hub.session.onEvent((event) => {
        switch (event.kind) {
          case "unattributed-error":
            diag(
              "unattributed-error",
              `command 0x${event.error.commandType.toString(16)} code 0x${event.error.code.toString(16)}`,
            );
            return;
          case "unknown-value":
            diag(
              "unknown-value",
              `port ${hexPort(event.port)} mode ${event.mode} raw ${toHex(event.raw)}`,
            );
            return;
          case "decode-error":
            diag("decode-error", `${event.error.reason}: ${toHex(event.frame)}`);
            return;
          case "framing-error":
            diag("framing-error", `${event.error.reason}: ${toHex(event.chunk)}`);
            return;
          case "link-lost":
            diag("link-lost", "");
            return;
          case "message": {
            const m = event.message;
            if (m.type !== "hubProperty" || m.operation !== "update") return;
            if (m.property === "advertisingName") publish({ hubName: m.value });
            else if (m.property === "firmwareVersion") {
              const v = m.value;
              publish({ firmware: `${v.major}.${v.minor}.${v.bugfix}.${v.build}` });
            }
            return;
          }
        }
      }),
    ];
  };

  const teardown = (): void => {
    for (const off of rigOffs.splice(0)) off();
    for (const off of linkOffs.splice(0)) off();
    for (const off of portOffs.values()) off();
    portOffs = new Map();
    linkEpoch++;
    hub.dispose();
    recorder.dispose();
    sim?.transport.dispose();
    sim?.hub.dispose();
    sim = undefined;
  };

  build(initialMode);

  // --- connection ---

  const elapsedMs = (from: number, to: number): number => Math.round((to - from) * 10) / 10;

  const finishConnect = async (): Promise<void> => {
    await hub.connect();
    const readyAt = now();
    publish({
      connection: "connected",
      ready: true,
      timings: {
        ...snapshot.timings,
        registryMs: elapsedMs(connectedAt, readyAt),
        totalMs: elapsedMs(clickAt, readyAt),
      },
    });
    refreshDevices();
    // A hub that kept a motor running from an earlier link (or a lab reload) must not stay on.
    // First, and awaited: an urgent write cancels the normal writes queued before it.
    recorder.note("STOP after connecting");
    await hub.stopAll();
    subscribeAll();
  };

  const canSwitch = (): boolean =>
    snapshot.connection === "idle" || snapshot.connection === "disconnected";

  const connect = async (): Promise<void> => {
    if (!canSwitch()) return;
    clickAt = now();
    // First call, synchronously: the browser chooser needs the click's user gesture.
    const chosen = recorder.requestDevice();
    publish({ connection: "choosing" });
    try {
      const device = await chosen;
      chosenAt = now();
      recorder.clear();
      recorder.startClock();
      publish({
        connection: "connecting",
        ready: false,
        timings: { chooserMs: elapsedMs(clickAt, chosenAt) },
        hubName: device.name,
        firmware: undefined,
        devices: [],
        motors: [],
        hasAb: false,
        tilt: undefined,
        color: undefined,
        distance: undefined,
        button: undefined,
        battery: undefined,
        stop: { status: "idle" },
        diagnostics: [],
        measurements: {},
        lastError: undefined,
      });
      await finishConnect();
    } catch (err) {
      publish({ connection: recorder.state === "idle" ? "idle" : "disconnected" });
      throw err;
    }
  };

  const reconnect = async (): Promise<void> => {
    if (snapshot.connection !== "disconnected") return;
    recorder.note("reconnect");
    clickAt = now();
    publish({ connection: "connecting" });
    try {
      await finishConnect();
    } catch (err) {
      publish({ connection: "disconnected" });
      throw err;
    }
  };

  const disconnect = async (): Promise<void> => {
    await hub.disconnect();
  };

  // --- motors ---

  const motorForTarget = (target: Exclude<MotorTarget, "ab">): TachoMotor => {
    const port = PORT_OF[target];
    const motor = snapshot.motors.some((m) => m.port === port) ? motorOf(port) : undefined;
    if (!motor) throw new LabError("no-motor", `no motor on port ${target.toUpperCase()}`);
    return motor;
  };

  const portsOf = (target: MotorTarget): number[] => (target === "ab" ? [0, 1] : [PORT_OF[target]]);

  const setCommanded = (target: MotorTarget, speed: number): number => {
    const id = ++commandCounter;
    for (const port of portsOf(target)) {
      lastCommand.set(port, id);
      if (snapshot.motors.some((m) => m.port === port)) patchMotor(port, { commandedSpeed: speed });
    }
    return id;
  };

  /** Clears the commanded speed when a bounded command ended and nothing newer replaced it. */
  const clearIfCurrent = (target: MotorTarget, id: number): void => {
    for (const port of portsOf(target)) {
      if (lastCommand.get(port) === id && snapshot.motors.some((m) => m.port === port)) {
        patchMotor(port, { commandedSpeed: 0 });
      }
    }
  };

  const command = async (fn: () => Promise<void>): Promise<void> => {
    publish({ lastError: undefined });
    try {
      await fn();
    } catch (err) {
      publish({ lastError: commandError(err) });
    }
  };

  const pairOf = () => {
    const pair = hub.motors.ab;
    if (!pair) throw new LabError("no-motor", "the hub announced no AB port");
    return pair;
  };

  const run = (target: MotorTarget, speed: number): Promise<void> =>
    command(async () => {
      if (target === "ab") await pairOf().run(speed, speed);
      else await motorForTarget(target).run(speed);
      setCommanded(target, speed);
    });

  const bounded = (
    target: MotorTarget,
    speed: number,
    start: (motor: TachoMotor) => Promise<unknown>,
  ): Promise<void> =>
    command(async () => {
      if (target === "ab") throw new LabError("unsupported", "no timed command on the AB port");
      const motor = motorForTarget(target);
      const id = setCommanded(target, speed);
      try {
        await start(motor);
      } finally {
        clearIfCurrent(target, id);
      }
    });

  const runFor = (target: MotorTarget, ms: number, speed: number): Promise<void> =>
    bounded(target, speed, (motor) => motor.runFor(ms, speed));

  const rotate = (target: MotorTarget, degrees: number, speed: number): Promise<void> =>
    bounded(target, speed, (motor) => motor.rotate(degrees, speed));

  const hold = (target: MotorTarget, how: "brake" | "float"): Promise<void> =>
    command(async () => {
      if (target === "ab") await (how === "brake" ? pairOf().brake() : pairOf().float());
      else
        await (how === "brake" ? motorForTarget(target).brake() : motorForTarget(target).float());
      setCommanded(target, 0);
    });

  const setLed = (color: number): Promise<void> =>
    command(async () => {
      if (!isColorId(color)) throw new RangeError(`not a color id: ${color}`);
      await hub.led.setColor(color);
      publish({ led: color });
    });

  // --- STOP ---

  const stop = async (): Promise<void> => {
    if (snapshot.stop.status === "pending") {
      // One measurement per press sequence: the extra press still sends its frames (never skip a
      // STOP), but the timing started by the first one stands.
      await hub.stopAll();
      return;
    }
    stopStartedAt = now();
    publish({ stop: { status: "pending" } });
    const result = await hub.stopAll();
    const ms = Math.max(0, elapsedMs(stopStartedAt, now()));
    publish({
      stop: {
        status: "done",
        ok: result.ok,
        errors: result.errors.length,
        ms,
        withinBudget: ms <= STOP_BUDGET_MS,
      },
      // Only a STOP that went out may claim the motors are told to stop.
      ...(result.ok ? { motors: snapshot.motors.map((m) => ({ ...m, commandedSpeed: 0 })) } : {}),
    });
  };

  // --- export ---

  const exportCapture = (): string => {
    const origin =
      snapshot.mode === "real"
        ? "# origin: capturado (real hub, Web Bluetooth)"
        : "# origin: simulado (simulator, NOT a real hub: never store it as a fixture)";
    const header = [
      "# mecahub lab capture",
      origin,
      `# date: ${date().toISOString()}`,
      `# hub name: ${snapshot.hubName ?? "unknown"}`,
      `# firmware: ${snapshot.firmware ?? "unknown"}`,
      FORMAT_LINE,
    ];
    const truncated =
      recorder.dropped > 0 ? [`# truncated: ${recorder.dropped} dropped (oldest first)`] : [];
    const body = recorder.entries().map((e) => {
      if (e.kind === "note") return `# +${e.at}ms ${e.text}`;
      // A write that failed never reached the hub: a comment, so a fixture parser skips it.
      if (e.failed !== undefined) {
        return `# +${e.at}ms ${e.dir} ${toHex(e.bytes)} not written: ${e.failed}`;
      }
      return `+${e.at}ms ${e.dir} ${toHex(e.bytes)}`;
    });
    const results = Object.entries(snapshot.measurements).map(
      ([name, value]) => `# result: ${name} ${JSON.stringify(value)}`,
    );
    return [...header, ...truncated, ...body, ...results, ""].join("\n");
  };

  const exportJson = (): string =>
    JSON.stringify(
      {
        origin: snapshot.mode,
        date: date().toISOString(),
        hubName: snapshot.hubName ?? null,
        firmware: snapshot.firmware ?? null,
        timings: snapshot.timings,
        devices: snapshot.devices,
        measurements: snapshot.measurements,
        diagnostics: snapshot.diagnostics,
        frameCount: recorder.entries().filter((e) => e.kind === "frame").length,
      },
      null,
      2,
    );

  const setMode = (mode: LabMode): void => {
    if (!canSwitch()) throw new LabError("busy", "disconnect first");
    if (mode === "real" && !(webBluetoothAvailable && options.createRealTransport)) {
      throw new LabError("unsupported", "Web Bluetooth is not available");
    }
    if (mode === snapshot.mode) return;
    teardown();
    build(mode);
    snapshot = { ...empty(mode) };
    for (const listener of [...listeners]) listener();
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    setMode,
    connect,
    reconnect,
    disconnect,
    run,
    runFor,
    rotate,
    brake: (target) => hold(target, "brake"),
    float: (target) => hold(target, "float"),
    setLed,
    stop,
    exportCapture,
    exportJson,
    get sim() {
      return sim;
    },
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      // Never leave a motor running behind a closed page (or a hot reload): STOP, then the link.
      if (recorder.state === "connected") {
        try {
          await hub.stopAll();
          await recorder.disconnect();
        } catch {
          // best effort: the teardown below still runs
        }
      }
      teardown();
    },
  };
}
