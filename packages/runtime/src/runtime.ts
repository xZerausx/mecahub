import { validateProgram } from "@mecahub/ir";
import type { Program, Script } from "@mecahub/ir";
import { Cancelled } from "./abortable.js";
import { PortArbiter } from "./arbiter.js";
import { realRuntimeClock } from "./clock.js";
import type { RuntimeClock } from "./clock.js";
import type { RuntimeDevice, Unsubscribe } from "./device.js";
import type { EvalEnv, SensorReadings } from "./expressions.js";
import { ScriptRunner } from "./interpreter.js";
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

const NO_SENSORS: SensorReadings = {
  color: () => "none",
  distance: () => 0,
  tilt: () => ({ x: 0, y: 0 }),
  button: () => false,
  motorPosition: () => 0,
};

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

    constructor(private readonly program: Program) {
      for (const v of program.variables) this.variables.set(v.id, v.initial);
    }

    start(): void {
      const scripts = this.program.scripts.filter((s) => s.trigger.type === "start");
      for (const script of scripts) this.launch(script);
      if (this.active.size === 0) this.finish("completed");
    }

    private launch(script: Script): void {
      const own = new AbortController();
      const signal = AbortSignal.any([this.root.signal, own.signal]);
      const env: EvalEnv & { variables: Map<string, number> } = {
        variables: this.variables,
        sensors: NO_SENSORS,
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
          if (!(err instanceof Cancelled)) {
            this.finish(
              "error",
              new RuntimeError("hub-error", err instanceof Error ? err.message : String(err), {
                cause: err,
              }),
              script.id,
              runner.currentStatement,
            );
          }
          this.scriptEnded(script.id);
        },
      );
    }

    private scriptEnded(scriptId: string): void {
      this.active.delete(scriptId);
      if (this.active.size === 0) this.finish("completed");
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
    ) {
      if (this.done) return;
      this.done = true;
      this.root.abort();
      if (reason !== "completed") stopDevice();
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
      execution.start();
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
