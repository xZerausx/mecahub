import { Reader, Writer, guardReads } from "./bytes.js";
import { MessageType } from "./constants.js";
import { encodeFrame } from "./header.js";
import type {
  DecodeError,
  PortInputFormatMessage,
  PortInputFormatSetupMessage,
} from "./messages.js";

type Fields = Omit<PortInputFormatMessage, "type">;

function write(type: number, m: Fields): Uint8Array {
  if (typeof m.notify !== "boolean") throw new RangeError(`notify must be a boolean: ${m.notify}`);
  return encodeFrame(
    type,
    new Writer()
      .u8(m.port)
      .u8(m.mode)
      .u32(m.deltaInterval)
      .u8(m.notify ? 1 : 0)
      .toBytes(),
  );
}

// TODO(hw): the doc does not state endianness for the delta interval; little-endian assumed
// (pylgbst, pybricksdev and node-poweredup all write it LE).
/** Same payload for 0x41 (doc 3.17) and 0x47 (doc 3.23): port, mode, u32 delta, notify. */
function read(type: number, payload: Uint8Array): Fields | DecodeError {
  return guardReads(type, () => {
    const r = new Reader(payload);
    const port = r.u8();
    const mode = r.u8();
    const deltaInterval = r.u32();
    // The doc defines only 0/1; any non-zero byte counts as enabled (pylgbst, pybricksdev).
    const notify = r.u8() !== 0;
    return { port, mode, deltaInterval, notify };
  });
}

/** Encodes Port Input Format Setup (Single), downstream. Throws RangeError on invalid fields. */
export function encodePortInputFormatSetup(msg: PortInputFormatSetupMessage): Uint8Array {
  return write(MessageType.PortInputFormatSetupSingle, msg);
}

/** Encodes Port Input Format (Single), upstream (used by simulators). */
export function encodePortInputFormat(msg: PortInputFormatMessage): Uint8Array {
  return write(MessageType.PortInputFormatSingle, msg);
}

export function decodePortInputFormatSetup(
  payload: Uint8Array,
): PortInputFormatSetupMessage | DecodeError {
  const v = read(MessageType.PortInputFormatSetupSingle, payload);
  return "kind" in v ? v : { type: "portInputFormatSetup", ...v };
}

export function decodePortInputFormat(payload: Uint8Array): PortInputFormatMessage | DecodeError {
  const v = read(MessageType.PortInputFormatSingle, payload);
  return "kind" in v ? v : { type: "portInputFormat", ...v };
}
