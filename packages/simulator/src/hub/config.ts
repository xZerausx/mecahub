import type { Version } from "@mecahub/lwp3";

/**
 * How a port's raw value bytes are laid out, so the delta interval can be applied per component.
 * supuesto: our own description (the hub does not report it and modes 0x43/0x44 are not modelled).
 * TODO(hw) derive it from real port mode info. Without it every byte is one unsigned component.
 */
export interface SimValueFormat {
  /** Components per value; `setSensor` needs exactly `count * width` bytes. */
  readonly count: number;
  /** Bytes per component, little-endian. */
  readonly width: 1 | 2 | 4;
  readonly signed: boolean;
}

/** A device attached to a physical port (external connector or internal device). */
export interface SimPortConfig {
  readonly port: number;
  /** Raw device type id: unknown types (like 0x42 on port 0x46) are valid. */
  readonly ioType: number;
  readonly hw: Version;
  readonly sw: Version;
  readonly valueFormat?: SimValueFormat;
  /** Motors only: speed at 100 %, in degrees per second. Default `DEFAULT_MAX_DEG_PER_SEC`. */
  readonly maxDegPerSec?: number;
}

/** A virtual port that combines two physical ports (e.g. motors A+B). */
export interface SimVirtualPortConfig {
  readonly port: number;
  readonly ioType: number;
  readonly portA: number;
  readonly portB: number;
  readonly valueFormat?: SimValueFormat;
}

export interface SimHubConfig {
  readonly name: string;
  /** 0..100. */
  readonly batteryPercent: number;
  readonly buttonPressed: boolean;
  /** Absent: the hub answers a request for this property with a generic error. */
  readonly firmwareVersion?: Version;
  readonly hardwareVersion?: Version;
  readonly ports: readonly SimPortConfig[];
  readonly virtualPorts: readonly SimVirtualPortConfig[];
  /**
   * Whether the hub stops all motors when the Bluetooth link ends. Default true. supuesto: the
   * real behaviour is unknown, TODO(hw) (docs/protocol-notes.md, write timeouts). When false the
   * motors keep ticking after the link is lost until they stop or `SimulatedHub.dispose()`.
   */
  readonly stopMotorsOnLinkLoss?: boolean;
  /**
   * How long after the link ends the hub notices and reacts to it (stops its motors). Default 0:
   * at once. supuesto: on real hardware a link that dies silently (a stalled write, no
   * LL_TERMINATE) may only be noticed after the BLE supervision timeout, seconds later, so link
   * loss must not be counted on as a fast STOP. TODO(hw)
   */
  readonly linkLossDetectionMs?: number;
}

const v = (major: number, minor: number, bugfix: number, build: number): Version => ({
  major,
  minor,
  bugfix,
  build,
});

/**
 * A Move Hub exactly as the first real capture saw it. Every value below is 'capturado' (see
 * fixtures/2026-11-13-move-hub-connect.txt). Firmware/hardware versions are not set: the capture never asked for those properties.
 */
export function defaultMoveHubConfig(): SimHubConfig {
  return {
    name: "Move Hub", // capturado: fixtures/2026-11-13-move-hub-connect.txt
    batteryPercent: 97, // capturado: fixtures/2026-11-13-move-hub-connect.txt (0x61)
    buttonPressed: false, // not captured: nobody pressed it; TODO(hw)
    ports: [
      // capturado: fixtures/2026-11-13-move-hub-connect.txt: external ports A and B (tacho motors) and C/D slot 0x03 (color & distance sensor)
      { port: 0x00, ioType: 0x27, hw: v(1, 0, 0, 0), sw: v(1, 0, 0, 0) },
      { port: 0x01, ioType: 0x27, hw: v(1, 0, 0, 0), sw: v(1, 0, 0, 0) },
      { port: 0x03, ioType: 0x25, hw: v(1, 0, 0, 0), sw: v(1, 0, 0, 0) },
      // capturado: fixtures/2026-11-13-move-hub-connect.txt: internal devices: RGB light, tilt, current, voltage and 0x46 (type 0x42, unmodelled)
      { port: 0x32, ioType: 0x17, hw: v(0, 1, 0, 0), sw: v(2, 0, 0, 6) },
      { port: 0x3a, ioType: 0x28, hw: v(1, 0, 0, 0), sw: v(0, 2, 1, 0) },
      { port: 0x3b, ioType: 0x15, hw: v(0, 0, 0, 2), sw: v(0, 0, 1, 0) },
      { port: 0x3c, ioType: 0x14, hw: v(0, 0, 0, 2), sw: v(0, 0, 1, 0) },
      { port: 0x46, ioType: 0x42, hw: v(0, 0, 0, 1), sw: v(1, 0, 0, 0) },
    ],
    // capturado: fixtures/2026-11-13-move-hub-connect.txt: virtual port 0x10 = 0x00 + 0x01 (the number is assigned by the hub, not fixed)
    virtualPorts: [{ port: 0x10, ioType: 0x27, portA: 0x00, portB: 0x01 }],
  };
}
