import type { MotorPort, NumericExpression, Script, Statement } from "@mecahub/ir";
import { Cancelled, race, sleep, yieldTurn } from "./abortable.js";
import type { PortArbiter } from "./arbiter.js";
import type { RuntimeClock } from "./clock.js";
import type { FeedbackStatus, MotorHandle, RuntimeDevice } from "./device.js";
import { clampCount, clampSpeed, evalBoolean, evalNumber } from "./expressions.js";
import type { EvalEnv } from "./expressions.js";
import type { SoundSink } from "./types.js";

/** What the interpreter needs from the run it belongs to. */
export interface ScriptContext {
  readonly device: RuntimeDevice;
  readonly clock: RuntimeClock;
  readonly arbiter: PortArbiter;
  readonly env: EvalEnv & { readonly variables: Map<string, number> };
  readonly sound: SoundSink | undefined;
  enter(scriptId: string, statementId: string): void;
  exit(scriptId: string, statementId: string): void;
  /** The `stopAll` statement: STOP everything and end the run. */
  stopAll(): void;
}

/** The longest timed command the hub accepts (its time field is a signed 16-bit value). */
const MAX_TIMED_MS = 32_767;

/**
 * Runs one script. `signal` aborts when the script is stopped or the whole run ends; every await
 * goes through it, and every device call is preceded by a check, so nothing is sent after STOP.
 * `stopSelf` ends only this script (the `stopScript` statement).
 */
export class ScriptRunner {
  /** Id of the statement being executed, for error reports. */
  currentStatement: string | undefined;

  constructor(
    private readonly ctx: ScriptContext,
    private readonly script: Script,
    private readonly signal: AbortSignal,
    private readonly stopSelf: () => void,
  ) {}

  async run(): Promise<void> {
    await this.block(this.script.body);
  }

  private check(): void {
    if (this.signal.aborted) throw new Cancelled();
  }

  /** Every device call goes through here: nothing is sent once the script was cancelled. */
  private send<T>(call: () => Promise<T>): Promise<T> {
    this.check();
    return call();
  }

  private async block(statements: readonly Statement[]): Promise<void> {
    for (const statement of statements) await this.statement(statement);
  }

  private async statement(s: Statement): Promise<void> {
    this.check();
    this.currentStatement = s.id;
    this.ctx.enter(this.script.id, s.id);
    try {
      await this.execute(s);
    } finally {
      this.ctx.exit(this.script.id, s.id);
    }
  }

  private num(expr: NumericExpression): number {
    return evalNumber(expr, this.ctx.env);
  }
  private speed(expr: NumericExpression): number {
    return clampSpeed(this.num(expr));
  }
  private count(expr: NumericExpression): number {
    return clampCount(this.num(expr));
  }

  private async execute(s: Statement): Promise<void> {
    const { device } = this.ctx;
    switch (s.type) {
      case "motorStart": {
        const speed = this.speed(s.speed);
        this.ctx.arbiter.claim([s.port]).release();
        await this.wait(this.send(() => device.motor(s.port).run(speed)));
        return;
      }
      case "motorStop":
        this.ctx.arbiter.claim([s.port]).release();
        await this.wait(
          this.send(() =>
            s.mode === "brake" ? device.motor(s.port).brake() : device.motor(s.port).float(),
          ),
        );
        return;
      case "driveStart": {
        const [a, b] = [this.speed(s.speedA), this.speed(s.speedB)];
        this.ctx.arbiter.claim(["A", "B"]).release();
        await this.wait(this.send(() => device.drive.run(a, b)));
        return;
      }
      case "driveStop":
        this.ctx.arbiter.claim(["A", "B"]).release();
        await this.wait(
          this.send(() => (s.mode === "brake" ? device.drive.brake() : device.drive.float())),
        );
        return;
      case "motorRunForTime":
        await this.timed([[s.port, this.speed(s.speed)]], this.count(s.ms));
        return;
      case "driveForTime":
        await this.timed(
          [
            ["A", this.speed(s.speedA)],
            ["B", this.speed(s.speedB)],
          ],
          this.count(s.ms),
        );
        return;
      case "motorRunForDegrees":
        await this.rotated([[s.port, this.speed(s.speed)]], this.count(s.degrees));
        return;
      case "driveForDegrees":
        await this.rotated(
          [
            ["A", this.speed(s.speedA)],
            ["B", this.speed(s.speedB)],
          ],
          this.count(s.degrees),
        );
        return;
      case "setLed":
        await this.wait(this.send(() => device.led(s.color)));
        return;
      case "playSound":
        this.playSound(s.sound);
        return;
      case "wait":
        await sleep(this.ctx.clock, this.count(s.ms), this.signal);
        return;
      case "waitUntil":
        while (!evalBoolean(s.condition, this.ctx.env)) await this.yield();
        return;
      case "repeat": {
        const times = this.count(s.times);
        for (let i = 0; i < times; i++) {
          await this.yield();
          await this.block(s.body);
        }
        return;
      }
      case "forever":
        for (;;) {
          await this.yield();
          await this.block(s.body);
        }
      case "while":
        for (;;) {
          await this.yield();
          if (!evalBoolean(s.condition, this.ctx.env)) return;
          await this.block(s.body);
        }
      case "if":
        await this.block(evalBoolean(s.condition, this.ctx.env) ? s.then : (s.else ?? []));
        return;
      case "setVariable":
        this.ctx.env.variables.set(s.variable, this.num(s.value));
        return;
      case "changeVariable":
        this.ctx.env.variables.set(
          s.variable,
          (this.ctx.env.variables.get(s.variable) ?? 0) + this.num(s.by),
        );
        return;
      case "stopAll":
        this.ctx.stopAll();
        throw new Cancelled();
      case "stopScript":
        this.stopSelf();
        throw new Cancelled();
    }
  }

