import type { DecodedVersion } from "./version.js";

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
export type HubPropertyValue =
  | { readonly property: "advertisingName"; readonly value: string }
  | { readonly property: "button"; readonly value: boolean }
  | { readonly property: "firmwareVersion"; readonly value: DecodedVersion }
  | { readonly property: "hardwareVersion"; readonly value: DecodedVersion }
  | { readonly property: "rssi"; readonly value: number }
  /** Battery level in percent, 0..100 (wire property "Battery Voltage", 0x06, doc 3.5). */
  | { readonly property: "batteryPercent"; readonly value: number }
  | { readonly property: "primaryMacAddress"; readonly value: readonly number[] };

export type HubPropertyName = HubPropertyValue["property"];

export type HubPropertyMessage =
  | ({ readonly type: "hubProperty"; readonly operation: "update" } & HubPropertyValue)
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

export type Lwp3Message = HubPropertyMessage | GenericErrorMessage | UnknownMessage;
