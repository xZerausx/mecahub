export const LWP3_SERVICE_UUID = "00001623-1212-efde-1623-785feabcd123";
export const LWP3_CHARACTERISTIC_UUID = "00001624-1212-efde-1623-785feabcd123";

export type TransportState = "idle" | "selected" | "connecting" | "connected" | "disconnected";

export interface BleDeviceInfo {
  readonly id: string;
  readonly name?: string;
}

export type WritePriority = "normal" | "urgent";

export const TransportErrorCode = {
  NotConnected: "not-connected",
  NoDevice: "no-device",
  Cancelled: "cancelled",
  Gatt: "gatt",
  /** The environment has no usable Bluetooth (e.g. a browser without Web Bluetooth). */
  Unsupported: "unsupported",
} as const;
export type TransportErrorCode = (typeof TransportErrorCode)[keyof typeof TransportErrorCode];

export class TransportError extends Error {
  readonly code: TransportErrorCode;
  constructor(code: TransportErrorCode, message?: string, options?: ErrorOptions) {
    super(message ?? code, options);
    this.name = "TransportError";
    this.code = code;
  }
}

/**
 * State contract (every implementation, including the web adapter, follows it):
 * - idle -> selected: `requestDevice` resolves.
 * - selected | disconnected -> connecting -> connected: `connect`; connect from idle rejects
 *   "no-device"; a connect that finds the state changed meanwhile rejects "cancelled".
 * - `connect` while connecting joins the attempt in flight (same outcome, no second link); a failed
 *   connect rejects "gatt" and leaves the state "disconnected". `disconnect()` from idle or
 *   selected is a no-op that fires no event.
 * - connecting | connected -> disconnected: `disconnect()` or a link loss; listeners fire once.
 * - disconnected -> selected: `requestDevice` again (or `connect` straight away to reuse the device).
 * - `requestDevice` while connecting or connected rejects "gatt".
 *
 * The only door to Bluetooth. Notifications deliver RAW bytes: one notification may hold several
 * LWP3 messages, splitting is the consumer's job (lwp3 `splitFrames`). This package does not
 * depend on lwp3.
 */
export interface BleTransport {
  readonly state: TransportState;
  /** Web: opens the browser chooser (needs a user gesture). Native: scans. Filters by the LWP3 service. */
  requestDevice(): Promise<BleDeviceInfo>;
  connect(): Promise<void>;
  /**
   * Writes are serialized (one GATT write in flight). Rejects with code "cancelled" when
   * superseded by an urgent write, "not-connected" when the link is down, "gatt" on a failed or
   * timed-out write. Callers MUST handle the rejection: fire-and-forget writes need `.catch`.
   */
  write(bytes: Uint8Array, options?: { priority?: WritePriority }): Promise<void>;
  /** Returns the unsubscribe function. */
  onNotify(listener: (bytes: Uint8Array) => void): () => void;
  /** Returns the unsubscribe function. */
  onDisconnect(listener: () => void): () => void;
  disconnect(): Promise<void>;
}
