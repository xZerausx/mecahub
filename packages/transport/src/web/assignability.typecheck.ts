// Type-only: compiled by `tsc -p tsconfig.web-check.json` (never imported, never run). It proves
// that the real Web Bluetooth types (@types/web-bluetooth) are assignable to our structural ones.
// @types/web-bluetooth is loaded only by that tsconfig, so its globals never leak into core files.
import type { BluetoothLike } from "./bluetooth-types.js";

export const realBluetooth: BluetoothLike = navigator.bluetooth;
