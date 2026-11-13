import type { DecodedVersion } from "@mecahub/lwp3";
import { HubError } from "./errors.js";
import { fire } from "./listeners.js";
import type { HubSession } from "./session.js";

export interface PhysicalDevice {
  readonly kind: "physical";
  readonly port: number;
  /** Raw device type id: unknown types (like 0x42 on port 0x46) are kept, never an error. */
  readonly ioType: number;
  readonly hardwareVersion: DecodedVersion;
  readonly softwareVersion: DecodedVersion;
}

/** A virtual port that drives two physical ports as one (the Move Hub's A+B). */
export interface VirtualDevice {
  readonly kind: "virtual";
  /** Dynamic: assigned by the hub (0x10 in the capture); never hardcode it. */
  readonly port: number;
  readonly ioType: number;
  readonly portA: number;
  readonly portB: number;
}

export type PortDevice = PhysicalDevice | VirtualDevice;

export interface PortRegistryOptions {
  /**
   * The hub sends one Hub Attached I/O per port right after connecting and never says the burst is
   * over, so the registry is "ready" once no 0x04 has arrived for this long. Default 100 ms.
   * supuesto: the capture's frames came 4-5 ms apart (fixtures/2026-11-13-move-hub-connect.txt);
   * a slower adapter or hub could need more. TODO(hw)
   */
  readonly readyQuietMs?: number;
  /** `whenReady` rejects "timeout" if the hub announced nothing in this time. Default 3000 ms. */
  readonly readyTimeoutMs?: number;
}

type Timer = ReturnType<typeof setTimeout>;

interface ReadyWaiter {
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
  readonly timer: Timer;
}

/**
 * Ports of the Move Hub (set 17101): the four external connectors, and the internal RGB light and
 * tilt sensor. capturado: fixtures/2026-11-13-move-hub-connect.txt (0x32 and 0x3A attach there).
 */
export const MoveHubPort = { A: 0x00, B: 0x01, C: 0x02, D: 0x03, Led: 0x32, Tilt: 0x3a } as const;

/**
 * What is plugged into the hub, learned only from Hub Attached I/O (0x04) events. A link loss
 * clears it silently (the hub announces everything again on reconnect); detach events are for
 * devices that were unplugged.
 */
export class PortRegistry {
  private readonly byPort = new Map<number, PortDevice>();
  private readonly attachListeners = new Set<(device: PortDevice) => void>();
  private readonly detachListeners = new Set<(device: PortDevice) => void>();
  private readonly waiters: ReadyWaiter[] = [];
  private readonly quietMs: number;
  private readonly timeoutMs: number;
  private quietTimer: Timer | undefined;
  private isReady = false;
  private disposed = false;
  private readonly off: () => void;

  constructor(session: HubSession, options: PortRegistryOptions = {}) {
    this.quietMs = options.readyQuietMs ?? 100;
    this.timeoutMs = options.readyTimeoutMs ?? 3000;
    this.off = session.onEvent((event) => {
      if (event.kind === "link-lost") this.onLinkLost();
      else if (event.kind === "message" && event.message.type === "hubAttachedIo") {
        const m = event.message;
        if (m.event === "detached") this.onDetached(m.port);
        else {
          this.onAttached(
            m.event === "attached"
              ? {
                  kind: "physical",
                  port: m.port,
                  ioType: m.ioType,
                  hardwareVersion: m.hardwareVersion,
                  softwareVersion: m.softwareVersion,
                }
              : { kind: "virtual", port: m.port, ioType: m.ioType, portA: m.portA, portB: m.portB },
          );
        }
      }
    });
  }

  /** True once the connect burst of this link has gone quiet (see `readyQuietMs`). */
  get ready(): boolean {
    return this.isReady;
  }

  /** Resolves when `ready`; rejects "timeout", "link-lost" or "disposed". */
  whenReady(): Promise<void> {
    if (this.disposed) return Promise.reject(new HubError("disposed"));
    if (this.isReady) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const waiter: ReadyWaiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.drop(waiter);
          reject(new HubError("timeout", "the hub announced no ports"));
        }, this.timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  device(port: number): PortDevice | undefined {
    return this.byPort.get(port);
  }

  /** Every known device, by port number. */
  devices(): PortDevice[] {
    return [...this.byPort.values()].sort((a, b) => a.port - b.port);
  }

  /** The virtual port that combines A and B, if the hub announced one. */
  get virtualAb(): VirtualDevice | undefined {
    for (const d of this.byPort.values()) {
      if (d.kind === "virtual" && d.portA === MoveHubPort.A && d.portB === MoveHubPort.B) return d;
    }
    return undefined;
  }

  /** Fires for every attach, including the replacement of a device on a known port. */
  onAttach(listener: (device: PortDevice) => void): () => void {
    this.attachListeners.add(listener);
    return () => void this.attachListeners.delete(listener);
  }

  /** Fires with the device that was there. */
  onDetach(listener: (device: PortDevice) => void): () => void {
    this.detachListeners.add(listener);
    return () => void this.detachListeners.delete(listener);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.off();
    this.clearQuiet();
    this.failWaiters(() => new HubError("disposed"));
    this.byPort.clear();
    this.attachListeners.clear();
    this.detachListeners.clear();
  }

  private onAttached(device: PortDevice): void {
    this.byPort.set(device.port, device);
    this.restartQuiet();
    fire(this.attachListeners, device);
  }

  private onDetached(port: number): void {
    const device = this.byPort.get(port);
    this.restartQuiet();
    if (!device) return;
    this.byPort.delete(port);
    fire(this.detachListeners, device);
  }

  private onLinkLost(): void {
    this.clearQuiet();
    this.isReady = false;
    this.byPort.clear();
    this.failWaiters(() => new HubError("link-lost", "the link to the hub ended"));
  }

  private restartQuiet(): void {
    if (this.isReady) return; // later attaches are ordinary events
    this.clearQuiet();
    this.quietTimer = setTimeout(() => {
      this.quietTimer = undefined;
      this.isReady = true;
      for (const w of this.waiters.splice(0)) {
        clearTimeout(w.timer);
        w.resolve();
      }
    }, this.quietMs);
  }

  private clearQuiet(): void {
    if (this.quietTimer !== undefined) clearTimeout(this.quietTimer);
    this.quietTimer = undefined;
  }

  private drop(waiter: ReadyWaiter): void {
    const i = this.waiters.indexOf(waiter);
    if (i >= 0) this.waiters.splice(i, 1);
  }

  private failWaiters(reason: () => HubError): void {
    for (const w of this.waiters.splice(0)) {
      clearTimeout(w.timer);
      w.reject(reason());
    }
  }
}
