import { IoTypeId } from "./constants.js";
import { readPortValue } from "./port-value.js";
import type { PortValueKind } from "./port-value.js";

/**
 * Layout of one port mode of an io type: what a Port Value (0x45) carries once the port is set to
 * that mode. The hub does not announce it in a way the codec reads yet (Port Mode Information,
 * 0x44, is not modelled), so it is tabled here.
 */
export interface IoModeInfo {
  readonly mode: number;
  readonly name: string;
  /** Components per value. */
  readonly count: number;
  /** Bytes per component, little-endian. */
  readonly width: 1 | 2 | 4;
  readonly signed: boolean;
  /** Unit of the RAW components (no scaling applied). */
  readonly unit: string;
  /** "output": a mode written with direct mode data; the hub is not expected to report it. */
  readonly access: "input" | "output";
  /** `library/file:line` of where the layout comes from (refs cloned for the project, never copied). */
  readonly refs: readonly string[];
  /** Conflicts between refs, or caveats. */
  readonly note?: string;
}

const PL = "pylgbst/peripherals.py";
const NP = "node-poweredup/src/devices";

// Every entry is 'derivado del layout': built from the reference libraries' decoders and cross-checked
// where two of them cover the mode (pybricksdev has no per-device mode table, so it is not a source).
// No 0x45 value has been captured on a real hub: all of it is TODO(hw), and a capture wins over this
// table (ADR 0002). Only layouts with a known width are listed: motor mode 0 (power, "returns some
// numbers", pylgbst peripherals.py:486) and mode 3 ("exists, but neither input nor output mode",
// :489) are left out on purpose.
const motor: readonly IoModeInfo[] = [
  {
    mode: 1,
    name: "speed",
    count: 1,
    width: 1,
    signed: true,
    unit: "percent",
    access: "input",
    // node-poweredup tachomotor.ts only models mode 2.
    refs: [`${PL}:487`, `${PL}:545`],
  },
  {
    mode: 2,
    name: "position",
    count: 1,
    width: 4,
    signed: true,
    unit: "degrees",
    access: "input",
    refs: [`${PL}:488`, `${PL}:542`, `${NP}/tachomotor.ts:168`, `${NP}/tachomotor.ts:28`],
  },
];

// pylgbst's tilt modes are shared by the external (0x22) and internal (0x28) tilt sensors; only mode 0
// is cross-checked (node-poweredup movehubtiltsensor.ts models just mode 0). Its numbering of modes
// 1..3 differs from node-poweredup's for the WeDo 0x22 sensor (tiltsensor.ts:112-117), so 1..7 are
// single-ref and unverified for the Move Hub's 0x28.
const tilt: readonly IoModeInfo[] = [
  {
    mode: 0,
    name: "angle (2 axes)",
    count: 2,
    width: 1,
    signed: true,
    unit: "degrees",
    access: "input",
    refs: [
      `${PL}:571`,
      `${PL}:615`,
      `${NP}/movehubtiltsensor.ts:38`,
      `${NP}/movehubtiltsensor.ts:29`,
    ],
    note: "Order and sign: pylgbst reads (roll, pitch) as is; node-poweredup reads (x, y) with x negated (movehubtiltsensor.ts:29). Same bytes, different interpretation; not decided here.",
  },
  {
    mode: 1,
    name: "orientation (2 axes, simple)",
    count: 1,
    width: 1,
    signed: false,
    unit: "state id",
    access: "input",
    refs: [`${PL}:572`, `${PL}:622`],
  },
  {
    mode: 2,
    name: "orientation (3 axes, simple)",
    count: 1,
    width: 1,
    signed: false,
    unit: "state id",
    access: "input",
    refs: [`${PL}:573`, `${PL}:619`],
  },
  {
    mode: 3,
    name: "impact count",
    count: 1,
    width: 4,
    signed: false,
    unit: "impacts",
    access: "input",
    refs: [`${PL}:574`, `${PL}:625`],
  },
  {
    mode: 4,
    name: "acceleration (3 axes)",
    count: 3,
    width: 1,
    signed: true,
    unit: "raw",
    access: "input",
    refs: [`${PL}:575`, `${PL}:628`],
    note: "pylgbst itself doubts the axis order (peripherals.py:631).",
  },
  {
    mode: 5,
    name: "orientation (config)",
    count: 1,
    width: 1,
    signed: false,
    unit: "state id",
    access: "input",
    refs: [`${PL}:576`, `${PL}:633`],
  },
  {
    mode: 6,
    name: "impact (config)",
    count: 1,
    width: 1,
    signed: false,
    unit: "state id",
    access: "input",
    refs: [`${PL}:577`, `${PL}:636`],
  },
  {
    mode: 7,
    name: "calibration",
    count: 3,
    width: 1,
    signed: false,
    unit: "raw",
    access: "input",
    refs: [`${PL}:578`, `${PL}:639`],
  },
];