  private yield(): Promise<void> {
    return yieldTurn(this.ctx.clock, this.signal);
  }

  /** Awaits a device promise, but gives up the moment this script is cancelled. */
  private wait<T>(promise: Promise<T>): Promise<T> {
    return race(promise, this.signal);
  }

  private playSound(sound: Parameters<SoundSink["play"]>[0]): void {
    try {
      const result = this.ctx.sound?.play(sound);
      if (result) result.catch(() => undefined);
    } catch {
      // A sound failing must not stop the robot program.
    }
  }

  /**
   * Timed motor command(s) on `ports`. A speed of 0 is not a command: with every speed 0 the
   * statement just waits `ms`; with a mix, the stopped wheel is held. Ends early, script
   * continuing, when another script's command replaces it on one of the ports.
   */
  private async timed(motors: readonly [MotorPort, number][], ms: number): Promise<void> {
    if (ms === 0) return;
    if (motors.every(([, speed]) => speed === 0)) {
      await sleep(this.ctx.clock, ms, this.signal);
      return;
    }
    await this.claimed(motors, (port, speed, claim) =>
      this.runChunks(this.ctx.device.motor(port), speed, ms, claim),
    );
  }

  private async rotated(motors: readonly [MotorPort, number][], degrees: number): Promise<void> {
    if (degrees === 0 || motors.every(([, speed]) => speed === 0)) return;
    await this.claimed(motors, (port, speed) =>
      this.send(() => this.ctx.device.motor(port).rotate(degrees, speed)),
    );
  }

  private async claimed(
    motors: readonly [MotorPort, number][],
    command: (port: MotorPort, speed: number, claim: AbortSignal) => Promise<unknown>,
  ): Promise<void> {
    const claim = this.ctx.arbiter.claim(motors.map(([port]) => port));
    try {
      const all = Promise.all(
        motors.map(([port, speed]) =>
          speed === 0
            ? this.send(() => this.ctx.device.motor(port).brake())
            : command(port, speed, claim.signal),
        ),
      );
      // Replaced by another command: this statement ends, the script goes on.
      await this.wait(
        race(all, claim.signal).catch((err: unknown) => {
          if (err instanceof Cancelled) return undefined;
          throw err;
        }),
      );
    } finally {
      claim.release();
    }
  }

  private async runChunks(
    motor: MotorHandle,
    speed: number,
    ms: number,
    claim: AbortSignal,
  ): Promise<FeedbackStatus> {
    let status: FeedbackStatus = "completed";
    for (let left = ms; left > 0 && status !== "discarded"; left -= MAX_TIMED_MS) {
      if (claim.aborted) return "discarded"; // replaced meanwhile: send nothing more
      const chunk = Math.min(left, MAX_TIMED_MS);
      status = await this.send(() => motor.runFor(chunk, speed));
    }
    return status;
  }
}
