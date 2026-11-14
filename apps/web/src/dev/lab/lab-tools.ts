import type { MoveHub, TachoMotor } from "@mecahub/hub";
import { encodeHubProperty } from "@mecahub/lwp3";
import type { Lwp3Message } from "@mecahub/lwp3";
import {
  LabError,
  type FeedbackFrame,
  type FeedbackResult,
  type LabStop,
  type MotorSpeedResult,
  type MotorSpeedRun,
  type MultiMessageOutcome,
  type MultiMessageResult,
  type Stats,
  type StopOnLinkLossResult,
  type WriteLatencyResult,
} from "./lab-types.js";

/** A message the tool waits for; `cancel` stops waiting (the promise then resolves undefined). */
export interface MessageWait {
  readonly promise: Promise<{ readonly at: number } | undefined>;
  cancel(): void;
}

/** What a measurement tool may use of the controller. */
export interface ToolContext {
  readonly hub: MoveHub;
  /** Monotonic ms clock. */
  now(): number;
  /** Milliseconds on the capture clock (since the device was chosen). */
  captureMs(): number;
  sleep(ms: number): Promise<void>;
  /** Waits for the first message that matches: its arrival time, or undefined on timeout. */
  waitForMessage(match: (message: Lwp3Message) => boolean, timeoutMs: number): MessageWait;
  /** The motor on a port (A..D), if one is attached. */
  motor(port: number): TachoMotor | undefined;
  /** Position reports of a motor port, with their arrival time. */
  onPosition(port: number, listener: (position: number, at: number) => void): () => void;
  lastPosition(port: number): number | undefined;
  /** True once STOP was pressed after the tool started. */
  aborted(): boolean;
  note(text: string): void;
  /** Starts motor A. Resolves false when the command could not be sent (never rejects). */
  runA(speed: number): Promise<boolean>;
  /**
   * Resolves once no message matching `match` arrived for `quietMs` (stray or late replies drain),
   * or after `maxMs` in all.
   */
  waitQuiet(
    match: (message: Lwp3Message) => boolean,
    quietMs: number,
    maxMs: number,
  ): Promise<void>;
  /** Drops the link at the transport (no STOP first). */
  dropLink(): Promise<void>;
  reconnect(): Promise<void>;
  stop(): Promise<LabStop>;
  /** The simulated motor's state; undefined on a real hub. */
  simMotorRunning(port: number): boolean | undefined;
}

const round1 = (x: number): number => Math.round(x * 10) / 10;

/** Nearest-rank percentile of an ascending list. */
export const percentile = (sorted: readonly number[], p: number): number =>
  sorted[Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length))) - 1] ?? 0;

export function summarize(values: readonly number[]): Stats | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    min: round1(sorted[0] ?? 0),
    p50: round1(percentile(sorted, 50)),
    p95: round1(percentile(sorted, 95)),
    max: round1(sorted[sorted.length - 1] ?? 0),
  };
}

const errorStatus = (err: unknown): string => {
  const code = (err as { code?: unknown } | null)?.code;
  return `error: ${typeof code === "string" ? code : err instanceof Error ? err.message : String(err)}`;
};

const REPLY_TIMEOUT_MS = 2000;
/** No battery/name update for this long before a measurement: strays and late replies are gone. */
const QUIET_MS = 2000;
const QUIET_MAX_MS = 6000;
/** After a sample's reply timed out, wait this long so its late reply cannot match the next one. */
const DRAIN_MS = 1000;
const DRAIN_MAX_MS = 3000;

const request = (property: "batteryPercent" | "advertisingName"): Uint8Array =>
  encodeHubProperty({ type: "hubProperty", operation: "requestUpdate", property });

const isAnyUpdate = (m: Lwp3Message): boolean =>
  isUpdateOf("batteryPercent")(m) || isUpdateOf("advertisingName")(m);

const isUpdateOf =
  (property: "batteryPercent" | "advertisingName") =>
  (m: Lwp3Message): boolean =>
    m.type === "hubProperty" && m.operation === "update" && m.property === property;

