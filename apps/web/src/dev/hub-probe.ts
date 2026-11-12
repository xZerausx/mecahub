import { decode, encodeHubProperty, splitFrames } from "@mecahub/lwp3";
import { TransportError, type BleTransport, type TransportState } from "@mecahub/transport";

/** "choosing" = the browser device chooser is open (the click already called requestDevice). */
export type ProbeState = "idle" | "choosing" | "connecting" | "connected" | "disconnected";

export interface LogEntry {
  dir: "tx" | "rx";
  /** Uppercase hex bytes separated by spaces, e.g. "05 00 01 06 02". */
  hex: string;
  /** Milliseconds since the connection attempt started. */
  at: number;
  note?: string;
}

export interface ProbeSnapshot {
  state: ProbeState;
  name?: string;
  batteryPercent?: number;
  log: LogEntry[];
}

export interface HubProbe {
  /** Opens the browser chooser and connects. Call it directly from a click handler. */
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /** Stable between changes (safe for useSyncExternalStore). */
  getSnapshot(): ProbeSnapshot;
  subscribe(listener: (snapshot: ProbeSnapshot) => void): () => void;
  /** Text to paste into packages/lwp3 fixtures (origin: capturado). */
  exportLog(): string;
}

export interface HubProbeOptions {
  /** Monotonic clock in ms. Defaults to `performance.now`. */
  now?: () => number;
}

export const MAX_LOG_ENTRIES = 500;

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" ");

const fromTransport = (state: TransportState): ProbeState =>
  state === "connected" || state === "connecting" || state === "disconnected" ? state : "idle";

/**
 * Minimal hub session for the dev connect page: connects, asks for the advertising name and
 * battery, and keeps a hex log of everything on the wire. Never throws from notifications.
 */
export function createHubProbe(transport: BleTransport, options: HubProbeOptions = {}): HubProbe {
  const now = options.now ?? (() => performance.now());
  const listeners = new Set<(snapshot: ProbeSnapshot) => void>();
  let snapshot: ProbeSnapshot = { state: "idle", log: [] };
  let startedAt = 0;
  let unlisten: (() => void)[] = [];
  let disconnectRequested = false;

  const publish = (next: ProbeSnapshot): void => {
    snapshot = next;
    for (const listener of [...listeners]) listener(snapshot);
  };

  const append = (entries: LogEntry[], patch: Partial<ProbeSnapshot> = {}): void => {
    publish({ ...snapshot, ...patch, log: [...snapshot.log, ...entries].slice(-MAX_LOG_ENTRIES) });
  };

  const entry = (dir: "tx" | "rx", bytes: Uint8Array, note?: string): LogEntry => ({
    dir,
    hex: toHex(bytes),
    at: Math.round(now() - startedAt),
    ...(note === undefined ? {} : { note }),
  });

  const onNotify = (chunk: Uint8Array): void => {
    const { frames, error } = splitFrames(chunk);
    const entries: LogEntry[] = [];
    const patch: { name?: string; batteryPercent?: number } = {};
    for (const frame of frames) {
      const message = decode(frame);
      if ("kind" in message) {
        entries.push(entry("rx", frame, `decode error: ${message.reason}`));
        continue;
      }
      entries.push(entry("rx", frame));
      if (message.type === "hubProperty" && message.operation === "update") {
        if (message.property === "advertisingName") patch.name = message.value;
        if (message.property === "batteryPercent") patch.batteryPercent = message.value;
      }
    }
    if (error) {
      entries.push(
        entry(
          "rx",
          chunk.subarray(error.offset),
          `split error: ${error.reason} at ${error.offset}`,
        ),
      );
    }
    append(entries, patch);
  };

  const onDisconnect = (): void => {
    stopListening();
    publish({ ...snapshot, state: "disconnected" });
  };

  const stopListening = (): void => {
    for (const off of unlisten) off();
    unlisten = [];
  };

  const send = async (bytes: Uint8Array, note: string): Promise<void> => {
    append([entry("tx", bytes, note)]);
    try {
      await transport.write(bytes);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      append([entry("tx", new Uint8Array(0), `write failed: ${reason}`)]);
    }
  };

  const connect = async (): Promise<void> => {
    if (snapshot.state !== "idle" && snapshot.state !== "disconnected") return;
    disconnectRequested = false;
    // First call, synchronously: the browser chooser needs the click's user gesture.
    const chosen = transport.requestDevice();
    publish({ ...snapshot, state: "choosing" });
    try {
      await chosen;
      startedAt = now();
      stopListening();
      unlisten = [transport.onNotify(onNotify), transport.onDisconnect(onDisconnect)];
      publish({ state: "connecting", log: [] });
      await transport.connect();
    } catch (err) {
      stopListening();
      publish({ ...snapshot, state: fromTransport(transport.state) });
      // The user asked to disconnect while connecting: a normal end, not an error.
      if (disconnectRequested && err instanceof TransportError && err.code === "cancelled") return;
      throw err;
    }
    publish({ ...snapshot, state: "connected" });
    await send(
      encodeHubProperty({
        type: "hubProperty",
        operation: "enableUpdates",
        property: "batteryPercent",
      }),
      "enableUpdates batteryPercent",
    );
    await send(
      encodeHubProperty({
        type: "hubProperty",
        operation: "requestUpdate",
        property: "advertisingName",
      }),
      "requestUpdate advertisingName",
    );
    await send(
      encodeHubProperty({
        type: "hubProperty",
        operation: "requestUpdate",
        property: "batteryPercent",
      }),
      "requestUpdate batteryPercent",
    );
  };

  const disconnect = async (): Promise<void> => {
    disconnectRequested = true;
    await transport.disconnect();
  };

  const exportLog = (): string => {
    const header = [
      "# mecahub hub probe log",
      "# origin: capturado (real hub, Web Bluetooth)",
      `# date: ${new Date().toISOString()}`,
      `# hub name: ${snapshot.name ?? "unknown"}`,
      '# format: +<ms since connect>ms <dir> <hex bytes>; "# ..." lines are notes',
    ];
    const lines = snapshot.log.flatMap((e) => {
      const time = `+${e.at}ms`;
      const frame = e.hex === "" ? [] : [`${time} ${e.dir} ${e.hex}`];
      const note =
        e.note === undefined ? [] : [e.hex === "" ? `# ${time} ${e.note}` : `# ${e.note}`];
      return [...frame, ...note];
    });
    return [...header, ...lines, ""].join("\n");
  };

  return {
    connect,
    disconnect,
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    exportLog,
  };
}
