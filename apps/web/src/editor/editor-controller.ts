import { compile } from "@mecahub/blocks";
import { MoveHub } from "@mecahub/hub";
import { ColorId } from "@mecahub/lwp3";
import { createRuntime, fromMoveHub, type Runtime, type RuntimeDevice } from "@mecahub/runtime";
import {
  SimulatedHub,
  SimulatorTransport,
  defaultMoveHubConfig,
  realClock,
  type LedState,
  type SimClock,
  type SimHubConfig,
} from "@mecahub/simulator";
import { TransportError, type BleTransport } from "@mecahub/transport";
import { mirrorDevice } from "./hub-mirror.js";
import { fromRunError, fromRunResult, fromTransportError, type ProblemKind } from "./problem.js";

// The editor's brain in plain TypeScript (no DOM, no React, no Blockly runtime): it takes the JSON
// of `Blockly.serialization.workspaces.save`, compiles it and runs it on a device. The device is
// the simulator or, on request, a real hub: one controller, two "rigs" (a transport, a MoveHub and a
// runtime that belong together), exactly one of them current. Switching builds a new rig and tears
// the old one down; every listener checks that its rig is still the current one.

/** STOP must halt every motor within this many ms (CLAUDE.md). */
export const STOP_BUDGET_MS = 200;

const PORT_A = 0x00;
const PORT_B = 0x01;

/** `unknown`: a real hub whose link dropped (we cannot tell what its motors are doing). */
export type WheelState = "stopped" | "forward" | "backward" | "unknown";
export type { ProblemKind } from "./problem.js";
export type EditorSource = "simulator" | "hub";
/** `off` until a program sets the light. */
export type LedName =
  | "off"
  | "black"
  | "pink"
  | "purple"
  | "blue"
  | "lightBlue"
  | "cyan"
  | "green"
  | "yellow"
  | "orange"
  | "red"
  | "white";

export type RunOutcome = "completed" | "stopped" | "error" | "invalid" | "busy";

export interface EditorSnapshot {
  running: boolean;
  source: EditorSource;
  /** `dropped`: a real hub's link ended without being asked to (the next Run reconnects). */
  connection: "idle" | "connecting" | "connected" | "failed" | "dropped";
  /** What went wrong, for the child (a pictogram). Cleared by the next Run or `dismissProblem`. */
  problem: ProblemKind | undefined;
  wheels: { a: WheelState; b: WheelState };
  led: LedName;
  /** The statement block being executed, for the workspace to highlight. */
  highlightedBlockId: string | undefined;
  /** Blocks the last Run could not compile; the workspace marks them (visual only). */
  errorBlockIds: readonly string[];
}

export interface EditorController {
  getSnapshot(): EditorSnapshot;
  subscribe(listener: () => void): () => void;
  /**
   * Connects the current device. Idempotent; `run` calls it when needed. It NEVER opens the
   * Bluetooth chooser (that needs a click): only `useHub` does.
   */
  connect(): Promise<void>;
  /** True when this browser can talk to a real hub. */
  readonly hubAvailable: boolean;
  /**
   * Switches to a real hub. Call it synchronously from the click: the chooser opens before anything
   * is awaited, while the browser still sees the user gesture. Never rejects: the outcome is in the
   * snapshot. A dismissed chooser goes back to the simulator without a trace.
   */
  useHub(): Promise<void>;
  /** Halts the robot, drops the hub link and goes back to the simulator. Never rejects. */
  useSimulator(): Promise<void>;
  /** Clears the problem shown to the child. */
  dismissProblem(): void;
  /** Compiles the workspace JSON and runs it. Never rejects. */
  run(workspaceState: unknown): Promise<RunOutcome>;
  /** STOP. Synchronous and always safe: while idle, while connecting, repeated. */
  stop(): void;
  /**
   * Resolves once the writes of the latest STOP settled (immediately if there is none). Never
   * rejects. A caller about to do heavy main-thread work (re-injecting Blockly) waits for it, so
   * that work cannot delay a STOP write past its deadline and get the link declared dead.
   */
  stopSettled(): Promise<void>;
  /** Number of frames written to the simulated hub so far (tests). */
  sentFrames(): number;
  dispose(): void;
}

export interface EditorControllerOptions {
  clock?: SimClock;
  config?: SimHubConfig;
  /** Write latency of the simulated link (tests use it to exercise the STOP budget). */
  simWriteLatencyMs?: number;
  /**
   * Makes the transport of a real hub (a new one per switch). Omit it when the browser cannot use
   * Bluetooth: `hubAvailable` is then false and `useHub` does nothing.
   */
  createHubTransport?: () => BleTransport;
  /** Fault injection for tests: hands out a way to drop the simulated link. */
  onLink?: (link: { dropLink(): void }) => void;
}

