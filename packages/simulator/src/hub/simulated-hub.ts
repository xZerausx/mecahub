import {
  ErrorCode,
  MessageType,
  decode,
  encodeGenericError,
  encodeHubAttachedIo,
  encodeHubProperty,
  encodePortInputFormat,
  encodePortOutputFeedback,
  IoTypeId,
  encodePortValueSingle,
  getIoMode,
  isColorId,
  type HubPropertyName,
  type Lwp3Message,
} from "@mecahub/lwp3";
import { realClock, type SimClock, type SimTimerHandle } from "./clock.js";
import { defaultMoveHubConfig, type SimHubConfig, type SimValueFormat } from "./config.js";
import { MotorBank, type MotorState } from "./motors.js";
import { defaultModeValue, encodeModeValue, formatOfMode } from "./sensor-modes.js";

export type { MotorState } from "./motors.js";

export type LedState =
  | { readonly kind: "index"; readonly color: number }
  | { readonly kind: "rgb"; readonly r: number; readonly g: number; readonly b: number };

export interface SimulatedHubOptions {
  /** Defaults to the real clock. */
  readonly clock?: SimClock;
  /** Delay before every hub-to-app frame. Default 0: frames are emitted synchronously. */
  readonly latencyMs?: number;
}

/** Highest port number of the external connectors; virtual ports are announced right after them. */
const LAST_EXTERNAL_PORT = 0x03;

/** Hub properties whose current value the simulated hub can report. */
const SUPPORTED = [
  "advertisingName",
  "batteryPercent",
  "button",
] as const satisfies HubPropertyName[];
type SupportedProperty = (typeof SUPPORTED)[number];
const isSupported = (p: HubPropertyName): p is SupportedProperty =>
  (SUPPORTED as readonly string[]).includes(p);

interface InputSubscription {
  readonly mode: number;
  readonly deltaInterval: number;
  readonly notify: boolean;
  /** Last value sent to the app (the delta is measured against it). */
  reported: Uint8Array | undefined;
}

/** Splits a raw value into little-endian components (signed or not, as the format says). */
function components(raw: Uint8Array, format: SimValueFormat | undefined): number[] {
  const width = format?.width ?? 1;
  const signed = format?.signed ?? false;
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const out: number[] = [];
  for (let at = 0; at + width <= raw.length; at += width) {
    if (width === 1) out.push(signed ? view.getInt8(at) : view.getUint8(at));
    else if (width === 2) out.push(signed ? view.getInt16(at, true) : view.getUint16(at, true));
    else out.push(signed ? view.getInt32(at, true) : view.getUint32(at, true));
  }
  return out;
}

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** Message type of the command an upstream-only or unmodelled message came in as. */
function commandTypeOf(msg: Lwp3Message): number {
  switch (msg.type) {
    case "unknown":
      return msg.messageType;
    case "hubProperty":
      return MessageType.HubProperties;
    case "hubAttachedIo":
      return MessageType.HubAttachedIo;
    case "portInputFormatSetup":
      return MessageType.PortInputFormatSetupSingle;
    case "portInputFormat":
      return MessageType.PortInputFormatSingle;
    case "portValue":
      return MessageType.PortValueSingle;
    case "portOutputCommand":
      return MessageType.PortOutputCommand;
    case "portOutputFeedback":
      return MessageType.PortOutputCommandFeedback;
    case "genericError":
      return MessageType.GenericError;
  }
}

/**
 * A Move Hub that speaks LWP3, without Bluetooth and without DOM: `receive` takes app-to-hub
 * messages (one frame each), `onSend` delivers hub-to-app messages (one frame each, like the
 * one-message-per-notification the real hub showed). Pure TypeScript: runs in Node and browser.
 *
 * Each behaviour is labelled where it is decided: 'capturado' (seen on the real hub, see
 * `defaultMoveHubConfig`), 'derivado del layout' or 'supuesto' (our guess, TODO(hw)).
 *
 * Malformed frames (decode errors) are ignored silently and never throw. supuesto: the real hub's
 * reaction is unknown, and a generic error needs a trustworthy command type, which a broken
 * frame does not guarantee. TODO(hw)
 */
