import { compile } from "@mecahub/blocks";
import { MoveHub } from "@mecahub/hub";
import { ColorId } from "@mecahub/lwp3";
import { createRuntime, fromMoveHub, type Runtime } from "@mecahub/runtime";
import {
  SimulatedHub,
  SimulatorTransport,
  defaultMoveHubConfig,
  realClock,
  type LedState,
  type SimClock,
  type SimHubConfig,
} from "@mecahub/simulator";

// The editor's brain in plain TypeScript (no DOM, no React, no Blockly runtime): it takes the JSON
// of `Blockly.serialization.workspaces.save`, compiles it and runs it on a device. The device is
// the simulator for now. TODO: a real hub through the Web Bluetooth transport (follow-up PR); it
// would only swap the `BleTransport` handed to `MoveHub`.

/** STOP must halt every motor within this many ms (CLAUDE.md). */
export const STOP_BUDGET_MS = 200;

const PORT_A = 0x00;
const PORT_B = 0x01;

export type WheelState = "stopped" | "forward" | "backward";
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
  connection: "idle" | "connecting" | "connected" | "failed";
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
  /** Connects the device. Idempotent; `run` calls it when needed. */
  connect(): Promise<void>;
  /** Compiles the workspace JSON and runs it. Never rejects. */
  run(workspaceState: unknown): Promise<RunOutcome>;
  /** STOP. Synchronous and always safe: while idle, while connecting, repeated. */
  stop(): void;
  /** Number of frames written to the simulated hub so far (tests). */
  sentFrames(): number;
  dispose(): void;
}

export interface EditorControllerOptions {
  clock?: SimClock;
  config?: SimHubConfig;
  /** Write latency of the simulated link (tests use it to exercise the STOP budget). */
  simWriteLatencyMs?: number;
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

export function createEditorController(options: EditorControllerOptions = {}): EditorController {
  const clock = options.clock ?? realClock;
  const hub = new SimulatedHub(options.config ?? defaultMoveHubConfig(), { clock });
  const transport = new SimulatorTransport(hub, {
    clock,
    ...(options.simWriteLatencyMs === undefined
      ? {}
      : { writeLatencyMs: options.simWriteLatencyMs }),
  });
  const moveHub = new MoveHub(transport);
  const runtime: Runtime = createRuntime({ device: fromMoveHub(moveHub), clock });

  const listeners = new Set<() => void>();
  let snapshot: EditorSnapshot = {
    running: false,
    connection: "idle",
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

  const offs = [
    hub.onMotorChange((port, state) => {
      if (port !== PORT_A && port !== PORT_B) return;
      const wheel = wheelOf(state.speed, state.running);
      publish({ wheels: { ...snapshot.wheels, [port === PORT_A ? "a" : "b"]: wheel } });
    }),
    hub.onLedChange((led: LedState) => {
      publish({ led: led.kind === "index" ? (LED_BY_ID[led.color] ?? "off") : snapshot.led });
    }),
    runtime.onBlockEnter(({ statementId }) => publish({ highlightedBlockId: statementId })),
    runtime.onBlockExit(({ statementId }) => {
      if (snapshot.highlightedBlockId === statementId) publish({ highlightedBlockId: undefined });
    }),
  ];

  let connecting: Promise<void> | undefined;
  const connect = (): Promise<void> => {
    connecting ??= (async () => {
      publish({ connection: "connecting" });
      try {
        await moveHub.connect();
        publish({ connection: "connected" });
      } catch (err) {
        connecting = undefined;
        publish({ connection: "failed" });
        throw err;
      }
    })();
    return connecting;
  };

  // The link can die under us (a STOP write that missed its deadline makes the transport drop it).
  // Forget the old connection so the next Run connects again instead of failing "not-connected".
  const offDisconnect = transport.onDisconnect(() => {
    connecting = undefined;
    if (!disposed && snapshot.connection !== "idle") publish({ connection: "idle" });
  });

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    connect,
    sentFrames: () => transport.sentFrames.length,
    async run(workspaceState) {
      if (busy) return "busy";
      busy = true;
      const mine = generation;
      publish({ errorBlockIds: [], running: true });
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
        if (mine !== generation || disposed) return "stopped"; // STOP while connecting
        const result = await runtime.run(compiled.program);
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
    stop() {
      generation++;
      try {
        runtime.stop();
        // Nothing running: still tell a connected hub to halt (safe, and the child's STOP never
        // depends on knowing whether a program is "really" running).
        if (!runtime.running && snapshot.connection === "connected") {
          moveHub.stopAll().catch(() => undefined);
        }
      } catch {
        // STOP must never throw into the click handler.
      }
    },
    dispose() {
      disposed = true;
      for (const off of offs) off();
      offDisconnect();
      runtime.stop();
      moveHub.dispose();
      transport.dispose();
      hub.dispose();
      listeners.clear();
    },
  };
}