const LED_BY_ID: Readonly<Record<number, LedName>> = {
  [ColorId.Black]: "black",
  [ColorId.Pink]: "pink",
  [ColorId.Purple]: "purple",
  [ColorId.Blue]: "blue",
  [ColorId.LightBlue]: "lightBlue",
  [ColorId.Cyan]: "cyan",
  [ColorId.Green]: "green",
  [ColorId.Yellow]: "yellow",
  [ColorId.Orange]: "orange",
  [ColorId.Red]: "red",
  [ColorId.White]: "white",
};

const wheelOf = (speed: number, running: boolean): WheelState =>
  !running || speed === 0 ? "stopped" : speed > 0 ? "forward" : "backward";

/** Everything that belongs to one device over one transport. Exactly one rig is current. */
interface Rig {
  readonly source: EditorSource;
  readonly transport: BleTransport;
  readonly moveHub: MoveHub;
  readonly runtime: Runtime;
  readonly offs: (() => void)[];
  /** Bumped when this rig's link ends: a connect attempt that started before it is stale. */
  epoch: number;
  connecting: Promise<void> | undefined;
  /** Set when we ask for the disconnect ourselves: it is not a dropped link. */
  closing: boolean;
  /** The latest STOP's writes (only the latest: earlier urgent writes are served FIFO before it). */
  lastStop: Promise<unknown>;
  readonly sim: { readonly hub: SimulatedHub; readonly transport: SimulatorTransport } | undefined;
}

/** A stuck link must never freeze the switch back to the simulator. */
const SWITCH_CAP_MS = 1000;