export class SimulatedHub {
  private readonly clock: SimClock;
  private readonly latencyMs: number;
  private readonly config: SimHubConfig;
  private readonly listeners = new Set<(frame: Uint8Array) => void>();
  private readonly timers = new Set<SimTimerHandle>();
  private readonly subscribed = new Set<SupportedProperty>();
  private readonly inputs = new Map<number, InputSubscription>();
  /** Raw value per port (`setSensor`): answers every mode without a per-mode value. */
  private readonly values = new Map<number, Uint8Array>();
  /** Per-mode values (`setSensorMode`), encoded with the lwp3 mode table. */
  private readonly modeValues = new Map<number, Map<number, Uint8Array>>();
  private readonly ioTypes = new Map<number, number>();
  private readonly knownPorts = new Set<number>();
  private readonly formats = new Map<number, SimValueFormat>();
  private readonly ledListeners = new Set<(led: LedState) => void>();
  private ledColor: LedState | undefined;
  private readonly motorListeners = new Set<(port: number, state: MotorState) => void>();
  private readonly bank: MotorBank;
  private advertisingName: string;
  private battery: number;
  private button: boolean;
  private link = false;
  /** The pending reaction to a link loss (`linkLossDetectionMs`). */
  private lossTimer: SimTimerHandle | undefined;

  constructor(config: SimHubConfig = defaultMoveHubConfig(), options: SimulatedHubOptions = {}) {
    this.config = config;
    this.clock = options.clock ?? realClock;
    this.latencyMs = options.latencyMs ?? 0;
    this.advertisingName = config.name;
    this.battery = config.batteryPercent;
    this.button = config.buttonPressed;
    this.bank = new MotorBank(config, this.clock, {
      send: (frame) => this.emit(frame),
      changed: (port, state) => this.onMotorChanged(port, state),
    });
    for (const p of [...config.ports, ...config.virtualPorts]) {
      this.knownPorts.add(p.port);
      this.ioTypes.set(p.port, p.ioType);
      if (p.valueFormat) this.formats.set(p.port, p.valueFormat);
    }
  }

  /** The advertising name (what `requestDevice` shows). */
  get name(): string {
    return this.advertisingName;
  }

  /** Fault injection: delivers `bytes` to the app as they are (may hold several messages, or garbage). */
  injectRaw(bytes: Uint8Array): void {
    this.emit(bytes);
  }

  get connected(): boolean {
    return this.link;
  }

  /** Subscribes to hub-to-app frames. Returns the unsubscribe function. */
  onSend(listener: (frame: Uint8Array) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /**
   * The app connected: announces what is attached. capturado: order 0x00, 0x01, 0x03, virtual
   * 0x10, then the internal devices 0x32, 0x3A, 0x3B, 0x3C, 0x46 (externals, virtual, internals).
   */
  connect(): void {
    if (this.link) return;
    this.link = true;
    // supuesto: a new link before the old loss was noticed: the hub never reacts to the old one
    this.cancelLossWait();
    const { ports, virtualPorts } = this.config;
    const external = ports.filter((p) => p.port <= LAST_EXTERNAL_PORT);
    const internal = ports.filter((p) => p.port > LAST_EXTERNAL_PORT);
    const attach = (p: (typeof ports)[number]) =>
      this.emit(
        encodeHubAttachedIo({
          type: "hubAttachedIo",
          event: "attached",
          port: p.port,
          ioType: p.ioType,
          hardwareVersion: p.hw,
          softwareVersion: p.sw,
        }),
      );
    external.forEach(attach);
    for (const p of virtualPorts) {
      this.emit(encodeHubAttachedIo({ type: "hubAttachedIo", event: "attachedVirtual", ...p }));
    }
    internal.forEach(attach);
  }

  /** The link is gone: frames in flight are lost and the app's subscriptions end. */
  disconnect(): void {
    // Nothing to lose when there is no link: a second call must not re-arm the loss reaction.
    if (!this.link) return;
    this.link = false;
    // supuesto: TODO(hw) does the real hub stop its motors when the link drops?
    if (this.config.stopMotorsOnLinkLoss ?? true) {
      const wait = this.config.linkLossDetectionMs ?? 0;
      if (wait > 0) {
        this.cancelLossWait();
        this.lossTimer = this.clock.setTimeout(() => this.onLinkLossDetected(), wait);
      } else this.bank.stopAll();
    }
    for (const t of this.timers) this.clock.clearTimeout(t);
    this.timers.clear();
    this.subscribed.clear();
    this.inputs.clear();
  }

  private onLinkLossDetected(): void {
    this.lossTimer = undefined;
    this.bank.stopAll();
  }

  private cancelLossWait(): void {
    if (this.lossTimer !== undefined) this.clock.clearTimeout(this.lossTimer);
    this.lossTimer = undefined;
  }

  /** App to hub: one LWP3 message. Ignored while not connected. Never throws. */
  receive(frame: Uint8Array): void {
    if (!this.link) return;
    const msg = decode(frame);
    if ("kind" in msg) return;
    switch (msg.type) {
      case "hubProperty":
        this.onHubProperty(msg);
        return;
      case "portInputFormatSetup":
        this.onInputSetup(msg);
        return;
      case "portOutputCommand":
        if (this.ioTypes.get(msg.port) === IoTypeId.RgbLight) this.onLedCommand(msg);
        else this.bank.command(msg);
        return;
      default:
        // supuesto: TODO(hw) answer 0x05 'command not recognized' (doc 3.9).
        this.error(commandTypeOf(msg), ErrorCode.CommandNotRecognized);
    }
  }

  /** The color the LED shows, or undefined until an app set one. */
  get led(): LedState | undefined {
    return this.ledColor;
  }

  /** Fires when the app sets the LED. Returns the unsubscribe function. */
  onLedChange(listener: (led: LedState) => void): () => void {
    this.ledListeners.add(listener);
    return () => void this.ledListeners.delete(listener);
  }

  /** What a motor port is doing now. Throws RangeError for a port that is not a physical motor. */
  motorState(port: number): MotorState {
    return this.bank.state(port);
  }

  /**
   * Subscribes to motor changes (position or speed): `port` is the physical motor port. Fires also
   * while the link is down (the motors may keep running). Returns the unsubscribe function.
   */
  onMotorChange(listener: (port: number, state: MotorState) => void): () => void {
    this.motorListeners.add(listener);
    return () => void this.motorListeners.delete(listener);
  }

  /**
   * Ends the simulation: the link is gone for good (no frames, no replies), every pending timer
   * (latency, motor tick) is cleared and the motors freeze. Call it when done with the hub. Only
   * matters with a real clock or `stopMotorsOnLinkLoss: false`, where motors keep ticking after a
   * link loss until they stop. A disposed hub is not meant to be used again.
   */
  dispose(): void {
    this.link = false;
    for (const t of this.timers) this.clock.clearTimeout(t);
    this.timers.clear();
    this.subscribed.clear();
    this.inputs.clear();
    this.motorListeners.clear();
    this.ledListeners.clear();
    this.cancelLossWait();
    this.bank.dispose();
  }

  setBattery(percent: number): void {
    if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
      throw new RangeError("battery must be an integer 0..100");
    }
    if (percent === this.battery) return;
    this.battery = percent;
    this.pushUpdate("batteryPercent");
  }

