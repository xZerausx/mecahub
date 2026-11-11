/**
 * Minimal structural view of the Web Bluetooth API: exactly what WebBleTransport uses.
 * lib.dom does not ship Web Bluetooth types and we do not want @types/web-bluetooth, so the real
 * `navigator.bluetooth` is expected to be assignable to `BluetoothLike` (and tests pass fakes).
 */

export interface RequestDeviceOptionsLike {
  // Mutable on purpose: the real RequestDeviceOptions takes mutable arrays.
  filters: { services: string[] }[];
}

export interface CharacteristicLike {
  readonly properties: {
    readonly write: boolean;
    readonly writeWithoutResponse: boolean;
    readonly notify: boolean;
  };
  /** Latest notification payload; only valid while `characteristicvaluechanged` is dispatching. */
  readonly value?: DataView | undefined;
  startNotifications(): Promise<unknown>;
  writeValueWithResponse(value: Uint8Array<ArrayBuffer>): Promise<void>;
  writeValueWithoutResponse(value: Uint8Array<ArrayBuffer>): Promise<void>;
  addEventListener(type: "characteristicvaluechanged", listener: () => void): void;
  removeEventListener(type: "characteristicvaluechanged", listener: () => void): void;
}

export interface ServiceLike {
  getCharacteristic(uuid: string): Promise<CharacteristicLike>;
}

export interface GattServerLike {
  readonly connected: boolean;
  connect(): Promise<unknown>;
  disconnect(): void;
  getPrimaryService(uuid: string): Promise<ServiceLike>;
}

export interface DeviceLike {
  readonly id: string;
  readonly name?: string | undefined;
  readonly gatt?: GattServerLike | undefined;
  addEventListener(type: "gattserverdisconnected", listener: () => void): void;
  removeEventListener(type: "gattserverdisconnected", listener: () => void): void;
}

export interface BluetoothLike {
  requestDevice(options: RequestDeviceOptionsLike): Promise<DeviceLike>;
}
