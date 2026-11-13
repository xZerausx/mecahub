import { ColorId, encodePortInputFormatSetup, isColorId } from "@mecahub/lwp3";
import type { HubSession } from "./session.js";

// Output modes of the hub LED (io type 0x17), see lwp3 io-modes.ts.
const MODE_INDEX = 0;
const MODE_RGB = 1;

const isByte = (v: number) => Number.isInteger(v) && v >= 0 && v <= 255;

/**
 * The RGB LED inside the Move Hub (port 0x32). Each call writes one direct-mode frame (0x81 ...
 * 0x51, mode, data; 'derivado del layout' from node-poweredup hubled.ts and pylgbst
 * peripherals.py:232-260, never captured: TODO(hw)), "immediate" and without feedback. Both refs set
 * the port mode (0x41) before writing it, so this does too, when the mode changes. supuesto:
 * TODO(hw) whether the hub needs that at all. The setup is written without waiting for its 0x47
 * reply, so a hub that never answers it cannot hang the LED. Calls are written in order.
 */
export class HubLed {
  /**
   * The mode this link's port was last set to, so the 0x41 goes out only when it changes (what both
   * refs do: node-poweredup device.ts:147, pylgbst peripherals.py:98). TODO(hw): the setup may be
   * unnecessary for direct writes, or the hub may reject/ignore it on this port; either way the
   * write below does not depend on its reply. Reset on link loss, where the hub forgets the mode.
   */
  private mode: number | undefined;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly offEvents: () => void;

  constructor(
    private readonly session: HubSession,
    readonly port: number,
  ) {
    // The hub forgets the port mode with the link.
    this.offEvents = session.onEvent((event) => {
      if (event.kind === "link-lost") this.mode = undefined;
    });
  }

  /**
   * Shows a color of the LWP3 color table (`ColorId`). `ColorId.None` and `ColorId.Black` turn the
   * LED off (pylgbst peripherals.py:240-241). Rejects RangeError for any other number.
   */
  setColor(color: ColorId): Promise<void> {
    if (!isColorId(color)) return Promise.reject(new RangeError(`not a color id: ${color}`));
    return this.write(MODE_INDEX, [color]);
  }

  /** Shows an RGB color, each channel 0..255 (RangeError otherwise). */
  setRgb(r: number, g: number, b: number): Promise<void> {
    if (![r, g, b].every(isByte)) {
      return Promise.reject(new RangeError("rgb channels are integers 0..255"));
    }
    return this.write(MODE_RGB, [r, g, b]);
  }

  dispose(): void {
    this.offEvents();
  }

  private write(mode: number, data: number[]): Promise<void> {
    const run = async () => {
      if (this.mode !== mode) {
        await this.session.send(
          encodePortInputFormatSetup({
            type: "portInputFormatSetup",
            port: this.port,
            mode,
            deltaInterval: 1,
            notify: false,
          }),
        );
        this.mode = mode;
      }
      await this.session.portOutput({
        port: this.port,
        startup: "immediate",
        completion: "none",
        command: { sub: "writeDirectModeData", mode, data: Uint8Array.from(data) },
      });
    };
    const result = this.chain.then(run, run);
    this.chain = result.catch(() => undefined);
    return result;
  }
}
