export {
  LWP3_CHARACTERISTIC_UUID,
  LWP3_SERVICE_UUID,
  TransportError,
  TransportErrorCode,
} from "./transport.js";
export type { BleDeviceInfo, BleTransport, TransportState, WritePriority } from "./transport.js";
export { createWriteQueue } from "./write-queue.js";
export type { WriteQueue } from "./write-queue.js";
