import { EndState, IoTypeId, decodeModeValue } from "@mecahub/lwp3";
import type { PortOutputCommand } from "@mecahub/lwp3";
import { HubError } from "./errors.js";
import type { HubSession, OutputStatus } from "./session.js";

export interface SubscribeOptions {
  /**
   * Minimum change that makes the hub report again (delta interval, doc 3.17). Default 1: every
   * change. Only the first listener of a mode sets it; later ones share the subscription.
   */
  readonly deltaInterval?: number;
}

// Input modes of the tacho motors (see lwp3 io-modes.ts for sources): 1 = speed (i8, percent),
// 2 = position (i32, degrees). derivado del layout, TODO(hw).
const MODE_SPEED = 1;
const MODE_POSITION = 2;

/** Extra wait after a timed command's own duration before its feedback is declared missing. */
const TIMED_FEEDBACK_MARGIN_MS = 2000;

// supuesto: no acceleration/deceleration profile (the simulator ignores it and nothing documents the
// Move Hub's reaction). TODO(hw): `useProfile` on a real motor.
const NO_PROFILE = { acc: false, dec: false } as const;
const MAX_POWER = 100;

interface Subscription {
  readonly mode: number;
  readonly listeners: Set<(value: number) => void>;
  /** Settles when the hub confirmed the setup. */
  ready: Promise<void> | undefined;
}

/**
 * A motor with a tachometer on one port (A, B, or an external motor on C/D). Speeds are percent
 * (-100..100). Every command is sent "immediate": it replaces whatever the port was doing, and the
 * replaced command's promise resolves "discarded". Bad arguments reject with RangeError before
 * anything is sent.
 *
 * A port reports one input mode at a time, so `onPosition` and `onSpeed` cannot be active together:
 * the second kind rejects "mode-conflict" until the first one's listeners are all gone. This is the
 * contract. TODO: a combined mode (Port Input Format Setup Combined, 0x42) could serve both later.
 */
export class TachoMotor {
  private subscription: Subscription | undefined;
  private offEvents: (() => void) | undefined;

  constructor(
    private readonly session: HubSession,
    readonly port: number,
    /** Device type of the port, which selects the value layouts (`IoTypeId`). */
    private readonly ioType: number = IoTypeId.InternalMotorWithTacho,
  ) {}

  /** Runs until another command replaces it. Resolves once the command is written. */
  async run(speed: number): Promise<void> {
    await this.send({ sub: "startSpeed", speed, maxPower: MAX_POWER, useProfile: NO_PROFILE });
  }

  /** Runs for `ms` (1..32767) at `speed`, then brakes. Resolves when the hub reports it finished. */
  runFor(ms: number, speed: number): Promise<OutputStatus> {
    return this.feedbackCommand(
      {
        sub: "startSpeedForTime",
        time: ms,
        speed,
        maxPower: MAX_POWER,
        endState: EndState.Brake,
        useProfile: NO_PROFILE,
      },
      ms + TIMED_FEEDBACK_MARGIN_MS,
    );
  }

  /**
   * Turns `degrees` (a nonzero integer; negative turns the other way) at |speed| percent, then
   * brakes. `timeoutMs` bounds the wait for completion (default: the session's feedback timeout).
   */
  rotate(
    degrees: number,
    speed: number,
    options: { timeoutMs?: number } = {},
  ): Promise<OutputStatus> {
    if (!Number.isInteger(degrees) || degrees === 0) {
      return Promise.reject(new RangeError(`degrees must be a nonzero integer: ${degrees}`));
    }
    if (speed === 0) return Promise.reject(new RangeError("rotate needs a nonzero speed"));
    return this.feedbackCommand(
      {
        sub: "startSpeedForDegrees",
        degrees: Math.abs(degrees),
        speed: degrees < 0 ? -speed : speed,
        maxPower: MAX_POWER,
        endState: EndState.Brake,
        useProfile: NO_PROFILE,
      },
      options.timeoutMs,
    );
  }

  /** Moves to an absolute position (degrees, Int32) at `speed` (1..100), then brakes. */
  goto(
    position: number,
    speed: number,
    options: { timeoutMs?: number } = {},
  ): Promise<OutputStatus> {
    return this.feedbackCommand(
      {
        sub: "gotoAbsolutePosition",
        absPos: position,
        speed,
        maxPower: MAX_POWER,
        endState: EndState.Brake,
        useProfile: NO_PROFILE,
      },
      options.timeoutMs,
    );
  }

