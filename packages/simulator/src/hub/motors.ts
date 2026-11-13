import {
  ErrorCode,
  MessageType,
  encodeGenericError,
  encodePortOutputFeedback,
  type PortOutputCommandMessage,
} from "@mecahub/lwp3";
import type { SimClock, SimTimerHandle } from "./clock.js";
import type { SimHubConfig } from "./config.js";
import { DEFAULT_MAX_DEG_PER_SEC, MOTOR_IO_TYPES, SimMotor } from "./motor.js";

/** What the app (and the UI) can see of a motor. `position` is in whole degrees, `speed` in percent. */
export interface MotorState {
  readonly position: number;
  readonly speed: number;
  readonly running: boolean;
}

export interface MotorBankHooks {
  /** A hub-to-app frame. */
  send(frame: Uint8Array): void;
  /** A motor's visible state changed (also while the link is down). */
  changed(port: number, state: MotorState): void;
}

/** Time between motor updates, only while something moves. */
const TICK_MS = 10;

type Command = PortOutputCommandMessage["command"];

/** Feedback flags (doc 3.32). supuesto: when each is sent. TODO(hw) */
const IN_PROGRESS = 0x01;
const COMPLETED = 0x02;
const DISCARDED = 0x04;
const IDLE_COMPLETED = 0x0a;
const BUSY_FULL = 0x10;

/** What a command asks the motors of its port to do. */
type Action =
  | { readonly kind: "run"; readonly speeds: readonly number[] }
  | { readonly kind: "timed"; readonly speeds: readonly number[]; readonly ms: number }
  | { readonly kind: "degrees"; readonly speeds: readonly number[]; readonly degrees: number }
  | { readonly kind: "goto"; readonly target: number; readonly speed: number };

/**
 * An addressable port: a physical motor, or the virtual port that combines two of them. A motor
 * belongs to at most one slot's current command at a time.
 */
interface Slot {
  readonly port: number;
  readonly motors: readonly SimMotor[];
  readonly virtual: boolean;
  current: { readonly action: Action; remainingMs: number; readonly feedback: boolean } | undefined;
  /**
   * The command waiting for the running one (startup "buffer"). supuesto: the buffer holds exactly
   * one command (doc 3.32 only says busy/full exists). TODO(hw)
   */
  pending: { readonly action: Action; readonly feedback: boolean } | undefined;
}

/** Speed or power byte to the percent a motor runs at: 0 (float), 126 (hold) and 127 (brake) stop. */
const level = (v: number) => (v === 0 || v === 126 || v === 127 ? 0 : v);

/**
 * The motors of a simulated hub and the port output commands (0x81) that drive them. Time-stepped
 * with the injected clock, only while something moves. Behaviours are supuestos (TODO(hw)) unless
 * a comment says otherwise.
 */
export class MotorBank {
  private readonly motors = new Map<number, SimMotor>();
  private readonly slots = new Map<number, Slot>();
  private readonly shown = new Map<number, MotorState>();
  private timer: SimTimerHandle | undefined;
  private lastTick = 0;

  constructor(
    config: SimHubConfig,
    private readonly clock: SimClock,
    private readonly hooks: MotorBankHooks,
  ) {
    for (const p of config.ports) {
      if (!MOTOR_IO_TYPES.includes(p.ioType)) continue;
      const motor = new SimMotor(p.maxDegPerSec ?? DEFAULT_MAX_DEG_PER_SEC);
      this.motors.set(p.port, motor);
      this.slots.set(p.port, {
        port: p.port,
        motors: [motor],
        virtual: false,
        current: undefined,
        pending: undefined,
      });
      this.shown.set(p.port, this.snapshot(motor));
    }
    for (const v of config.virtualPorts) {
      const a = this.motors.get(v.portA);
      const b = this.motors.get(v.portB);
      if (a && b) {
        this.slots.set(v.port, {
          port: v.port,
          motors: [a, b],
          virtual: true,
          current: undefined,
          pending: undefined,
        });
      }
    }
  }

  /** Port numbers of the physical motors. */
  get ports(): number[] {
    return [...this.motors.keys()];
  }

  isMotorPort(port: number): boolean {
    return this.motors.has(port);
  }

  state(port: number): MotorState {
    const motor = this.motors.get(port);
    if (!motor) throw new RangeError(`port 0x${port.toString(16)} is not a motor`);
    return this.snapshot(motor);
  }

