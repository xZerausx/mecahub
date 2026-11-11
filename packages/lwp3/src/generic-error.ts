import { Reader, guardReads } from "./bytes.js";
import { MessageType } from "./constants.js";
import type { DecodeError, GenericErrorMessage } from "./messages.js";

/** Decodes the payload of message 0x05 (doc 3.9.1): command type, error code. */
export function decodeGenericError(payload: Uint8Array): GenericErrorMessage | DecodeError {
  return guardReads(MessageType.GenericError, () => {
    const r = new Reader(payload);
    return { type: "genericError", commandType: r.u8(), code: r.u8() } as const;
  });
}