  setButton(pressed: boolean): void {
    if (pressed === this.button) return;
    this.button = pressed;
    this.pushUpdate("button");
  }

  /**
   * Sets what a sensor reports in `mode`, as components (e.g. tilt mode 0 = [x, y] degrees). The
   * layout (count, width, signed) comes from the lwp3 mode table for the io type configured on the
   * port; RangeError for an unknown port, a motor, an io type or mode the table does not know, an
   * output-only mode, or components the layout cannot carry. When the app is subscribed to this
   * (port, mode) with notifications on, a change is sent as 0x45 if any component moved by at least
   * the delta interval against the last reported value; the first value always is.
   */
  setSensorMode(port: number, mode: number, values: readonly number[]): void {
    const info = this.sensorModeInfo(port, mode);
    const bytes = encodeModeValue(info, values);
    let perMode = this.modeValues.get(port);
    if (!perMode) this.modeValues.set(port, (perMode = new Map()));
    perMode.set(mode, bytes);
    this.pushIfSubscribed(port, mode, bytes);
  }

  private sensorModeInfo(port: number, mode: number) {
    if (!this.knownPorts.has(port)) throw new RangeError(`unknown port 0x${port.toString(16)}`);
    if (this.bank.isMotorPort(port)) {
      throw new RangeError(`port 0x${port.toString(16)} is a motor: it reports its own value`);
    }
    const info = getIoMode(this.ioTypes.get(port) ?? -1, mode);
    if (!info) {
      throw new RangeError(`port 0x${port.toString(16)} has no mode ${mode} in the mode table`);
    }
    if (info.access === "output") {
      throw new RangeError(`mode ${mode} (${info.name}) is output-only: the hub never reports it`);
    }
    return info;
  }

  private pushIfSubscribed(port: number, mode: number, bytes: Uint8Array): void {
    const sub = this.inputs.get(port);
    if (!this.link || !sub?.notify || sub.mode !== mode) return;
    this.reportIfChanged(port, sub, bytes);
  }

