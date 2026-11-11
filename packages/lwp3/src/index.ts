export const PACKAGE_NAME = "@mecahub/lwp3";

export {
  ErrorCode,
  HubPropertyId,
  HubPropertyOperation,
  IoTypeId,
  MessageType,
} from "./constants.js";
export { encodeHubAttachedIo } from "./attached-io.js";
export { decode } from "./decode.js";
export { encodeFrame } from "./header.js";
export { splitFrames } from "./split.js";
export { encodeHubProperty } from "./hub-properties.js";
export { encodePortInputFormat, encodePortInputFormatSetup } from "./port-input.js";
export { encodePortValueSingle, readPortValue } from "./port-value.js";
export type { PortValueKind } from "./port-value.js";
export type {
  DecodeError,
  DecodeErrorReason,
  GenericErrorMessage,
  HubAttachedIoMessage,
  HubPropertyMessage,
  HubPropertyName,
  HubPropertyValue,
  Lwp3Message,
  PortInputFormatMessage,
  PortInputFormatSetupMessage,
  PortValueMessage,
  UnknownMessage,
} from "./messages.js";
export { decodeVersion, encodeVersion } from "./version.js";
export type { DecodedVersion, Version } from "./version.js";
