export const PACKAGE_NAME = "@mecahub/lwp3";

export {
  ErrorCode,
  HubPropertyId,
  HubPropertyOperation,
  IoTypeId,
  MessageType,
} from "./constants.js";
export { decode } from "./decode.js";
export { encodeFrame } from "./header.js";
export { encodeHubProperty } from "./hub-properties.js";
export type {
  DecodeError,
  DecodeErrorReason,
  GenericErrorMessage,
  HubPropertyMessage,
  HubPropertyName,
  HubPropertyValue,
  Lwp3Message,
  UnknownMessage,
} from "./messages.js";
export { decodeVersion, encodeVersion } from "./version.js";
export type { Version } from "./version.js";
