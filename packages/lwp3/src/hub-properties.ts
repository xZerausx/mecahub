import { Reader, ReaderRangeError, Writer, guardReads } from "./bytes.js";
import { HubPropertyId, HubPropertyOperation, MessageType } from "./constants.js";
import { encodeFrame } from "./header.js";
import type {
  DecodeError,
  HubPropertyMessage,
  HubPropertyName,
  HubPropertyValue,
  UnknownMessage,
} from "./messages.js";
import { decodeVersion, encodeVersion } from "./version.js";

const MAX_NAME = 14;
const T = MessageType.HubProperties;

const idOf: Record<HubPropertyName, number> = {
  advertisingName: HubPropertyId.AdvertisingName,
  button: HubPropertyId.Button,
  firmwareVersion: HubPropertyId.FirmwareVersion,
  hardwareVersion: HubPropertyId.HardwareVersion,
  rssi: HubPropertyId.Rssi,
  batteryVoltage: HubPropertyId.BatteryVoltage,
  primaryMacAddress: HubPropertyId.PrimaryMacAddress,
};
const nameOf = new Map(Object.entries(idOf).map(([n, id]) => [id, n as HubPropertyName]));

const opOf = {
  set: HubPropertyOperation.Set,
  enableUpdates: HubPropertyOperation.EnableUpdates,
  disableUpdates: HubPropertyOperation.DisableUpdates,
  reset: HubPropertyOperation.Reset,
  requestUpdate: HubPropertyOperation.RequestUpdate,
  update: HubPropertyOperation.Update,
} as const;
const opName = new Map<number, keyof typeof opOf>(
  Object.entries(opOf).map(([n, id]) => [id, n as keyof typeof opOf]),
);

const isAscii = (bytes: ArrayLike<number>) => Array.from(bytes).every((c) => c <= 0x7f);

function writeValue(w: Writer, v: HubPropertyValue): void {
  switch (v.property) {
    case "advertisingName": {
      const codes = Array.from(v.value, (c) => c.charCodeAt(0));
      if (codes.length < 1 || v.value.length > MAX_NAME || !isAscii(codes)) {
        throw new RangeError("advertising name must be 1..14 ASCII characters");
      }
      w.bytes(codes);
      return;
    }
    case "button":
      w.u8(v.value ? 1 : 0);
      return;
    case "firmwareVersion":
    case "hardwareVersion":
      w.i32(encodeVersion(v.value));
      return;
    case "rssi":
      if (v.value < -127 || v.value > 0) throw new RangeError("rssi must be -127..0");
      w.i8(v.value);
      return;
    case "batteryVoltage":
      if (v.value > 100) throw new RangeError("battery must be 0..100");
      w.u8(v.value);
      return;
    case "primaryMacAddress":
      if (v.value.length !== 6) throw new RangeError("MAC address must have 6 bytes");
      w.bytes(v.value);
      return;
  }
}

/** Encodes a full hub property frame (downstream ops, or Update for simulators). */
export function encodeHubProperty(msg: HubPropertyMessage): Uint8Array {
  const w = new Writer().u8(idOf[msg.property]).u8(opOf[msg.operation]);
  if (msg.operation === "update" || msg.operation === "set") writeValue(w, msg);
  return encodeFrame(T, w.toBytes());
}

const bad = (offset: number): DecodeError => ({
  kind: "error",
  reason: "bad-field",
  messageType: T,
  offset,
});

function readValue(r: Reader, property: HubPropertyName): HubPropertyValue | DecodeError {
  const at = r.offset;
  switch (property) {
    case "advertisingName": {
      const raw = r.rest();
      if (raw.length < 1) throw new ReaderRangeError(at);
      return isAscii(raw) ? { property, value: String.fromCharCode(...raw) } : bad(at);
    }
    case "button": {
      const v = r.u8();
      return v > 1 ? bad(at) : { property, value: v === 1 };
    }
    case "firmwareVersion":
    case "hardwareVersion": {
      // Lenient: a non-BCD version is flagged (`bcd: false`), never a bad-field error.
      return { property, value: decodeVersion(r.i32()) };
    }
    case "rssi": {
      const v = r.i8();
      return v > 0 || v < -127 ? bad(at) : { property, value: v };
    }
    case "batteryVoltage": {
      const v = r.u8();
      return v > 100 ? bad(at) : { property, value: v };
    }
    case "primaryMacAddress":
      return { property, value: r.mac() };
  }
}

/** Decodes the payload (after the common header) of a Hub Properties message. */
export function decodeHubProperty(
  payload: Uint8Array,
): HubPropertyMessage | UnknownMessage | DecodeError {
  return guardReads(T, () => {
    const r = new Reader(payload);
    const property = nameOf.get(r.u8());
    const operation = opName.get(r.u8());
    if (!operation) return bad(1);
    if (!property || (operation === "set" && property !== "advertisingName")) {
      return { type: "unknown", messageType: T, payload } as const;
    }
    if (operation === "update" || operation === "set") {
      const v = readValue(r, property);
      if ("kind" in v) return v;
      return { type: "hubProperty", operation, ...v } as HubPropertyMessage;
    }
    return { type: "hubProperty", operation, property };
  });
}
