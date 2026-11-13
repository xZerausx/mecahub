export const PACKAGE_NAME = "@mecahub/hub";

export { HubError } from "./errors.js";
export type { HubErrorCode } from "./errors.js";
export { MoveHubPort, PortRegistry } from "./registry.js";
export type { PhysicalDevice, PortDevice, PortRegistryOptions, VirtualDevice } from "./registry.js";
export { HubSession } from "./session.js";
export type { HubSessionOptions, OutputStatus, SessionEvent } from "./session.js";
