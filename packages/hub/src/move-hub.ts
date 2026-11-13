import { IoTypeId, encodePortOutputCommand } from "@mecahub/lwp3";
import type { BleTransport } from "@mecahub/transport";
import { fire } from "./listeners.js";
import { MotorPair } from "./motor-pair.js";
import { MoveHubPort, PortRegistry } from "./registry.js";
import type { PhysicalDevice, PortDevice, PortRegistryOptions } from "./registry.js";
import { HubSession } from "./session.js";
import type { HubSessionOptions } from "./session.js";
import { TachoMotor } from "./tacho-motor.js";

export interface MoveHubOptions {
  readonly session?: HubSessionOptions;
  readonly registry?: PortRegistryOptions;
}

/** Outcome of `stopAll`: every frame is attempted, failures are reported here and never thrown. */
export interface StopResult {
  readonly ok: boolean;
  /** One entry per STOP write that failed (usually a `TransportError`). */
  readonly errors: unknown[];
}

/** A device on an external port (C or D). `motor` is set when it is a tacho motor. */
export interface AttachedDevice {
  readonly info: PhysicalDevice;
  readonly motor: TachoMotor | undefined;
}

const isMotor = (ioType: number): boolean =>
  ioType === IoTypeId.ExternalMotorWithTacho || ioType === IoTypeId.InternalMotorWithTacho;

/**
 * The Move Hub of set 17101: connection, ports, motors and STOP. Everything goes through the
 * `BleTransport` it is given (no browser APIs here). Call `dispose()` when done, after `disconnect()`.
 */
export class MoveHub {
  readonly session: HubSession;
  readonly registry: PortRegistry;
  /** A and B are always there (the Move Hub's fixed motor ports); `ab` once the hub announced it. */
  readonly motors: {
    readonly a: TachoMotor;
    readonly b: TachoMotor;
    readonly ab: MotorPair | undefined;
  };

  private readonly external = new Map<number, TachoMotor>();
  private pair: MotorPair | undefined;
  private readonly offRegistry: (() => void)[] = [];
  private readonly stopFailedListeners = new Set<(result: StopResult) => void>();

  constructor(
    private readonly transport: BleTransport,
    options: MoveHubOptions = {},
  ) {
    this.session = new HubSession(transport, options.session);
    this.registry = new PortRegistry(this.session, options.registry);
    const a = new TachoMotor(this.session, MoveHubPort.A, IoTypeId.InternalMotorWithTacho);
    const b = new TachoMotor(this.session, MoveHubPort.B, IoTypeId.InternalMotorWithTacho);
    const pairFor = () => this.pairFor();
    this.motors = {
      a,
      b,
      get ab() {
        return pairFor();
      },
    };
    // Registered before any user listener, so a motor exists by the time an app hears of the attach.
    this.offRegistry.push(
      this.registry.onAttach((d) => this.onAttached(d)),
      this.registry.onDetach((d) => this.onDetached(d)),
    );
  }

  get portC(): AttachedDevice | undefined {
    return this.portDevice(MoveHubPort.C);
  }

  get portD(): AttachedDevice | undefined {
    return this.portDevice(MoveHubPort.D);
  }

  /**
   * Picks the device (web: opens the chooser, which needs a user gesture), connects, and resolves
   * once the hub announced its ports. Resolves at once if already connected. If the hub announces
   * nothing the link is dropped and this rejects "timeout".
   */
  async connect(): Promise<void> {
    if (this.transport.state === "idle") await this.transport.requestDevice();
    await this.transport.connect();
    try {
      await this.registry.whenReady();
    } catch (err) {
      await this.transport.disconnect();
      throw err;
    }
  }

  /** Stops every motor (best effort), then drops the link. A no-op when there is no link. */
  async disconnect(): Promise<void> {
    if (this.transport.state === "connected") await this.stopAll();
    await this.transport.disconnect();
  }