  /**
   * The raw value a motor port reports in `mode`, or undefined for a mode that is not modelled.
   * derivado del layout: mode 1 is the speed (1 signed byte) and mode 2 the position (signed 32-bit
   * little-endian), pylgbst peripherals.py:487-488, 541-548; node-poweredup tachomotor.ts:169.
   */
  value(port: number, mode: number): Uint8Array | undefined {
    const motor = this.motors.get(port);
    if (!motor) return undefined;
    if (mode === 1) return Uint8Array.of(Math.max(-100, Math.min(100, motor.speed)) & 0xff);
    if (mode !== 2) return undefined;
    const out = new Uint8Array(4);
    new DataView(out.buffer).setInt32(0, motor.degrees, true);
    return out;
  }

  /** Handles a port output command. Answers with a generic error when it cannot be carried out. */
  command(msg: PortOutputCommandMessage): void {
    this.catchUp();
    const slot = this.slots.get(msg.port);
    if (!slot) return this.error(ErrorCode.InvalidUse);
    const action = this.actionOf(slot, msg.command);
    if (action === "unrecognized") return this.error(ErrorCode.CommandNotRecognized);
    if (action === undefined) return this.error(ErrorCode.InvalidUse);
    const feedback = msg.completion === "feedback";
    if (msg.startup === "buffer" && this.inProgress(slot)) {
      // Buffer if necessary: wait for the running command; a second waiter is refused.
      if (slot.pending) this.report(slot.port, BUSY_FULL);
      else slot.pending = { action, feedback };
      return;
    }
    // Execute immediately (or nothing to wait for): whatever this port had is discarded.
    this.discard(slot);
    this.start(slot, action, feedback);
    this.settle();
  }

  /** A command is in progress until it completes; a run-until-replaced one is complete as it starts. */
  private inProgress(slot: Slot): boolean {
    return slot.current !== undefined && slot.current.action.kind !== "run";
  }

  /** Drops the running and the buffered command of a port, reporting one "discarded" if any asked. */
  private discard(slot: Slot): void {
    const asked =
      (this.inProgress(slot) && slot.current?.feedback === true) || slot.pending?.feedback === true;
    slot.current = undefined;
    slot.pending = undefined;
    if (asked) this.report(slot.port, DISCARDED);
  }

  private report(port: number, flags: number): void {
    this.hooks.send(encodePortOutputFeedback({ ports: [{ port, flags }] }));
  }

  /** Stops every motor and forgets every command, silently. */
  stopAll(): void {
    this.catchUp();
    for (const slot of this.slots.values()) {
      slot.current = undefined;
      slot.pending = undefined;
    }
    for (const motor of this.motors.values()) motor.stop();
    this.settle();
  }

  /**
   * Ends the simulation: clears the tick and freezes the motors where they are, silently. Needed
   * only when motors would otherwise keep ticking (`stopMotorsOnLinkLoss` false).
   */
  dispose(): void {
    this.catchUp();
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
    for (const slot of this.slots.values()) {
      slot.current = undefined;
      slot.pending = undefined;
    }
    for (const motor of this.motors.values()) motor.stop();
  }

  /**
   * Moves the motors up to now. Time passes between ticks: a command (or a stop) must see the
   * position it really has, and keep the motion made since the last tick, not lose or double it.
   * The timed commands' remaining time is advanced too.
   */
  private catchUp(): void {
    if (this.timer === undefined) return;
    const now = this.clock.now();
    this.advance(now - this.lastTick);
    this.lastTick = now;
  }

  private actionOf(slot: Slot, c: Command): Action | "unrecognized" | undefined {
    const n = slot.motors.length;
    const all = (v: number) => Array.from({ length: n }, () => level(v));
    switch (c.sub) {
      case "startPower":
        return { kind: "run", speeds: all(c.power) };
      case "startSpeed":
        return { kind: "run", speeds: all(c.speed) };
      case "startPower2":
        return slot.virtual
          ? { kind: "run", speeds: [level(c.power1), level(c.power2)] }
          : undefined;
      case "startSpeed2":
        return slot.virtual
          ? { kind: "run", speeds: [level(c.speed1), level(c.speed2)] }
          : undefined;
      case "startSpeedForTime":
        return { kind: "timed", speeds: all(c.speed), ms: c.time };
      case "startSpeedForDegrees":
        return { kind: "degrees", speeds: all(c.speed), degrees: c.degrees };
      case "gotoAbsolutePosition":
        // The doc says 1..100; the lenient decoder never lets more through, but clamp anyway.
        return slot.virtual
          ? undefined
          : { kind: "goto", target: c.absPos, speed: Math.min(100, c.speed) };
      case "writeDirectModeData": {
        // derivado del layout: mode 0 with one signed byte is the motor power, node-poweredup
        // basicmotor.ts:28 (setPower writes direct mode 0). Other modes are not modelled.
        const power = c.data[0];
        if (slot.virtual || c.mode !== 0 || c.data.length !== 1 || power === undefined) {
          return undefined;
        }
        return { kind: "run", speeds: [level(power >= 0x80 ? power - 0x100 : power)] };
      }
      case "unknown":
        return "unrecognized";
    }
  }