  /**
   * The value a sensor port reports in `mode`: what `setSensorMode` set, else the raw bytes of
   * `setSensor` (any mode), else the rest default of the mode table. Precedence in that order.
   * Undefined for a mode with none of them: the hub acknowledges the setup and reports nothing.
   * supuesto: TODO(hw) what a real hub does for a mode its device does not have.
   */
  private sensorValue(port: number, mode: number): Uint8Array | undefined {
    return (
      this.modeValues.get(port)?.get(mode) ??
      this.values.get(port) ??
      defaultModeValue(this.ioTypes.get(port) ?? -1, mode)
    );
  }

  /**
   * Sets the raw value a port reports in EVERY mode that has no `setSensorMode` value (those win).
   * Kept for ports the mode table does not cover and for byte-level tests; prefer `setSensorMode`.
   * With notifications enabled on the port, a change is sent as 0x45 when any component moved by
   * at least the delta interval against the last reported value; the first value always is.
   * Components come from the port's `valueFormat` (the value must then be exactly `count * width`
   * bytes), else from the mode table, else every byte is an unsigned component. supuesto: TODO(hw)
   */
  setSensor(port: number, raw: Uint8Array): void {
    if (!this.knownPorts.has(port)) throw new RangeError(`unknown port 0x${port.toString(16)}`);
    if (raw.length < 1) throw new RangeError("a sensor value needs at least one byte");
    if (this.bank.isMotorPort(port)) {
      throw new RangeError(`port 0x${port.toString(16)} is a motor: it reports its own value`);
    }
    const format = this.formats.get(port);
    if (format && raw.length !== format.count * format.width) {
      throw new RangeError(
        `port 0x${port.toString(16)} values are ${format.count * format.width} bytes`,
      );
    }
    this.values.set(port, raw.slice());
    const sub = this.inputs.get(port);
    if (!sub || this.modeValues.get(port)?.has(sub.mode)) return; // shadowed by a per-mode value
    const value = this.sensorValue(port, sub.mode);
    if (value) this.pushIfSubscribed(port, sub.mode, value);
  }

  private reportIfChanged(port: number, sub: InputSubscription, value: Uint8Array): void {
    const last = sub.reported;
    if (last && !this.changedEnough(this.formatOf(port, sub.mode), last, value, sub.deltaInterval))
      return;
    sub.reported = value;
    this.emit(encodePortValueSingle(port, value));
  }

  /** Value layout of a port in a mode: motors have their own, the rest comes from the config. */
  private formatOf(port: number, mode: number): SimValueFormat | undefined {
    if (this.bank.isMotorPort(port)) {
      if (mode === 1) return { count: 1, width: 1, signed: true };
      if (mode === 2) return { count: 1, width: 4, signed: true };
      return undefined;
    }
    const info = getIoMode(this.ioTypes.get(port) ?? -1, mode);
    return this.formats.get(port) ?? (info ? formatOfMode(info) : undefined);
  }

  private changedEnough(
    format: SimValueFormat | undefined,
    last: Uint8Array,
    now: Uint8Array,
    delta: number,
  ): boolean {
    if (sameBytes(last, now)) return false;
    const a = components(last, format);
    const b = components(now, format);
    if (a.length !== b.length) return true;
    return a.some((x, i) => Math.abs(x - (b[i] as number)) >= Math.max(delta, 1));
  }

  private onHubProperty(msg: Extract<Lwp3Message, { type: "hubProperty" }>): void {
    const { operation, property } = msg;
    if (operation === "update" || operation === "set" || operation === "reset") {
      // Upstream-only or unsupported operations. supuesto: TODO(hw)
      this.error(MessageType.HubProperties, ErrorCode.CommandNotRecognized);
      return;
    }
    if (property === "firmwareVersion" || property === "hardwareVersion") {
      // supuesto: TODO(hw) the capture never asked for versions
      const value = this.config[property];
      if (operation === "requestUpdate" && value) {
        this.emit(encodeHubProperty({ type: "hubProperty", operation: "update", property, value }));
        return;
      }
    } else if (isSupported(property)) {
      if (operation === "disableUpdates") {
        this.subscribed.delete(property);
        return;
      }
      if (operation === "enableUpdates") {
        this.subscribed.add(property);
        // supuesto: enableUpdates answers right away. The capture is inconclusive (its three
        // requests got battery, name, battery back in order). TODO(hw)
      }
      this.sendProperty(property);
      return;
    }
    // supuesto: TODO(hw) a property the hub does not model (or no configured version) gets
    // CommandNotRecognized; a real hub may answer InvalidUse or stay silent instead.
    this.error(MessageType.HubProperties, ErrorCode.CommandNotRecognized);
  }

