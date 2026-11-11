import { MessageType } from "./constants.js";
import { decodeHubAttachedIo } from "./attached-io.js";
import { decodeGenericError } from "./generic-error.js";
import { decodeHeader } from "./header.js";
import { decodeHubProperty } from "./hub-properties.js";
import type { DecodeError, Lwp3Message } from "./messages.js";
import { decodePortInputFormat, decodePortInputFormatSetup } from "./port-input.js";
import { decodePortValueSingle } from "./port-value.js";

/**
 * Decodes one LWP3 frame. Never throws: malformed input yields a DecodeError and unmodelled
 * message types yield `{type: "unknown"}`. Bytes beyond the declared length are ignored.
 */
export function decode(bytes: Uint8Array): Lwp3Message | DecodeError {
  const frame = decodeHeader(bytes);
  if ("kind" in frame) return frame;
  switch (frame.messageType) {
    case MessageType.HubProperties:
      return decodeHubProperty(frame.payload);
    case MessageType.HubAttachedIo:
      return decodeHubAttachedIo(frame.payload);
    case MessageType.PortInputFormatSetupSingle:
      return decodePortInputFormatSetup(frame.payload);
    case MessageType.PortInputFormatSingle:
      return decodePortInputFormat(frame.payload);
    case MessageType.PortValueSingle:
      return decodePortValueSingle(frame.payload);
    case MessageType.GenericError:
      return decodeGenericError(frame.payload);
    default:
      return { type: "unknown", messageType: frame.messageType, payload: frame.payload };
  }
}