  private start(slot: Slot, action: Action, feedback: boolean): void {
    // A command takes its motors from whatever else was using them. supuesto: the other motor of a
    // virtual-port command stops with it. TODO(hw)
    for (const other of this.slots.values()) {
      if (other === slot || !other.current) continue;
      if (other.motors.some((m) => slot.motors.includes(m))) {
        this.discard(other);
        for (const m of other.motors) m.stop();
      }
    }
    this.apply(slot, action, feedback);
    if (feedback) {
      this.report(slot.port, IN_PROGRESS);
      // A run-until-replaced command has nothing to wait for: it is complete as it starts.
      if (action.kind === "run") this.report(slot.port, IDLE_COMPLETED);
    }
    this.finishIfDone(slot);
    this.ensureTicking();
  }

  private apply(slot: Slot, action: Action, feedback: boolean): void {
    const { motors } = slot;
    switch (action.kind) {
      case "run":
      case "timed":
        motors.forEach((m, i) => m.run(action.speeds[i] ?? 0));
        break;
      case "degrees":
        motors.forEach((m, i) => {
          const speed = action.speeds[i] ?? 0;
          if (speed === 0) m.stop();
          else m.moveTo(m.position + Math.sign(speed) * action.degrees, Math.abs(speed));
        });
        break;
      case "goto":
        motors.forEach((m) => m.moveTo(action.target, action.speed));
        break;
    }
    slot.current = { action, remainingMs: action.kind === "timed" ? action.ms : 0, feedback };
  }

  /** The command is over when its time ran out or every motor reached its target. */
  private finishIfDone(slot: Slot): boolean {
    const cur = slot.current;
    if (!cur) return false;
    const done =
      cur.action.kind === "timed"
        ? cur.remainingMs <= 0
        : cur.action.kind === "run"
          ? false
          : !slot.motors.some((m) => m.seeking);
    if (!done) return false;
    // supuesto: float, hold and brake end states are the same here (no inertia model). TODO(hw)
    for (const m of slot.motors) m.stop();
    slot.current = undefined;
    const next = slot.pending;
    slot.pending = undefined;
    if (cur.feedback) this.report(slot.port, next ? COMPLETED : IDLE_COMPLETED);
    if (next) this.start(slot, next.action, next.feedback);
    return true;
  }

  private ensureTicking(): void {
    if (this.timer !== undefined) return;
    // A timed command needs its time to pass even when its motors do not move (speed 0).
    const timed = [...this.slots.values()].some((sl) => sl.current?.action.kind === "timed");
    if (!timed && ![...this.motors.values()].some((m) => m.moving)) return;
    this.lastTick = this.clock.now();
    this.timer = this.clock.setTimeout(() => this.tick(), TICK_MS);
  }

  private tick(): void {
    this.timer = undefined;
    const now = this.clock.now();
    this.advance(now - this.lastTick);
    this.lastTick = now;
    this.settle();
    this.ensureTicking();
  }

  private advance(dt: number): void {
    if (dt <= 0) return;
    for (const slot of this.slots.values()) {
      const cur = slot.current;
      if (!cur) continue;
      // A timed command moves only for the time it has left: it ends exactly on time.
      const span = cur.action.kind === "timed" ? Math.min(dt, cur.remainingMs) : dt;
      for (const m of slot.motors) m.step(span);
      if (cur.action.kind === "timed") cur.remainingMs -= dt;
      this.finishIfDone(slot);
    }
  }

  /** Reports every motor whose visible state changed since the last report. */
  private settle(): void {
    for (const [port, motor] of this.motors) {
      const now = this.snapshot(motor);
      const before = this.shown.get(port);
      if (before && before.position === now.position && before.speed === now.speed) continue;
      this.shown.set(port, now);
      this.hooks.changed(port, now);
    }
  }

  private snapshot(motor: SimMotor): MotorState {
    return { position: motor.degrees, speed: motor.speed, running: motor.moving };
  }

  private error(code: number): void {
    this.hooks.send(encodeGenericError({ commandType: MessageType.PortOutputCommand, code }));
  }
}
