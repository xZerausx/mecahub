import { MessageType } from "./constants.js";
import { decodeGenericError } from "./generic-error.js";
import { decodeHeader } from "./header.js";
import { decodeHubProperty } from "./hub-properties.js";
import type { DecodeError, Lwp3Message } from "./messages.js";

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
    case MessageType.GenericError:
      return decodeGenericError(frame.payload);
    default:
      return { type: "unknown", messageType: frame.messageType, payload: frame.payload };
  }
}