const colorDistance: readonly IoModeInfo[] = [
  {
    mode: 0,
    name: "color",
    count: 1,
    width: 1,
    signed: false,
    unit: "color id",
    access: "input",
    refs: [
      `${PL}:650`,
      `${PL}:671`,
      `${NP}/colordistancesensor.ts:279`,
      `${NP}/colordistancesensor.ts:22`,
    ],
  },
  {
    mode: 1,
    name: "distance",
    count: 1,
    width: 1,
    signed: false,
    unit: "inches",
    access: "input",
    refs: [
      `${PL}:651`,
      `${PL}:681`,
      `${NP}/colordistancesensor.ts:280`,
      `${NP}/colordistancesensor.ts:36`,
    ],
    note: "node-poweredup converts to millimetres as floor(inches * 25.4) - 20 (colordistancesensor.ts:41).",
  },
  {
    mode: 2,
    name: "detection count",
    count: 1,
    width: 4,
    signed: false,
    unit: "count",
    access: "input",
    refs: [
      `${PL}:652`,
      `${PL}:690`,
      `${NP}/colordistancesensor.ts:281`,
      `${NP}/colordistancesensor.ts:65`,
    ],
  },
  {
    mode: 3,
    name: "reflected light",
    count: 1,
    width: 1,
    signed: false,
    unit: "percent",
    access: "input",
    refs: [
      `${PL}:653`,
      `${PL}:684`,
      `${NP}/colordistancesensor.ts:282`,
      `${NP}/colordistancesensor.ts:79`,
    ],
    note: "pylgbst divides by 100 (0..1.0), node-poweredup keeps 0..100: same bytes.",
  },
  {
    mode: 4,
    name: "ambient light",
    count: 1,
    width: 1,
    signed: false,
    unit: "percent",
    access: "input",
    refs: [
      `${PL}:654`,
      `${PL}:687`,
      `${NP}/colordistancesensor.ts:283`,
      `${NP}/colordistancesensor.ts:93`,
    ],
    note: "pylgbst divides by 100 (0..1.0), node-poweredup keeps 0..100: same bytes.",
  },
  {
    mode: 5,
    name: "led color",
    count: 1,
    width: 1,
    signed: false,
    unit: "color id",
    access: "output",
    refs: [`${PL}:655`, `${PL}:720`, `${NP}/colordistancesensor.ts:284`],
  },
  {
    mode: 6,
    name: "rgb intensity",
    count: 3,
    width: 2,
    signed: false,
    unit: "raw (0..1023)",
    access: "input",
    refs: [
      `${PL}:656`,
      `${PL}:693`,
      `${NP}/colordistancesensor.ts:285`,
      `${NP}/colordistancesensor.ts:111`,
    ],
    note: "pylgbst scales by 255/1023 (peripherals.py:694); node-poweredup keeps the raw u16.",
  },
  {
    mode: 7,
    name: "infrared tx",
    count: 1,
    width: 2,
    signed: false,
    unit: "raw (0..65535)",
    access: "output",
    refs: [`${PL}:657`, `${PL}:729`, `${NP}/colordistancesensor.ts:286`],
  },
  {
    mode: 8,
    name: "color and distance",
    count: 4,
    width: 1,
    signed: false,
    unit: "color id, inches, unused, divisor",
    access: "input",
    refs: [
      `${PL}:658`,
      `${PL}:674`,
      `${NP}/colordistancesensor.ts:287`,
      `${NP}/colordistancesensor.ts:125`,
    ],
    note: "Components: [color, whole inches, ?, partial]; distance = whole + 1/partial when partial > 0 (pylgbst :677-679, node-poweredup :130-135). Component 2 is not read by either.",
  },
  {
    mode: 9,
    name: "debug",
    count: 2,
    width: 2,
    signed: false,
    unit: "raw",
    access: "input",
    refs: [`${PL}:660`, `${PL}:698`],
    note: "pylgbst: first value is ambient light, second zero; it scales each raw u16 by 10/1023 (peripherals.py:698-700). Single ref.",
  },
  {
    mode: 10,
    name: "calibration",
    count: 8,
    width: 2,
    signed: false,
    unit: "raw",
    access: "input",
    refs: [`${PL}:661`, `${PL}:702`],
    note: "pylgbst: constant values. Single ref.",
  },
];

