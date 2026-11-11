import type { EndState } from "./constants.js";
import type { DecodedVersion, Version } from "./version.js";

export type DecodeErrorReason =
  /** Buffer shorter than the declared length (or than a fixed field). */
  | "truncated"
  /** Declared length is smaller than the header itself. */
  | "length-mismatch"
  /** Declared length is fine but the payload is smaller than the message type needs. */
  | "payload-too-short"
  /** A field holds a value outside what the doc allows. */
  | "bad-field";

export interface DecodeError {
  readonly kind: "error";
  readonly reason: DecodeErrorReason;
  readonly messageType?: number;
  readonly offset?: number;
}

/** Value-carrying hub properties (doc 3.5). */
export type HubPropertyValue<V extends Version = DecodedVersion> =
  | { readonly property: "advertisingName"; readonly value: string }
  | { readonly property: "button"; readonly value: boolean }
  | { readonly property: "firmwareVersion"; readonly value: V }
  | { readonly property: "hardwareVersion"; readonly value: V }
  | { readonly property: "rssi"; readonly value: number }
  /** Battery level in percent, 0..100 (wire property "Battery Voltage", 0x06, doc 3.5). */
  | { readonly property: "batteryPercent"; readonly value: number }
  | { readonly property: "primaryMacAddress"; readonly value: readonly number[] };

export type HubPropertyName = HubPropertyValue["property"];

/**
 * Decode returns `HubPropertyMessage` (versions as `DecodedVersion`); the encoder accepts
 * `HubPropertyMessage<Version>`, so a plain `{major, minor, bugfix, build}` is enough.
 */
export type HubPropertyMessage<V extends Version = DecodedVersion> =
  | ({ readonly type: "hubProperty"; readonly operation: "update" } & HubPropertyValue<V>)
  | {
      readonly type: "hubProperty";
      readonly operation: "set";
      readonly property: "advertisingName";
      readonly value: string;
    }
  | {
      readonly type: "hubProperty";
      readonly operation: "enableUpdates" | "disableUpdates" | "reset" | "requestUpdate";
      readonly property: HubPropertyName;
    };

/** Hub Attached I/O (doc 3.8). `ioType` stays a raw number: unknown device types are not an error. */
export type HubAttachedIoMessage<V extends Version = DecodedVersion> =
  | { readonly type: "hubAttachedIo"; readonly event: "detached"; readonly port: number }
  | {
      readonly type: "hubAttachedIo";
      readonly event: "attached";
      readonly port: number;
      readonly ioType: number;
      readonly hardwareVersion: V;
      readonly softwareVersion: V;
    }
  | {
      readonly type: "hubAttachedIo";
      readonly event: "attachedVirtual";
      /** Dynamic (assigned by the hub); never hardcode it. */
      readonly port: number;
      readonly ioType: number;
      readonly portA: number;
      readonly portB: number;
    };

/** Port Input Format Setup (Single), downstream (doc 3.17). */
export interface PortInputFormatSetupMessage {
  readonly type: "portInputFormatSetup";
  readonly port: number;
  readonly mode: number;
  /** UInt32 delta interval; 0 = as fast as possible, 1 = every change. */
  readonly deltaInterval: number;
  readonly notify: boolean;
}

/** Port Input Format (Single), upstream reply to the setup (doc 3.23). */
export interface PortInputFormatMessage {
  readonly type: "portInputFormat";
  readonly port: number;
  readonly mode: number;
  readonly deltaInterval: number;
  readonly notify: boolean;
}

/**
 * Port Value (Single) (doc 3.21). The value size depends on the port's mode, so the bytes are
 * kept raw; use `readPortValue`. Multi-port messages are not split (see protocol-notes).
 */
export interface PortValueMessage {
  readonly type: "portValue";
  readonly port: number;
  readonly raw: Uint8Array;
}

/** Startup information (high nibble of the startup/completion byte, doc 3.26). */
export type OutputStartup = "buffer" | "immediate";
/** Completion information (low nibble, doc 3.26): `feedback` asks for a 0x82 message. */
export type OutputCompletion = "none" | "feedback";

/** Acceleration (0x01) and deceleration (0x02) profile flags of `useProfile` (doc 3.27). */
export interface UseProfile {
  readonly acc: boolean;
  readonly dec: boolean;
}

/**
 * Port Output sub-commands (doc 3.27). Encoder speeds are percent -100..100, plus 126 (hold) on
 * `startSpeed`/`startSpeed2` only; float and brake (127) belong to `startPower`. `maxPower` is
 * 0..100. The decoder is more lenient (see protocol-notes). `unknown` is decode-only:
 * sub-commands the codec does not model.
 */
export type PortOutputCommand =
  | {
      /** 0x01. Unregulated PWM: -100..100 percent, 0 = float, 127 = brake (doc 3.27). */
      readonly sub: "startPower";
      readonly power: number;
    }
  | {
      /** Synchronized virtual port only (0x02). Same Power values as `startPower`. */
      readonly sub: "startPower2";
      readonly power1: number;
      readonly power2: number;
    }
  | {
      readonly sub: "startSpeed";
      readonly speed: number;
      readonly maxPower: number;
      readonly useProfile: UseProfile;
    }
  | {
      /** Synchronized virtual port only (0x08). */
      readonly sub: "startSpeed2";
      readonly speed1: number;
      readonly speed2: number;
      readonly maxPower: number;
      readonly useProfile: UseProfile;
    }
  | {
      readonly sub: "startSpeedForTime";
      /** Milliseconds, Int16 per the doc (0..32767). */
      readonly time: number;
      readonly speed: number;
      readonly maxPower: number;
      readonly endState: EndState;
      readonly useProfile: UseProfile;
    }
  | {
      readonly sub: "startSpeedForDegrees";
      /** Int32, 1..MAX_INT32; the sign of the movement comes from `speed`. */
      readonly degrees: number;
      readonly speed: number;
      readonly maxPower: number;
      readonly endState: EndState;
      readonly useProfile: UseProfile;
    }
  | {
      readonly sub: "gotoAbsolutePosition";
      readonly absPos: number;
      /** 1..100 (doc 3.27). */
      readonly speed: number;
      readonly maxPower: number;
      readonly endState: EndState;
      readonly useProfile: UseProfile;
    }
  | { readonly sub: "writeDirectModeData"; readonly mode: number; readonly data: Uint8Array }
  | { readonly sub: "unknown"; readonly subCommand: number; readonly payload: Uint8Array };

/** Port Output Command (doc 3.26), downstream. */
export interface PortOutputCommandMessage {
  readonly type: "portOutputCommand";
  readonly port: number;
  readonly startup: OutputStartup;
  readonly completion: OutputCompletion;
  readonly command: PortOutputCommand;
}

export interface GenericErrorMessage {
  readonly type: "genericError";
  /** Message type of the command that triggered the response. */
  readonly commandType: number;
  readonly code: number;
}

export interface UnknownMessage {
  readonly type: "unknown";
  readonly messageType: number;
  readonly payload: Uint8Array;
}

export type Lwp3Message =
  | HubPropertyMessage
  | HubAttachedIoMessage
  | PortInputFormatSetupMessage
  | PortInputFormatMessage
  | PortValueMessage
  | PortOutputCommandMessage
  | GenericErrorMessage
  | UnknownMessage;
