import {
  ErrorCode,
  MessageType,
  decode,
  encodeGenericError,
  encodeHubAttachedIo,
  encodeHubProperty,
  encodePortInputFormat,
  encodePortValueSingle,
  type HubPropertyName,
  type Lwp3Message,
} from "@mecahub/lwp3";
import { realClock, type SimClock, type SimTimerHandle } from "./clock.js";
import { defaultMoveHubConfig, type SimHubConfig, type SimValueFormat } from "./config.js";

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
  private readonly values = new Map<number, Uint8Array>();
  private readonly knownPorts = new Set<number>();
  private readonly formats = new Map<number, SimValueFormat>();
  private name: string;
  private battery: number;
  private button: boolean;
  private link = false;

  constructor(config: SimHubConfig = defaultMoveHubConfig(), options: SimulatedHubOptions = {}) {
    this.config = config;
    this.clock = options.clock ?? realClock;
    this.latencyMs = options.latencyMs ?? 0;
    this.name = config.name;
    this.battery = config.batteryPercent;
    this.button = config.buttonPressed;
    for (const p of [...config.ports, ...config.virtualPorts]) {
      this.knownPorts.add(p.port);
      if (p.valueFormat) this.formats.set(p.port, p.valueFormat);
    }
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
    this.link = false;
    for (const t of this.timers) this.clock.clearTimeout(t);
    this.timers.clear();
    this.subscribed.clear();
    this.inputs.clear();
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
      default:
        // supuesto: TODO(hw) answer 0x05 'command not recognized' (doc 3.9). Port output
        // commands (0x81) land here until the motor model exists.
        this.error(commandTypeOf(msg), ErrorCode.CommandNotRecognized);
    }
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
   * Sets the raw value a port reports. Raw bytes because port modes (0x43/0x44) are not modelled
   * yet, so there is no typed tilt/color/distance encoding. With notifications enabled on the
   * port, a change is sent as 0x45 when any component moved by at least the delta interval
   * against the last reported value; the first value always is. Components come from the port's
   * `valueFormat` (the value must then be exactly `count * width` bytes); without one every byte
   * is an unsigned component. supuesto: TODO(hw)
   */
  setSensor(port: number, raw: Uint8Array): void {
    if (!this.knownPorts.has(port)) throw new RangeError(`unknown port 0x${port.toString(16)}`);
    if (raw.length < 1) throw new RangeError("a sensor value needs at least one byte");
    const format = this.formats.get(port);
    if (format && raw.length !== format.count * format.width) {
      throw new RangeError(
        `port 0x${port.toString(16)} values are ${format.count * format.width} bytes`,
      );
    }
    const value = raw.slice();
    this.values.set(port, value);
    const sub = this.inputs.get(port);
    if (!this.link || !sub?.notify) return;
    this.reportIfChanged(port, sub, value);
  }

  private reportIfChanged(port: number, sub: InputSubscription, value: Uint8Array): void {
    const last = sub.reported;
    if (last && !this.changedEnough(port, last, value, sub.deltaInterval)) return;
    sub.reported = value;
    this.emit(encodePortValueSingle(port, value));
  }

  private changedEnough(port: number, last: Uint8Array, now: Uint8Array, delta: number): boolean {
    if (sameBytes(last, now)) return false;
    const format = this.formats.get(port);
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
    const sub: InputSubscription = { deltaInterval, notify, reported: undefined };
    this.inputs.set(port, sub);
    // supuesto: the 0x47 reply echoes the setup; the capture has no 0x41. TODO(hw)
    this.emit(
      encodePortInputFormat({ type: "portInputFormat", port, mode, deltaInterval, notify }),
    );
    // supuesto: with notifications on, the current value follows the reply. TODO(hw) confirm that
    // a real hub reports the current value after a setup
    const current = this.values.get(port);
    if (notify && current) this.reportIfChanged(port, sub, current);
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
