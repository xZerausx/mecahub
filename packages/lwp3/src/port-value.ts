import { Reader, Writer, guardReads } from "./bytes.js";
import { MessageType } from "./constants.js";
import { encodeFrame } from "./header.js";
import type { DecodeError, PortValueMessage } from "./messages.js";

const T = MessageType.PortValueSingle;

export type PortValueKind = "u8" | "i8" | "u16" | "i16" | "u32" | "i32" | "f32";

const SIZE: Record<PortValueKind, number> = {
  u8: 1,
  i8: 1,
  u16: 2,
  i16: 2,
  u32: 4,
  i32: 4,
  f32: 4,
};

// TODO(hw): the doc does not state endianness for port values; little-endian assumed.
/** Reads one little-endian value from the start of `raw`; undefined when `raw` is too short. */
export function readPortValue(raw: Uint8Array, kind: PortValueKind): number | undefined {
  if (raw.length < SIZE[kind]) return undefined;
  return new Reader(raw)[kind]();
}

/** Encodes Port Value (Single), upstream (used by simulators). Needs at least one value byte. */
export function encodePortValueSingle(port: number, raw: Uint8Array): Uint8Array {
  if (raw.length < 1) throw new RangeError("port value needs at least one byte");
  return encodeFrame(T, new Writer().u8(port).bytes(raw).toBytes());
}

/** Decodes a single-port Port Value payload (doc 3.21): port + raw bytes (size depends on mode). */
export function decodePortValueSingle(payload: Uint8Array): PortValueMessage | DecodeError {
  return guardReads(T, () => {
    const r = new Reader(payload);
    const port = r.u8();
    if (r.remaining < 1) r.u8(); // no value: reports payload-too-short at the right offset
    return { type: "portValue", port, raw: r.rest() } as const;
  });
}
