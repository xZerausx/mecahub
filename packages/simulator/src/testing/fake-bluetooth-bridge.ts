// Test support only: wires a scriptable `navigator.bluetooth` (transport/testing) to a
// SimulatedHub, so the REAL Web Bluetooth adapter can be exercised against the simulated hub.
// Imports types only from the testing module (it pulls vitest), so nothing of it is bundled.
import type { FakeBluetooth } from "@mecahub/transport/testing";
import type { SimulatedHub } from "../hub/index.js";

export interface FakeBluetoothBridge {
  /** Detaches the hub from the fake device. */
  dispose(): void;
}

export interface FakeBluetoothBridgeOptions {
  /** Time every write takes to reach the hub (the write stays in flight meanwhile). Default 0. */
  writeLatencyMs?: number;
}

export function bridgeFakeBluetooth(
  bluetooth: FakeBluetooth,
  hub: SimulatedHub,
  options: FakeBluetoothBridgeOptions = {},
): FakeBluetoothBridge {
  const device = bluetooth.device;
  const server = device.gatt;
  if (!server) throw new Error("the fake device has no GATT server");
  const characteristic = server.characteristic;
  const latency = options.writeLatencyMs ?? 0;
  let attached = true;
  server.onConnected = () => {
    if (attached) hub.connect();
  };
  characteristic.onWrite = async (bytes) => {
    if (latency > 0) await new Promise<void>((resolve) => setTimeout(resolve, latency));
    if (attached && hub.connected) hub.receive(bytes);
  };
  const onDrop = (): void => {
    if (attached) hub.disconnect();
  };
  device.addEventListener("gattserverdisconnected", onDrop);
  const offSend = hub.onSend((frame) => {
    if (attached) characteristic.notify(frame);
  });
  return {
    dispose() {
      attached = false;
      offSend();
      device.removeEventListener("gattserverdisconnected", onDrop);
      server.onConnected = undefined;
      characteristic.onWrite = undefined;
    },
  };
}
