import { Reader, Writer, guardReads } from "./bytes.js";
import { MessageType } from "./constants.js";
import { encodeFrame } from "./header.js";
import type {
  DecodeError,
  PortInputFormatMessage,
  PortInputFormatSetupMessage,
} from "./messages.js";

type Fields = Omit<PortInputFormatMessage, "type">;

const write = (type: number, m: Fields): Uint8Array =>
  encodeFrame(
    type,
    new Writer()
      .u8(m.port)
      .u8(m.mode)
      .u32(m.deltaInterval)
      .u8(m.notify ? 1 : 0)
      .toBytes(),
  );

/** Same payload for 0x41 (doc 3.17) and 0x47 (doc 3.23): port, mode, u32 delta, notify. */
function read(type: number, payload: Uint8Array): Fields | DecodeError {
  return guardReads(type, () => {
    const r = new Reader(payload);
    const port = r.u8();
    const mode = r.u8();
    const deltaInterval = r.u32();
    const at = r.offset;
    const n = r.u8();
    if (n > 1)
      return { kind: "error", reason: "bad-field", messageType: type, offset: at } as const;
    return { port, mode, deltaInterval, notify: n === 1 };
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