  /** StartPower 127: actively holds the shaft. Resolves once written. */
  async brake(): Promise<void> {
    await this.send({ sub: "startPower", power: 127 });
  }

  /** StartPower 0: lets the shaft turn freely. Resolves once written. */
  async float(): Promise<void> {
    await this.send({ sub: "startPower", power: 0 });
  }

  /** Position in degrees. Resolves with the unsubscribe function once the hub confirmed the setup. */
  onPosition(
    listener: (degrees: number) => void,
    options: SubscribeOptions = {},
  ): Promise<() => void> {
    return this.subscribe(MODE_POSITION, listener, options);
  }

  /** Speed in percent (-100..100). Same contract as `onPosition`. */
  onSpeed(
    listener: (percent: number) => void,
    options: SubscribeOptions = {},
  ): Promise<() => void> {
    return this.subscribe(MODE_SPEED, listener, options);
  }

  /**
   * Drops the subscription. While the link is up the hub is also told to stop reporting this port
   * (`notifyHub: false` skips that, e.g. for a motor that was unplugged); after a link loss the hub
   * forgot it already.
   */
  dispose(options: { notifyHub?: boolean } = {}): void {
    const sub = this.subscription;
    this.forget();
    if (sub && options.notifyHub !== false && this.session.linked) {
      this.session.setInputFormat(this.port, sub.mode, 1, false).catch(() => undefined);
    }
  }

  private async send(command: PortOutputCommand): Promise<void> {
    await this.session.portOutput({
      port: this.port,
      startup: "immediate",
      completion: "none",
      command,
    });
  }

  private feedbackCommand(command: PortOutputCommand, timeoutMs?: number): Promise<OutputStatus> {
    return this.session.portOutput(
      { port: this.port, startup: "immediate", completion: "feedback", command },
      timeoutMs === undefined ? {} : { timeoutMs },
    );
  }

  private async subscribe(
    mode: number,
    listener: (value: number) => void,
    options: SubscribeOptions,
  ): Promise<() => void> {
    let sub = this.subscription;
    if (sub && sub.mode !== mode) {
      throw new HubError(
        "mode-conflict",
        `port 0x${this.port.toString(16)} is already reporting mode ${sub.mode}`,
      );
    }
    if (!sub) {
      const created: Subscription = { mode, listeners: new Set([listener]), ready: undefined };
      sub = created;
      // Subscribe before asking: the hub may report the current value right behind its reply.
      this.subscription = created;
      this.listen();
      created.ready = this.session
        .setInputFormat(this.port, mode, options.deltaInterval ?? 1, true)
        .then(() => undefined);
      created.ready.catch(() => {
        if (this.subscription === created) this.forget();
      });
    } else {
      sub.listeners.add(listener);
    }
    const current = sub;
    try {
      await current.ready;
    } catch (err) {
      current.listeners.delete(listener);
      throw err;
    }
    return () => this.unsubscribe(current, listener);
  }

  private unsubscribe(sub: Subscription, listener: (value: number) => void): void {
    if (!sub.listeners.delete(listener) || sub.listeners.size > 0) return;
    if (this.subscription !== sub) return;
    this.forget();
    // Best effort: notifications off. A failure only means values keep flowing to nobody.
    this.session.setInputFormat(this.port, sub.mode, 1, false).catch(() => undefined);
  }

  private listen(): void {
    if (this.offEvents) return;
    this.offEvents = this.session.onEvent((event) => {
      if (event.kind === "link-lost") {
        this.forget(); // the hub forgot the subscription with the link
        return;
      }
      if (event.kind !== "message" || event.message.type !== "portValue") return;
      if (event.message.port !== this.port) return;
      const sub = this.subscription;
      if (!sub) return;
      // A value still in flight from the previous mode has the wrong length: undefined, dropped.
      const value = decodeModeValue(this.ioType, sub.mode, event.message.raw)?.[0];
      if (value === undefined) return;
      for (const l of [...sub.listeners]) {
        try {
          l(value);
        } catch (err) {
          queueMicrotask(() => {
            throw err;
          });
        }
      }
    });
  }

  private forget(): void {
    this.subscription = undefined;
    this.offEvents?.();
    this.offEvents = undefined;
  }
}
