import { IoTypeId, getIoMode, type IoModeInfo } from "@mecahub/lwp3";
import type { SimValueFormat } from "./config.js";

/** Value layout of a mode in the lwp3 mode table, as the simulator's delta logic reads it. */
export function formatOfMode(info: IoModeInfo): SimValueFormat {
  return { count: info.count, width: info.width, signed: info.signed };
}

/**
 * Encodes components into the little-endian bytes of a mode (the inverse of `decodeModeValue`).
 * Throws RangeError for a component count or range the mode cannot carry.
 */
export function encodeModeValue(info: IoModeInfo, values: readonly number[]): Uint8Array {
  if (values.length !== info.count) {
    throw new RangeError(`mode ${info.mode} (${info.name}) takes ${info.count} component(s)`);
  }
  const bits = info.width * 8;
  const min = info.signed ? -(2 ** (bits - 1)) : 0;
  const max = info.signed ? 2 ** (bits - 1) - 1 : 2 ** bits - 1;
  const out = new Uint8Array(info.count * info.width);
  const view = new DataView(out.buffer);
  values.forEach((v, i) => {
    if (!Number.isInteger(v) || v < min || v > max) {
      throw new RangeError(
        `mode ${info.mode} (${info.name}) components are integers ${min}..${max}`,
      );
    }
    const at = i * info.width;
    if (info.width === 1) {
      if (info.signed) view.setInt8(at, v);
      else view.setUint8(at, v);
    } else if (info.width === 2) {
      if (info.signed) view.setInt16(at, v, true);
      else view.setUint16(at, v, true);
    } else if (info.signed) view.setInt32(at, v, true);
    else view.setUint32(at, v, true);
  });
  return out;
}

/**
 * What a sensor reports before anyone sets a value: a hub lying flat on a table with nothing in
 * front of its color & distance sensor. Only modes with a natural rest value are listed; the rest
 * report nothing until set.
 *
 * supuesto: TODO(hw) none of it is captured. 255 for "no color" is in both refs' color tables
 * (pylgbst peripherals.py:33, node-poweredup consts.ts:150); 10 inches stands for "nothing in
 * range" (the real sensor's maximum is not documented); mode 8 repeats modes 0 and 1.
 */
const DEFAULTS: Readonly<Record<number, Readonly<Record<number, readonly number[]>>>> = {
  [IoTypeId.InternalTilt]: { 0: [0, 0], 3: [0] },
  [IoTypeId.ColorDistanceSensor]: {
    0: [255],
    1: [10],
    2: [0],
    3: [0],
    4: [0],
    6: [0, 0, 0],
    8: [255, 10, 0, 0],
  },
};

export function defaultModeValue(ioType: number, mode: number): Uint8Array | undefined {
  const values = DEFAULTS[ioType]?.[mode];
  const info = getIoMode(ioType, mode);
  return values && info ? encodeModeValue(info, values) : undefined;
}