  /**
   * STOP. Writes, all "urgent" (they jump the write queue and cancel queued normal writes),
   * "immediate" and without feedback: StartPower2 127/127 on the virtual AB port first (if the hub
   * announced one, else A and B separately), then StartPower 127 for every other attached motor.
   * While the hub is still announcing its ports, or when no A/B motor and no virtual port is known,
   * A and B are stopped regardless, so STOP never depends on discovery. Every frame is handed to the
   * transport synchronously, before this returns.
   *
   * Never waits for feedback, and settles every command of every port still waiting for a report
   * as "discarded" right away, so nothing hangs. Idempotent.
   *
   * NEVER REJECTS, so firing it without `await` cannot cause an unhandled rejection: the promise
   * resolves with `{ ok, errors }` after attempting every frame, and when `ok` is false the
   * `onStopFailed` listeners are called too.
   *
   * Timing: urgent writes are serialized, so n frames take about (n + 1) * the write latency (see
   * docs/protocol-notes.md); the AB frame is what keeps the common case at one frame for two motors.
   */
  stopAll(): Promise<StopResult> {
    const failures: unknown[] = [];
    const sends: Promise<void>[] = [];
    let frames: Uint8Array[] = [];
    try {
      frames = this.stopFrames();
    } catch (err) {
      failures.push(err);
    }
    // One frame failing synchronously must not keep the others from being sent.
    for (const frame of frames) {
      try {
        sends.push(this.session.send(frame, { priority: "urgent" }));
      } catch (err) {
        failures.push(err);
      }
    }
    try {
      this.session.discardPendingOutputs();
    } catch (err) {
      failures.push(err);
    }
    return Promise.allSettled(sends).then((results) =>
      this.reportStop([
        ...failures,
        ...results.flatMap((r) => (r.status === "rejected" ? [r.reason as unknown] : [])),
      ]),
    );
  }

  /** Fires when a `stopAll` had at least one failed write. Returns the unsubscribe function. */
  onStopFailed(listener: (result: StopResult) => void): () => void {
    this.stopFailedListeners.add(listener);
    return () => void this.stopFailedListeners.delete(listener);
  }

  /** Fires for every attached device (see `PortRegistry.onAttach`). */
  onAttach(listener: (device: PortDevice) => void): () => void {
    return this.registry.onAttach(listener);
  }

  onDetach(listener: (device: PortDevice) => void): () => void {
    return this.registry.onDetach(listener);
  }

  /** Releases every listener and timer. Does not touch the link: `disconnect()` first. */
  dispose(): void {
    for (const off of this.offRegistry.splice(0)) off();
    this.motors.a.dispose();
    this.motors.b.dispose();
    for (const m of this.external.values()) m.dispose();
    this.stopFailedListeners.clear();
    this.external.clear();
    this.registry.dispose();
    this.session.dispose();
  }

  private reportStop(errors: unknown[]): Promise<StopResult> {
    const result: StopResult = { ok: errors.length === 0, errors };
    if (!result.ok) fire(this.stopFailedListeners, result);
    return Promise.resolve(result);
  }

  private stopFrames(): Uint8Array[] {
    const frames: Uint8Array[] = [];
    const covered = new Set<number>();
    const ab = this.registry.virtualAb;
    if (ab) {
      frames.push(
        encodePortOutputCommand({
          port: ab.port,
          startup: "immediate",
          completion: "none",
          command: { sub: "startPower2", power1: 127, power2: 127 },
        }),
      );
      covered.add(ab.portA).add(ab.portB);
    }
    const motors = this.registry
      .devices()
      .filter((d) => d.kind === "physical" && isMotor(d.ioType))
      .map((d) => d.port);
    // Not announced yet, or no A/B motor known and no virtual port: stop A and B anyway.
    const abKnown =
      ab !== undefined || motors.some((p) => p === MoveHubPort.A || p === MoveHubPort.B);
    const ports = new Set(motors);
    if (!this.registry.ready || !abKnown) {
      ports.add(MoveHubPort.A);
      ports.add(MoveHubPort.B);
    }
    for (const port of [...ports].sort((x, y) => x - y)) {
      if (!covered.has(port) || !this.registry.ready) frames.push(startPower(port));
    }
    return frames;
  }

  private pairFor(): MotorPair | undefined {
    const ab = this.registry.virtualAb;
    if (!ab) {
      this.pair = undefined;
    } else if (this.pair?.port !== ab.port) {
      this.pair = new MotorPair(this.session, ab.port);
    }
    return this.pair;
  }

  private portDevice(port: number): AttachedDevice | undefined {
    const info = this.registry.device(port);
    if (info?.kind !== "physical") return undefined;
    return { info, motor: this.external.get(port) };
  }

  private onAttached(device: PortDevice): void {
    this.external.get(device.port)?.dispose();
    this.external.delete(device.port);
    if (
      device.kind === "physical" &&
      isMotor(device.ioType) &&
      device.port >= MoveHubPort.C &&
      device.port <= MoveHubPort.D
    ) {
      this.external.set(device.port, new TachoMotor(this.session, device.port, device.ioType));
    }
  }

  private onDetached(device: PortDevice): void {
    // Unplugged: nothing to tell the hub.
    this.external.get(device.port)?.dispose({ notifyHub: false });
    this.external.delete(device.port);
  }
}

function startPower(port: number): Uint8Array {
  return encodePortOutputCommand({
    port,
    startup: "immediate",
    completion: "none",
    command: { sub: "startPower", power: 127 },
  });
}