/**
 * n harmless requests (hub property battery, Request Update), one after another, each waiting for
 * its Update. Per sample: the time the write promise took, and the time until the reply arrived,
 * both from the moment `write` was called (so write-queue time is included). Limits: the clock is
 * the page's (performance.now: sub-ms but coarsened by the browser), the reply time includes the
 * hub's own processing and the notification path, and it says nothing about write-with-response vs
 * without (the transport picks).
 */
export async function measureWriteLatency(
  ctx: ToolContext,
  n: number,
): Promise<WriteLatencyResult> {
  if (!Number.isInteger(n) || n < 1 || n > 500) throw new RangeError("n must be an integer 1..500");
  const writes: number[] = [];
  const rtts: number[] = [];
  let writeErrors = 0;
  let lostReplies = 0;
  let interrupted = false;
  // Stray updates (the hub's own battery reports) must not pass for the first reply.
  await ctx.waitQuiet(isAnyUpdate, QUIET_MS, QUIET_MAX_MS);
  for (let i = 0; i < n; i++) {
    if (ctx.aborted()) {
      interrupted = true;
      break;
    }
    const reply = ctx.waitForMessage(isUpdateOf("batteryPercent"), REPLY_TIMEOUT_MS);
    const t0 = ctx.now();
    try {
      await ctx.hub.session.send(request("batteryPercent"));
    } catch {
      writeErrors++;
      reply.cancel();
      continue;
    }
    writes.push(ctx.now() - t0);
    const answer = await reply.promise;
    if (answer) rtts.push(answer.at - t0);
    else if (ctx.aborted()) interrupted = true;
    else {
      lostReplies++;
      // The reply may only be late: let it arrive (and be dropped) before the next request.
      await ctx.waitQuiet(isAnyUpdate, DRAIN_MS, DRAIN_MAX_MS);
    }
  }
  return {
    requested: n,
    completed: writes.length,
    writeErrors,
    lostReplies,
    write: summarize(writes),
    rtt: summarize(rtts),
    interrupted,
  };
}

const SETTLE_BETWEEN_RUNS_MS = 300;

interface PositionSample {
  readonly position: number;
  readonly at: number;
}

/**
 * Degrees per second between the first position change and the last sample taken at or before
 * `endAt` (the end of the command), so the brake tail after it is not averaged in. Undefined without
 * two samples in the window.
 */
export function windowSpeed(
  samples: readonly PositionSample[],
  baseline: number,
  endAt: number,
): number | undefined {
  const inside = samples.filter((s) => s.at <= endAt);
  const first = inside.find((s) => s.position !== baseline);
  const last = inside[inside.length - 1];
  if (!first || !last || last.at <= first.at) return undefined;
  return (Math.abs(last.position - first.position) / (last.at - first.at)) * 1000;
}

/**
 * Runs the motor for `ms` at `speedPct` (and again at 50 %) and works out degrees per second from
 * the position reports. `degPerSec` goes from the first reported position change to the last
 * report taken while the command still ran (start-up delay and brake tail left out); it is a LOWER
 * BOUND: reports only come when the position changes and the window starts after the motor
 * began to turn. `degPerSecWall` is the whole command, from the call to its feedback. A motor
 * under load (wheels on the floor) is slower than the no-load figure the simulator TODO wants, and
 * "max" assumes speed is linear in the percentage. The caller must have checked the safety
 * confirmation (the motor spins). STOP between runs ends the tool: no motor command follows it.
 */