export function createEditorController(options: EditorControllerOptions = {}): EditorController {
  const clock = options.clock ?? realClock;
  const createHubTransport = options.createHubTransport;

  const listeners = new Set<() => void>();
  let snapshot: EditorSnapshot = {
    running: false,
    source: "simulator",
    connection: "idle",
    problem: undefined,
    wheels: { a: "stopped", b: "stopped" },
    led: "off",
    highlightedBlockId: undefined,
    errorBlockIds: [],
  };
  const publish = (patch: Partial<EditorSnapshot>): void => {
    snapshot = { ...snapshot, ...patch };
    for (const listener of [...listeners]) listener();
  };

  /** Bumped by every STOP: a run that was still waiting to start sees it and gives up. */
  let generation = 0;
  let busy = false;
  let disposed = false;
  let switching: Promise<void> | undefined;

  const buildRig = (source: EditorSource): Rig => {
    let sim: Rig["sim"];
    let transport: BleTransport;
    if (source === "simulator") {
      const hub = new SimulatedHub(options.config ?? defaultMoveHubConfig(), { clock });
      const simTransport = new SimulatorTransport(hub, {
        clock,
        ...(options.simWriteLatencyMs === undefined
          ? {}
          : { writeLatencyMs: options.simWriteLatencyMs }),
      });
      options.onLink?.({ dropLink: () => simTransport.dropLink() });
      sim = { hub, transport: simTransport };
      transport = simTransport;
    } else {
      if (!createHubTransport) throw new TransportError("unsupported");
      transport = createHubTransport();
    }
    const moveHub = new MoveHub(transport);
    const rig: Rig = {
      source,
      transport,
      moveHub,
      // Assigned below: the device needs the rig to record its STOPs.
      runtime: undefined as unknown as Runtime,
      offs: [],
      epoch: 0,
      connecting: undefined,
      closing: false,
      lastStop: Promise.resolve(),
      sim,
    };
    const hubDevice = fromMoveHub(moveHub);
    const recording: RuntimeDevice = {
      ...hubDevice,
      has: (resource) => hubDevice.has(resource),
      motor: (port) => hubDevice.motor(port),
      onColorAndDistance: (port, listener) => hubDevice.onColorAndDistance(port, listener),
      onTilt: (listener) => hubDevice.onTilt(listener),
      onButton: (listener) => hubDevice.onButton(listener),
      led: (color) => hubDevice.led(color),
      stopAll: () => (rig.lastStop = hubDevice.stopAll()) as ReturnType<RuntimeDevice["stopAll"]>,
    };
    // The simulator draws what its motors really do; a real hub has nothing to measure, so its
    // preview mirrors the commands (and is "unknown" once the link drops).
    const device =
      source === "simulator"
        ? recording
        : mirrorDevice(recording, {
            wheel: (port, state) => {
              if (rig === current && snapshot.connection !== "dropped") {
                publish({ wheels: { ...snapshot.wheels, [port]: state } });
              }
            },
            led: (led) => {
              if (rig === current) publish({ led });
            },
          });
    (rig as { runtime: Runtime }).runtime = createRuntime({ device, clock });
    return rig;
  };

  // Set right below, before anything can run.
  let current!: Rig;

  /** Wires the rig's listeners. Each one ignores the call unless its rig is still the current one. */
  const wire = (rig: Rig): void => {
    const { runtime, transport } = rig;
    const live = (): boolean => rig === current && !disposed;
    if (rig.sim) {
      const simHub = rig.sim.hub;
      rig.offs.push(
        simHub.onMotorChange((port, state) => {
          if (!live() || (port !== PORT_A && port !== PORT_B)) return;
          const wheel = wheelOf(state.speed, state.running);
          publish({ wheels: { ...snapshot.wheels, [port === PORT_A ? "a" : "b"]: wheel } });
        }),
        simHub.onLedChange((led: LedState) => {
          if (!live()) return;
          publish({ led: led.kind === "index" ? (LED_BY_ID[led.color] ?? "off") : snapshot.led });
        }),
      );
    }
    rig.offs.push(
      runtime.onBlockEnter(({ statementId }) => {
        if (live()) publish({ highlightedBlockId: statementId });
      }),
      runtime.onBlockExit(({ statementId }) => {
        if (live() && snapshot.highlightedBlockId === statementId) {
          publish({ highlightedBlockId: undefined });
        }
      }),
      runtime.onError(({ statementId, error }) => {
        if (!live()) return;
        let kind = fromRunError(error);
        // With the link gone every write fails: the cause is the link, not the STOP or the command.
        if (snapshot.connection === "dropped" && (kind === "stop-failed" || kind === "hub-error")) {
          kind = "link-lost";
        }
        publish({
          ...(statementId === undefined
            ? {}
            : { errorBlockIds: [...new Set([...snapshot.errorBlockIds, statementId])] }),
          ...(kind === undefined ? {} : { problem: kind }),
        });
      }),
      // The link can die under us (on the simulator: a STOP write that missed its deadline makes
      // the transport drop it; on a real hub: the robot went away). Forget the old connection so
      // the next Run connects again instead of failing "not-connected".
      transport.onDisconnect(() => {
        rig.epoch++;
        rig.connecting = undefined;
        if (!live() || rig.closing) return; // a requested disconnect, or a rig already replaced
        if (rig.source === "simulator") {
          if (snapshot.connection !== "idle") publish({ connection: "idle" });
        } else if (snapshot.connection === "connecting") {
          publish({ connection: "failed", problem: "connect-failed" });
        } else if (snapshot.connection === "connected") {
          publish({
            connection: "dropped",
            problem: "link-lost",
            wheels: { a: "unknown", b: "unknown" },
          });
        }
      }),
    );
  };

  const disposeRig = (rig: Rig): void => {
    rig.closing = true;
    for (const off of rig.offs.splice(0)) off();
    try {
      rig.runtime.stop();
    } catch {
      // nothing may keep the teardown from finishing
    }
    rig.moveHub.dispose();
    if (rig.sim) {
      rig.sim.transport.dispose();
      rig.sim.hub.dispose();
    } else {
      // Never leave a hub linked behind a closed page: drop the link once the STOP writes settled.
      void rig.lastStop
        .then(
          () => undefined,
          () => undefined,
        )
        .then(() => rig.transport.disconnect())
        .catch(() => undefined);
    }
  };

  const connectRig = (rig: Rig): Promise<void> => {
    rig.connecting ??= (async () => {
      const epoch = rig.epoch;
      const live = (): boolean => rig === current && !disposed && epoch === rig.epoch;
      publish({ connection: "connecting" });
      try {
        // MoveHub.connect opens the chooser only from an idle transport, and only the click that
        // called useHub gets here with one (connect() below refuses an idle hub transport).
        await rig.moveHub.connect();
        if (!live()) throw new Error("the link dropped while connecting");
        publish({
          connection: "connected",
          problem: undefined,
          ...(rig.source === "hub" ? { wheels: { a: "stopped", b: "stopped" } } : {}),
        });
      } catch (err) {
        if (live()) {
          rig.connecting = undefined;
          if (rig.source === "hub" && err instanceof TransportError && err.code === "cancelled") {
            // The child dismissed the chooser: nothing happened. Back to the simulator, quietly.
            void toSimulator(rig);
          } else {
            publish({ connection: "failed", problem: fromTransportError(err) });
          }
        } // else the drop handler (or the switch) already reset everything: do not overwrite it
        throw err;
      }
    })();
    return rig.connecting;
  };

  /** Replaces the current rig by a fresh simulator rig, connected. Sync: nothing to wait for. */
  const toSimulator = (old: Rig): void => {
    if (disposed) return;
    disposeRig(old);
    enter(buildRig("simulator"));
    void connectRig(current).catch(() => undefined);
  };

  const resetPicture = (source: EditorSource): Partial<EditorSnapshot> => ({
    source,
    connection: "idle",
    problem: undefined,
    wheels: { a: "stopped", b: "stopped" },
    led: "off",
    highlightedBlockId: undefined,
    errorBlockIds: [],
  });

  const enter = (rig: Rig): void => {
    current = rig;
    wire(rig);
    publish(resetPicture(rig.source));
  };

  enter(buildRig("simulator"));

  const stopSettled = (): Promise<void> =>
    current.lastStop.then(
      () => undefined,
      () => undefined,
    );

  const stop = (): void => {
    generation++;
    try {
      // Always hands STOP to the device, running or not (the child's STOP never depends on
      // knowing whether a program is "really" running): `runtime.stop()` either ends the run
      // with a STOP or, when idle, sends one itself. A second STOP here would only double the
      // urgent writes that must all meet their deadline.
      current.runtime.stop();
    } catch {
      // STOP must never throw into the click handler.
    }
  };

  const connect = (): Promise<void> => {
    const rig = current;
    if (rig.source === "hub" && !rig.connecting && rig.transport.state === "idle") {
      // No device was ever chosen: connecting would open the chooser, and only a click may do that.
      publish({ connection: "failed", problem: "connect-failed" });
      return Promise.reject(new TransportError("no-device", "no hub chosen yet"));
    }
    return connectRig(rig);
  };

  const withCap = async (work: Promise<unknown>): Promise<void> => {
    let timer: ReturnType<SimClock["setTimeout"]> | undefined;
    const cap = new Promise<void>((resolve) => {
      timer = clock.setTimeout(resolve, SWITCH_CAP_MS);
    });
    await Promise.race([
      work.then(
        () => undefined,
        () => undefined,
      ),
      cap,
    ]);
    if (timer) clock.clearTimeout(timer);
  };

  const useHub = (): Promise<void> => {
    if (disposed || !createHubTransport || switching || current.source === "hub") {
      return Promise.resolve();
    }
    stop(); // a program running on the simulator ends here
    disposeRig(current);
    let rig: Rig;
    try {
      rig = buildRig("hub");
    } catch {
      enter(buildRig("simulator"));
      return Promise.resolve();
    }
    enter(rig);
    // Synchronous from the click: MoveHub.connect asks for the device before its first await.
    return connectRig(rig).then(
      () => undefined,
      () => undefined,
    );
  };

  const useSimulator = (): Promise<void> => {
    if (disposed || current.source === "simulator") return Promise.resolve();
    switching ??= (async () => {
      const rig = current;
      rig.closing = true; // the disconnect below is ours, not a dropped link
      stop();
      await withCap(stopSettled());
      await withCap(rig.moveHub.disconnect());
      if (!disposed && rig === current) toSimulator(rig);
    })().finally(() => {
      switching = undefined;
    });
    return switching;
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    connect,
    hubAvailable: createHubTransport !== undefined,
    useHub,
    useSimulator,
    dismissProblem: () => {
      if (snapshot.problem !== undefined) publish({ problem: undefined });
    },
    sentFrames: () => current.sim?.transport.sentFrames.length ?? 0,
    async run(workspaceState) {
      if (busy || switching) return "busy";
      busy = true;
      const mine = generation;
      const rig = current;
      publish({ errorBlockIds: [], problem: undefined, running: true });
      try {
        const compiled = compile(workspaceState);
        if (!compiled.ok) {
          const ids = compiled.errors.flatMap((e) => (e.blockId === undefined ? [] : [e.blockId]));
          publish({ errorBlockIds: [...new Set(ids)] });
          return "invalid";
        }
        try {
          await connect();
        } catch {
          return "error";
        }
        if (mine !== generation || disposed || rig !== current) return "stopped"; // STOP while connecting
        const result = await rig.runtime.run(compiled.program);
        if (rig === current && snapshot.problem === undefined) {
          const problem = fromRunResult(result);
          if (problem !== undefined) publish({ problem });
        }
        return result.reason === "completed"
          ? "completed"
          : result.reason === "error"
            ? "error"
            : "stopped";
      } finally {
        busy = false;
        publish({ running: false, highlightedBlockId: undefined });
      }
    },
    stop,
    stopSettled,
    dispose() {
      disposed = true;
      disposeRig(current);
      listeners.clear();
    },
  };
}
