import { validateProgram } from "@mecahub/ir";
import type { Program, Script } from "@mecahub/ir";
import { Cancelled, race, sleep } from "./abortable.js";
import { PortArbiter } from "./arbiter.js";
import { realRuntimeClock } from "./clock.js";
import type { RuntimeClock } from "./clock.js";
import type { RuntimeDevice, Unsubscribe } from "./device.js";
import type { EvalEnv } from "./expressions.js";
import { ScriptRunner } from "./interpreter.js";
import { SensorCache, planProgram } from "./sensors.js";
import type { SensorPlan } from "./sensors.js";
import { EdgeDetector } from "./triggers.js";
import { RuntimeError } from "./types.js";
import type { BlockEvent, ErrorEvent, RunResult, SoundSink } from "./types.js";

export interface RuntimeOptions {
  readonly device: RuntimeDevice;
  /** Defaults to the global timers. */
  readonly clock?: RuntimeClock;
  /** Defaults to no sound (the hub has no speaker). */
  readonly sound?: SoundSink;
  /** Uniform in [0, 1). Defaults to `Math.random`. */
  readonly random?: () => number;
}

export interface Runtime {
  /** Never rejects. Resolves when every script is done or the run was stopped. */
  run(program: Program): Promise<RunResult>;
  /** STOP. Synchronous (every halting frame is handed to the link before it returns) and idempotent. */
  stop(): void;
  readonly running: boolean;
  onBlockEnter(listener: (event: BlockEvent) => void): Unsubscribe;
  onBlockExit(listener: (event: BlockEvent) => void): Unsubscribe;
  onError(listener: (event: ErrorEvent) => void): Unsubscribe;
  onFinished(listener: (result: RunResult) => void): Unsubscribe;
}

type Listeners<T> = Set<(event: T) => void>;

const fire = <T>(listeners: Listeners<T>, event: T): void => {
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch {
      // A listener's bug must not break the run (or STOP).
    }
  }
};

const subscribe = <T>(listeners: Listeners<T>, listener: (event: T) => void): Unsubscribe => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/**
 * How long to wait for every subscribed sensor to report once before giving up. supuesto: the hub
 * reports the current value right after a subscription is set up; no real capture of that yet. TODO(hw)
 */
export const FIRST_VALUE_TIMEOUT_MS = 2000;