  private sendProperty(property: SupportedProperty): void {
    switch (property) {
      case "advertisingName":
        this.emit(
          encodeHubProperty({
            type: "hubProperty",
            operation: "update",
            property,
            value: this.name,
          }),
        );
        return;
      case "batteryPercent":
        this.emit(
          encodeHubProperty({
            type: "hubProperty",
            operation: "update",
            property,
            value: this.battery,
          }),
        );
        return;
      case "button":
        this.emit(
          encodeHubProperty({
            type: "hubProperty",
            operation: "update",
            property,
            value: this.button,
          }),
        );
        return;
    }
  }

  private pushUpdate(property: SupportedProperty): void {
    if (this.link && this.subscribed.has(property)) this.sendProperty(property);
  }

  private onInputSetup(msg: Extract<Lwp3Message, { type: "portInputFormatSetup" }>): void {
    if (!this.knownPorts.has(msg.port)) {
      // supuesto: TODO(hw)
      this.error(MessageType.PortInputFormatSetupSingle, ErrorCode.InvalidUse);
      return;
    }
    // supuesto: any mode is accepted on a known port, even one the device does not have.
    // TODO(hw) check what a real hub answers to an unsupported mode
    const { port, mode, deltaInterval, notify } = msg;
    const sub: InputSubscription = { mode, deltaInterval, notify, reported: undefined };
    this.inputs.set(port, sub);
    // supuesto: the 0x47 reply echoes the setup; the capture has no 0x41. TODO(hw)
    this.emit(
      encodePortInputFormat({ type: "portInputFormat", port, mode, deltaInterval, notify }),
    );
    // supuesto: with notifications on, the current value follows the reply. TODO(hw) confirm that
    // a real hub reports the current value after a setup
    const current = this.bank.isMotorPort(port)
      ? this.bank.value(port, mode)
      : this.sensorValue(port, mode);
    if (notify && current) this.reportIfChanged(port, sub, current);
  }

  private onMotorChanged(port: number, state: MotorState): void {
    for (const listener of [...this.motorListeners]) {
      try {
        listener(port, state);
      } catch (err) {
        queueMicrotask(() => {
          throw err;
        });
      }
    }
    const sub = this.inputs.get(port);
    if (!this.link || !sub?.notify) return;
    const value = this.bank.value(port, sub.mode);
    if (value) this.reportIfChanged(port, sub, value);
  }

  /**
   * The hub LED takes direct mode data only: mode 0 = one color index byte (a color table id, 255
   * included), mode 1 = three rgb bytes (lwp3 mode table, 'derivado del layout'). Anything else is
   * answered 0x05 invalid use and leaves the color alone. A command that asked for completion feedback
   * is answered like the motor commands that run until replaced: 0x82 in-progress (0x01) then
   * completed+idle (0x0A). supuesto: TODO(hw) the real hub's reaction and its feedback.
   */
  private onLedCommand(msg: Extract<Lwp3Message, { type: "portOutputCommand" }>): void {
    const c = msg.command;
    let next: LedState | undefined;
    if (c.sub === "writeDirectModeData") {
      const [a, g, b] = c.data;
      if (c.mode === 0 && c.data.length === 1 && a !== undefined && isColorId(a)) {
        next = { kind: "index", color: a };
      } else if (c.mode === 1 && c.data.length === 3) {
        next = { kind: "rgb", r: a as number, g: g as number, b: b as number };
      }
    }
    if (!next) {
      this.error(MessageType.PortOutputCommand, ErrorCode.InvalidUse);
      return;
    }
    this.ledColor = next;
    if (msg.completion === "feedback") {
      this.emit(encodePortOutputFeedback({ ports: [{ port: msg.port, flags: 0x01 }] }));
      this.emit(encodePortOutputFeedback({ ports: [{ port: msg.port, flags: 0x0a }] }));
    }
    for (const listener of [...this.ledListeners]) {
      try {
        listener(next);
      } catch (err) {
        queueMicrotask(() => {
          throw err;
        });
      }
    }
  }

  private error(commandType: number, code: number): void {
    this.emit(encodeGenericError({ commandType, code }));
  }

  private emit(frame: Uint8Array): void {
    if (!this.link) return;
    if (this.latencyMs <= 0) {
      this.deliver(frame);
      return;
    }
    const handle = this.clock.setTimeout(() => {
      this.timers.delete(handle);
      this.deliver(frame);
    }, this.latencyMs);
    this.timers.add(handle);
  }

  private deliver(frame: Uint8Array): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(frame.slice());
      } catch (err) {
        // A throwing listener must not stop the others, nor vanish.
        queueMicrotask(() => {
          throw err;
        });
      }
    }
  }
}
