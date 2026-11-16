import type { Color, MotorPort, SensorPort } from "@mecahub/ir";
import type {
  ColorDistanceReading,
  DriveHandle,
  FeedbackStatus,
  MotorHandle,
  Resource,
  RuntimeDevice,
  TiltReading,
  Unsubscribe,
} from "../device.js";

interface Pending {
  readonly op: string;
  readonly resolve: (status: FeedbackStatus) => void;
  readonly reject: (error: unknown) => void;
}

type Listeners<T> = Set<(value: T) => void>;

/**
 * Test double for `RuntimeDevice`. Every call is recorded in `log` as it is made (a readable
 * string such as `motor.A.run(50)`), commands with feedback stay pending until the test completes
 * them, and sensor values are pushed by hand. Subscriptions report an initial value right after
 * they are confirmed, like the hub does (turn it off with `autoInitial = false`).
 */
export class FakeDevice implements RuntimeDevice {
  readonly log: string[] = [];
  readonly pending: Pending[] = [];
  readonly missing = new Set<Resource>();
  autoInitial = true;
  /** Fails the next call whose log entry starts with this prefix. */
  failNext: { prefix: string; error: unknown } | undefined;
  stopResult = { ok: true };

  initial = {
    colorDistance: { color: "none", distance: 10 } as ColorDistanceReading,
    tilt: { x: 0, y: 0 } as TiltReading,
    button: false,
    position: 0,
  };

  private readonly colorListeners = new Map<SensorPort, Listeners<ColorDistanceReading>>();
  private readonly tiltListeners: Listeners<TiltReading> = new Set();
  private readonly buttonListeners: Listeners<boolean> = new Set();
  private readonly positionListeners = new Map<MotorPort, Listeners<number>>();

  has(resource: Resource): boolean {
    return !this.missing.has(resource);
  }

  motor(port: MotorPort): MotorHandle {
    const p = `motor.${port}`;
    return {
      run: (speed) => this.immediate(`${p}.run(${speed})`),
      runFor: (ms, speed) => this.feedback(`${p}.runFor(${ms},${speed})`),
      rotate: (degrees, speed) => this.feedback(`${p}.rotate(${degrees},${speed})`),
      brake: () => this.immediate(`${p}.brake`),
      float: () => this.immediate(`${p}.float`),
      onPosition: (l) =>
        this.subscribe(`position.${port}`, this.positionListeners, port, l, this.initial.position),
    };
  }

  readonly drive: DriveHandle = {
    run: (a, b) => this.immediate(`drive.run(${a},${b})`),
    brake: () => this.immediate("drive.brake"),
    float: () => this.immediate("drive.float"),
  };

  led(color: Color): Promise<void> {
    return this.immediate(`led(${color})`);
  }

  onColorAndDistance(port: SensorPort, l: (r: ColorDistanceReading) => void): Promise<Unsubscribe> {
    return this.subscribe(
      `colorDistance.${port}`,
      this.colorListeners,
      port,
      l,
      this.initial.colorDistance,
    );
  }

  onTilt(l: (t: TiltReading) => void): Promise<Unsubscribe> {
    return this.subscribe("tilt", this.tiltListeners, undefined, l, this.initial.tilt);
  }

  onButton(l: (pressed: boolean) => void): Promise<Unsubscribe> {
    return this.subscribe("button", this.buttonListeners, undefined, l, this.initial.button);
  }

  stopAll(): Promise<{ ok: boolean }> {
    this.log.push("stopAll");
    for (const p of this.pending.splice(0)) p.resolve("discarded");
    return Promise.resolve(this.stopResult);
  }

  // ------------------------------------------------------------------ test controls

  pushColorDistance(port: SensorPort, reading: ColorDistanceReading): void {
    for (const l of [...(this.colorListeners.get(port) ?? [])]) l(reading);
  }
  pushTilt(x: number, y: number): void {
    for (const l of [...this.tiltListeners]) l({ x, y });
  }
  pushButton(pressed: boolean): void {
    for (const l of [...this.buttonListeners]) l(pressed);
  }
  pushPosition(port: MotorPort, degrees: number): void {
    for (const l of [...(this.positionListeners.get(port) ?? [])]) l(degrees);
  }

  /** Ends the oldest pending command whose log entry starts with `prefix` (default: the oldest). */
  complete(prefix = "", status: FeedbackStatus = "completed"): void {
    const i = this.pending.findIndex((p) => p.op.startsWith(prefix));
    if (i < 0) throw new Error(`no pending command starting with "${prefix}"`);
    this.pending.splice(i, 1)[0]?.resolve(status);
  }

  /** Active subscriptions, by name (`tilt`, `button`, `colorDistance.D`, `position.A`). */
  get subscriptions(): string[] {
    const names: string[] = [];
    for (const [k, v] of this.colorListeners) if (v.size) names.push(`colorDistance.${k}`);
    for (const [k, v] of this.positionListeners) if (v.size) names.push(`position.${k}`);
    if (this.tiltListeners.size) names.push("tilt");
    if (this.buttonListeners.size) names.push("button");
    return names.sort();
  }

  // --------------------------------------------------------------------- internals

  private maybeFail(op: string): Promise<never> | undefined {
    if (this.failNext && op.startsWith(this.failNext.prefix)) {
      const { error } = this.failNext;
      this.failNext = undefined;
      return Promise.reject(error as Error);
    }
    return undefined;
  }

  private immediate(op: string): Promise<void> {
    this.log.push(op);
    return this.maybeFail(op) ?? Promise.resolve();
  }

  private feedback(op: string): Promise<FeedbackStatus> {
    this.log.push(op);
    const failed = this.maybeFail(op);
    if (failed) return failed;
    return new Promise<FeedbackStatus>((resolve, reject) => {
      this.pending.push({ op, resolve, reject });
    });
  }

  private subscribe<K, T>(
    name: string,
    store: Map<K, Listeners<T>> | Listeners<T>,
    key: K | undefined,
    listener: (value: T) => void,
    initial: T,
  ): Promise<Unsubscribe> {
    this.log.push(`subscribe(${name})`);
    const failed = this.maybeFail(`subscribe(${name})`);
    if (failed) return failed;
    let set: Listeners<T>;
    if (store instanceof Map) {
      let existing = store.get(key as K);
      if (!existing) store.set(key as K, (existing = new Set()));
      set = existing;
    } else {
      set = store;
    }
    set.add(listener);
    if (this.autoInitial) queueMicrotask(() => set.has(listener) && listener(initial));
    return Promise.resolve(() => {
      this.log.push(`unsubscribe(${name})`);
      set.delete(listener);
    });
  }
}