export function createRuntime(options: RuntimeOptions): Runtime {
  const { device } = options;
  const clock = options.clock ?? realRuntimeClock;
  const random = options.random ?? Math.random;
  const enterListeners: Listeners<BlockEvent> = new Set();
  const exitListeners: Listeners<BlockEvent> = new Set();
  const errorListeners: Listeners<ErrorEvent> = new Set();
  const finishedListeners: Listeners<RunResult> = new Set();
  let current: Execution | undefined;

  /** One call of `run()`. */
  class Execution {
    readonly root = new AbortController();
    private readonly variables = new Map<string, number>();
    private readonly arbiter = new PortArbiter();
    private readonly unsubscribers: Unsubscribe[] = [];
    private readonly active = new Set<string>();
    private done = false;
    private resolve!: (result: RunResult) => void;
    readonly result = new Promise<RunResult>((resolve) => (this.resolve = resolve));

    private readonly cache = new SensorCache();
    private readonly detectors: EdgeDetector[];
    private readonly plan: SensorPlan;
    private ready: (() => void) | undefined;
    private started = false;

    constructor(private readonly program: Program) {
      for (const v of program.variables) this.variables.set(v.id, v.initial);
      this.plan = planProgram(program);
      this.detectors = program.scripts
        .filter((script) => script.trigger.type !== "start")
        .map((script) => new EdgeDetector(script));
    }

    /** Checks the robot, subscribes to the sensors in use, then starts every start script together. */
    async start(): Promise<void> {
      const missing = this.plan.resources.filter((r) => !device.has(r));
      if (missing.length > 0) {
        // A refusal before anything started: nothing moved, so nothing needs a STOP.
        this.finish(
          "error",
          new RuntimeError("missing-device", `the robot has no ${missing.join(", ")}`),
          undefined,
          undefined,
          false,
        );
        return;
      }
      try {
        await race(this.subscribeAll(), this.root.signal);
        await this.awaitFirstValues();
      } catch (err) {
        if (!(err instanceof Cancelled)) this.fail(err);
        return;
      }
      this.started = true;
      for (const script of this.program.scripts) {
        if (script.trigger.type === "start") this.launch(script);
      }
      this.evaluateTriggers();
      if (this.active.size === 0 && this.detectors.length === 0) this.finish("completed");
    }

    private fail(err: unknown, scriptId?: string, statementId?: string): void {
      const error =
        err instanceof RuntimeError
          ? err
          : new RuntimeError("hub-error", err instanceof Error ? err.message : String(err), {
              cause: err,
            });
      this.finish("error", error, scriptId, statementId);
    }

    private async subscribeAll(): Promise<void> {
      const track = (pending: Promise<Unsubscribe>): Promise<void> =>
        pending.then((off) => {
          if (this.done) off();
          else this.unsubscribers.push(off);
        });
      const { cache } = this;
      const subs: Promise<void>[] = [];
      for (const port of this.plan.colorDistance) {
        subs.push(
          track(
            device.onColorAndDistance(port, (r) => {
              cache.setColorDistance(port, r.color, r.distance);
              this.sensorChanged();
            }),
          ),
        );
      }
      for (const port of this.plan.positions) {
        subs.push(
          track(
            device.motor(port).onPosition((degrees) => {
              cache.setPosition(port, degrees);
              this.sensorChanged();
            }),
          ),
        );
      }
      if (this.plan.tilt) {
        subs.push(
          track(
            device.onTilt((t) => {
              cache.setTilt(t.x, t.y);
              this.sensorChanged();
            }),
          ),
        );
      }
      if (this.plan.button) {
        subs.push(
          track(
            device.onButton((pressed) => {
              cache.setButton(pressed);
              this.sensorChanged();
            }),
          ),
        );
      }
      await Promise.all(subs);
    }

    private async awaitFirstValues(): Promise<void> {
      if (this.cache.ready(this.plan)) return;
      const timer = new AbortController();
      const signal = AbortSignal.any([this.root.signal, timer.signal]);
      const reported = new Promise<void>((resolve) => (this.ready = resolve));
      const timedOut = sleep(clock, FIRST_VALUE_TIMEOUT_MS, signal).then(() => {
        throw new RuntimeError("sensor-timeout", "a sensor did not report a value");
      });
      try {
        await race(Promise.race([reported, timedOut]), this.root.signal);
      } finally {
        timer.abort();
        this.ready = undefined;
      }
    }

    private sensorChanged(): void {
      if (this.done) return;
      if (!this.started) {
        if (this.cache.ready(this.plan)) this.ready?.();
        return;
      }
      this.evaluateTriggers();
    }

    /** Starts the event scripts whose condition just became true; an event for a running script is dropped. */
    private evaluateTriggers(): void {
      for (const detector of this.detectors) {
        if (this.done) return;
        if (detector.update(this.cache) && !this.active.has(detector.script.id)) {
          this.launch(detector.script);
        }
      }
    }

    private launch(script: Script): void {
      const own = new AbortController();
      const signal = AbortSignal.any([this.root.signal, own.signal]);
      const env: EvalEnv & { variables: Map<string, number> } = {
        variables: this.variables,
        sensors: this.cache,
        random,
      };
      const runner = new ScriptRunner(
        {
          device,
          clock,
          arbiter: this.arbiter,
          env,
          sound: options.sound,
          enter: (scriptId, statementId) => fire(enterListeners, { scriptId, statementId }),
          exit: (scriptId, statementId) => fire(exitListeners, { scriptId, statementId }),
          stopAll: () => this.finish("stopAll"),
        },
        script,
        signal,
        () => own.abort(),
      );
      this.active.add(script.id);
      runner.run().then(
        () => this.scriptEnded(script.id),
        (err: unknown) => {
          if (!(err instanceof Cancelled)) this.fail(err, script.id, runner.currentStatement);
          this.scriptEnded(script.id);
        },
      );
    }

    private scriptEnded(scriptId: string): void {
      this.active.delete(scriptId);
      if (this.active.size === 0 && this.detectors.length === 0) this.finish("completed");
    }

    /**
     * Ends the run. Anything but "completed" is a STOP, in this order and all synchronously:
     * abort every script, hand the STOP frames to the device, drop the subscriptions.
     */
    finish(
      reason: RunResult["reason"],
      error?: RuntimeError,
      scriptId?: string,
      statementId?: string,
      stop = true,
    ) {
      if (this.done) return;
      this.done = true;
      this.root.abort();
      if (reason !== "completed" && stop) stopDevice();
      for (const off of this.unsubscribers.splice(0)) off();
      if (current === this) current = undefined;
      const result: RunResult = error ? { reason, error } : { reason };
      if (error) {
        fire(errorListeners, {
          ...(scriptId === undefined ? {} : { scriptId }),
          ...(statementId === undefined ? {} : { statementId }),
          error,
        });
      }
      this.resolve(result);
      fire(finishedListeners, result);
    }
  }

  const stopDevice = (): void => {
    void device.stopAll().then((r) => {
      if (!r.ok) {
        fire(errorListeners, {
          error: new RuntimeError("stop-failed", "some STOP writes failed"),
        });
      }
    });
  };

  const refused = (error: RuntimeError, notify: boolean): RunResult => {
    const result: RunResult = { reason: "error", error };
    if (notify) {
      fire(errorListeners, { error });
      fire(finishedListeners, result);
    }
    return result;
  };

  return {
    get running() {
      return current !== undefined;
    },

    run(program: Program): Promise<RunResult> {
      if (current)
        return Promise.resolve(
          refused(new RuntimeError("busy", "a program is already running"), false),
        );
      const validated = validateProgram(program);
      if (!validated.ok) {
        return Promise.resolve(
          refused(
            new RuntimeError("invalid-program", "the program is not valid", {
              validation: validated.errors,
            }),
            true,
          ),
        );
      }
      const execution = new Execution(validated.program);
      current = execution;
      void execution.start();
      return execution.result;
    },

    stop(): void {
      if (current) current.finish("stopped");
      else stopDevice();
    },

    onBlockEnter: (l) => subscribe(enterListeners, l),
    onBlockExit: (l) => subscribe(exitListeners, l),
    onError: (l) => subscribe(errorListeners, l),
    onFinished: (l) => subscribe(finishedListeners, l),
  };
}