const current: readonly IoModeInfo[] = [
  {
    mode: 0,
    name: "current (long)",
    count: 1,
    width: 2,
    signed: false,
    unit: "raw ADC (0..4095)",
    access: "input",
    refs: [`${PL}:812`, `${PL}:819`, `${NP}/currentsensor.ts:49`, `${NP}/currentsensor.ts:34`],
    note: "Scale agrees: mA = raw * 2444 / 4095 (pylgbst :820, node-poweredup currentsensor.ts:58,63). pylgbst names mode 1 CURRENT_S (:813); not listed, its layout is not decoded by either ref.",
  },
];

const voltage: readonly IoModeInfo[] = [
  {
    mode: 0,
    name: "voltage (long)",
    count: 1,
    width: 2,
    signed: false,
    unit: "raw ADC (0..3893)",
    access: "input",
    refs: [`${PL}:787`, `${PL}:795`, `${NP}/voltagesensor.ts:49`, `${NP}/voltagesensor.ts:34`],
    note: "Scale conflict: pylgbst V = raw * 9600 / 3893 / 1000 (peripherals.py:796, full scale 9.6 V); node-poweredup full scale 9.615 V over the same 3893 (voltagesensor.ts:58,64). Unresolved, TODO(hw). pylgbst names mode 1 VOLTAGE_S (:788); not listed.",
  },
];

const hubLed: readonly IoModeInfo[] = [
  {
    mode: 0,
    name: "color index",
    count: 1,
    width: 1,
    signed: false,
    unit: "color id",
    access: "output",
    refs: [`${PL}:226`, `${PL}:261`, `${NP}/hubled.ts:65`],
  },
  {
    mode: 1,
    name: "rgb",
    count: 3,
    width: 1,
    signed: false,
    unit: "raw (0..255)",
    access: "output",
    refs: [`${PL}:227`, `${PL}:248`, `${NP}/hubled.ts:66`],
  },
];

/** Known port modes per io type id (Move Hub and its external devices). */
export const IO_MODES: Readonly<Record<number, readonly IoModeInfo[]>> = {
  [IoTypeId.ExternalMotorWithTacho]: motor,
  [IoTypeId.InternalMotorWithTacho]: motor,
  [IoTypeId.RgbLight]: hubLed,
  [IoTypeId.InternalTilt]: tilt,
  [IoTypeId.ColorDistanceSensor]: colorDistance,
  [IoTypeId.Current]: current,
  [IoTypeId.Voltage]: voltage,
};

/** All known modes of an io type; empty for a type the table does not know (never an error). */
export function getIoModes(ioType: number): readonly IoModeInfo[] {
  return IO_MODES[ioType] ?? [];
}

export function getIoMode(ioType: number, mode: number): IoModeInfo | undefined {
  return getIoModes(ioType).find((m) => m.mode === mode);
}

function kindOf(info: IoModeInfo): PortValueKind {
  if (info.width === 1) return info.signed ? "i8" : "u8";
  if (info.width === 2) return info.signed ? "i16" : "u16";
  return info.signed ? "i32" : "u32";
}

/**
 * Splits the raw bytes of a Port Value (0x45) into the raw components of its mode (no scaling).
 * Undefined for an unknown io type or mode, or when the length is not exactly `count * width`: a
 * value that was in flight when the mode changed (node-poweredup skips those by length too,
 * colordistancesensor.ts:61,107) must not be misread.
 */
export function decodeModeValue(
  ioType: number,
  mode: number,
  raw: Uint8Array,
): number[] | undefined {
  const info = getIoMode(ioType, mode);
  if (!info || raw.length !== info.count * info.width) return undefined;
  const kind = kindOf(info);
  const out: number[] = [];
  for (let i = 0; i < info.count; i++) {
    const v = readPortValue(raw.subarray(i * info.width), kind);
    if (v === undefined) return undefined;
    out.push(v);
  }
  return out;
}