export async function measureMotorSpeed(
  ctx: ToolContext,
  port: number,
  speedPct: number,
  ms: number,
): Promise<MotorSpeedResult> {
  const motor = ctx.motor(port);
  if (!motor) throw new RangeError(`no motor on port ${port}`);
  const speeds = [...new Set([speedPct, 50])];
  const runs: MotorSpeedRun[] = [];
  let interrupted = false;
  for (const speed of speeds) {
    if (ctx.aborted()) {
      interrupted = true;
      break;
    }
    const samples: PositionSample[] = [];
    const off = ctx.onPosition(port, (position, at) => samples.push({ position, at }));
    const before = ctx.lastPosition(port);
    const startedAt = ctx.now();
    let status: string;
    try {
      // Right before the command, the last chance to honour a STOP.
      if (ctx.aborted()) {
        interrupted = true;
        break;
      }
      status = await motor.runFor(ms, speed);
    } catch (err) {
      status = errorStatus(err);
    } finally {
      off();
    }
    const endedAt = ctx.now();
    const baseline = before ?? samples[0]?.position ?? 0;
    const last = samples[samples.length - 1];
    const degrees = last ? Math.abs(last.position - baseline) : 0;
    const window = windowSpeed(samples, baseline, startedAt + ms);
    runs.push({
      speedPct: speed,
      ms,
      status,
      degrees,
      samples: samples.length,
      degPerSec: window === undefined ? undefined : round1(window),
      degPerSecWall: round1((degrees / Math.max(1, endedAt - startedAt)) * 1000),
      estimatedMaxDegPerSec:
        window === undefined || speed === 0 ? undefined : round1((window * 100) / Math.abs(speed)),
    });
    if (ctx.aborted()) {
      interrupted = true;
      break;
    }
    await ctx.sleep(SETTLE_BETWEEN_RUNS_MS);
  }
  return { port, runs, interrupted };
}

const MULTI_WAIT_MS = 1000;

/** Sends one request alone and says whether its reply arrived within `MULTI_WAIT_MS`. */
async function askAlone(
  ctx: ToolContext,
  property: "batteryPercent" | "advertisingName",
): Promise<boolean> {
  const reply = ctx.waitForMessage(isUpdateOf(property), MULTI_WAIT_MS);
  try {
    await ctx.hub.session.send(request(property));
  } catch {
    reply.cancel();
    return false;
  }
  return (await reply.promise) !== undefined;
}

/**
 * One GATT write holding two complete frames (Request Update of battery, then of the advertising
 * name), then waits 1 s for the replies. "both" means the hub handled the whole write; "first-only"
 * that it stopped after one message. Before it, each message is sent ALONE (`control`) so a
 * message the hub never answers is not mistaken for a concatenation failure, and a quiet period
 * lets stray updates go by. Limit: a hub that answers late (over 1 s) looks like "none".
 */
export async function testMultiMessageWrite(ctx: ToolContext): Promise<MultiMessageResult> {
  await ctx.waitQuiet(isAnyUpdate, QUIET_MS, QUIET_MAX_MS);
  const control = {
    battery: await askAlone(ctx, "batteryPercent"),
    advertisingName: await askAlone(ctx, "advertisingName"),
  };
  await ctx.waitQuiet(isAnyUpdate, DRAIN_MS, DRAIN_MAX_MS);
  const first = request("batteryPercent");
  const second = request("advertisingName");
  const both = new Uint8Array(first.length + second.length);
  both.set(first, 0);
  both.set(second, first.length);
  const battery = ctx.waitForMessage(isUpdateOf("batteryPercent"), MULTI_WAIT_MS);
  const name = ctx.waitForMessage(isUpdateOf("advertisingName"), MULTI_WAIT_MS);
  const t0 = ctx.now();
  let writeError: string | undefined;
  try {
    await ctx.hub.session.send(both);
  } catch (err) {
    writeError = err instanceof Error ? err.message : String(err);
    battery.cancel();
    name.cancel();
  }
  const [gotBattery, gotName] = await Promise.all([battery.promise, name.promise]);
  const outcome: MultiMessageOutcome =
    gotBattery && gotName ? "both" : gotBattery ? "first-only" : gotName ? "second-only" : "none";
  return {
    outcome,
    battery: gotBattery !== undefined,
    advertisingName: gotName !== undefined,
    waitedMs: Math.round(ctx.now() - t0),
    writeError,
    control,
  };
}

const LINK_LOSS_SPEED = 30;
const SPIN_UP_MS = 500;

/**
 * Part 1 of the link-loss test: motor A runs at 30 % for half a second, then the link is dropped
 * with the transport's own disconnect (a clean GATT disconnect, NOT a hub that went out of range:
 * the hub may treat the two differently). The caller must have checked the safety confirmation.
 * Returns while the link is down and the operator is watching the motor. If anything goes wrong
 * before the drop (the motor does not start, STOP was pressed, the drop itself fails) the motor is
 * STOPped before the error leaves; a failed start fails the test (LabError "command-failed").
 */
export async function startStopOnLinkLoss(ctx: ToolContext): Promise<StopOnLinkLossResult> {
  const base = {
    port: 0,
    speedPct: LINK_LOSS_SPEED,
    droppedAtMs: undefined,
    observation: undefined,
    answeredAfterMs: undefined,
    derived: undefined,
    reconnected: undefined,
    stopAfterReconnect: undefined,
  } as const;
  try {
    if (!(await ctx.runA(LINK_LOSS_SPEED))) {
      throw new LabError("command-failed", "motor A did not start");
    }
    await ctx.sleep(SPIN_UP_MS);
    // STOP pressed meanwhile: it already halted the motor, so keep the link.
    if (ctx.aborted()) {
      await ctx.stop();
      return { ...base, phase: "aborted" };
    }
    ctx.note("lab drops the link now (motor A at 30 %)");
    const droppedAtMs = ctx.captureMs();
    await ctx.dropLink();
    return { ...base, phase: "awaiting-observation", droppedAtMs };
  } catch (err) {
    await ctx.stop();
    throw err;
  }
}

/**
 * Part 2: records what the operator saw, reconnects and, whatever the answer, sends STOP (the motor
 * may still be turning). Without an answer the simulated motor's state stands in.
 */
export async function finishStopOnLinkLoss(
  ctx: ToolContext,
  pending: StopOnLinkLossResult,
  observation: "stopped" | "kept-running" | undefined,
): Promise<StopOnLinkLossResult> {
  const derived = observation === undefined;
  const answer = observation ?? (ctx.simMotorRunning(pending.port) ? "kept-running" : "stopped");
  const answeredAfterMs = ctx.captureMs() - (pending.droppedAtMs ?? 0);
  ctx.note(`operator: motor ${answer}${derived ? " (derived from the simulator)" : ""}`);
  let reconnected = false;
  try {
    await ctx.reconnect();
    reconnected = true;
  } catch {
    ctx.note("reconnect failed: the motor may still be running, switch the hub off");
  }
  let stopAfterReconnect: StopOnLinkLossResult["stopAfterReconnect"];
  if (reconnected) {
    const stop = await ctx.stop();
    stopAfterReconnect =
      stop.status === "done" ? { ok: stop.ok, ms: stop.ms } : { ok: false, ms: 0 };
  }
  return {
    ...pending,
    phase: "done",
    observation: answer,
    answeredAfterMs,
    derived,
    reconnected,
    stopAfterReconnect,
  };
}

const FEEDBACK_DEGREES = 90;
const FEEDBACK_SPEED = 50;
const FEEDBACK_TIMEOUT_MS = 5000;
const FEEDBACK_TAIL_MS = 300;

/**
 * Rotates a motor 90 degrees with completion feedback and records every Port Output Command
 * Feedback (0x82) the hub sends for the port, for the "does it send 0x0A" TODO. The tail wait lets
 * a late idle report arrive. Limit: only the flags byte of the port is kept here (the frames
 * themselves are in the capture); a hub that sends nothing leaves `frames` empty and the status
 * "error: timeout" after 5 s.
 */
export async function captureFeedback(ctx: ToolContext, port: number): Promise<FeedbackResult> {
  const motor = ctx.motor(port);
  if (!motor) throw new RangeError(`no motor on port ${port}`);
  const frames: FeedbackFrame[] = [];
  const off = ctx.hub.session.onEvent((event) => {
    if (event.kind !== "message" || event.message.type !== "portOutputFeedback") return;
    for (const p of event.message.ports) {
      if (p.port === port) frames.push({ at: ctx.captureMs(), flags: p.flags });
    }
  });
  let status: string;
  try {
    status = await motor.rotate(FEEDBACK_DEGREES, FEEDBACK_SPEED, {
      timeoutMs: FEEDBACK_TIMEOUT_MS,
    });
  } catch (err) {
    status = errorStatus(err);
  }
  await ctx.sleep(FEEDBACK_TAIL_MS);
  off();
  return {
    port,
    degrees: FEEDBACK_DEGREES,
    speedPct: FEEDBACK_SPEED,
    status,
    frames,
    sawCompletedIdle: frames.some((f) => f.flags === 0x0a),
  };
}
