import { Reader, Writer, guardReads } from "./bytes.js";
import { EndState, MessageType } from "./constants.js";
import { encodeFrame } from "./header.js";
import type {
  DecodeError,
  OutputCompletion,
  OutputStartup,
  PortOutputCommand,
  PortOutputCommandMessage,
  UseProfile,
} from "./messages.js";

const T = MessageType.PortOutputCommand;

/** Sub-command ids (doc 3.27). Other ids (0x0A, 0x0C, ...) decode as `unknown`. */
const SUB = {
  startPower: 0x01,
  startPower2: 0x02,
  startSpeed: 0x07,
  startSpeed2: 0x08,
  startSpeedForTime: 0x09,
  startSpeedForDegrees: 0x0b,
  gotoAbsolutePosition: 0x0d,
  writeDirectModeData: 0x51,
} as const;

const STARTUP: Record<OutputStartup, number> = { buffer: 0x0, immediate: 0x1 };
const COMPLETION: Record<OutputCompletion, number> = { none: 0x0, feedback: 0x1 };
const END_STATES: readonly number[] = Object.values(EndState);

// Encoder (strict, doc 3.27): StartSpeed takes -100..100 plus 126 (HOLD); the for-time/for-degrees
// forms take -100..100 only. FLOAT/BRAKE go through StartPower. The decoder accepts 126/127 in
// every speed field (isLenientSpeed) so the simulator survives apps that send them.
const isPlainSpeed = (v: number) => Number.isInteger(v) && v >= -100 && v <= 100;
const isSpeed = (v: number) => isPlainSpeed(v) || v === 126;
const isLenientSpeed = (v: number) => isPlainSpeed(v) || v === 126 || v === 127;
/** StartPower (doc 3.27): Int8 -100..100, 0 = FLOAT, 127 = BRAKE. */
const isPower = (v: number) => isPlainSpeed(v) || v === 127;
const isGotoSpeed = (v: number) => Number.isInteger(v) && v >= 1 && v <= 100;
const isMaxPower = (v: number) => Number.isInteger(v) && v >= 0 && v <= 100;
const isEndState = (v: number) => END_STATES.includes(v);
const isTime = (v: number) => Number.isInteger(v) && v >= 0 && v <= 0x7fff;
const isDegrees = (v: number) => Number.isInteger(v) && v >= 1 && v <= 0x7fffffff;

function need(v: number, ok: (v: number) => boolean, what: string): number {
  if (!ok(v)) throw new RangeError(`${what} out of range: ${v}`);
  return v;
}

function code(table: Record<string, number>, key: string): number {
  const v = table[key];
  if (v === undefined) throw new RangeError(`invalid option: ${key}`);
  return v;
}

const profileByte = (p: UseProfile) => (p.acc ? 0x01 : 0) | (p.dec ? 0x02 : 0);

// Recommended STOP command (doc 3.27.1 StartPower: "0: FLOAT ... 127: BRAKE"; speed commands
// cannot request either: "the user has to use either StartPower(0 or 127)"): startup
// "immediate" (do not queue behind buffered commands), completion "none", and
// `{sub: "startPower", power: 127}` (brake) on each motor port. For a virtual port use
// `startPower2`. Wire example, port 0: 07 00 81 00 10 01 7F.
// TODO(hw): useProfile handling on the Move Hub and time values above 32767 are untested.
/**
 * Encodes Port Output Command (doc 3.26), downstream. Throws RangeError on invalid fields.
 * Time is an Int16 and degrees an Int32 in the doc (pylgbst and node-poweredup write them
 * unsigned; the bytes are identical within the doc's ranges).
 */
export function encodePortOutputCommand(msg: Omit<PortOutputCommandMessage, "type">): Uint8Array {
  const c = msg.command;
  const w = new Writer()
    .u8(msg.port)
    .u8((code(STARTUP, msg.startup) << 4) | code(COMPLETION, msg.completion));
  if (c.sub === "unknown") return encodeFrame(T, w.u8(c.subCommand).bytes(c.payload).toBytes());
  w.u8(SUB[c.sub]);
  switch (c.sub) {
    case "startPower":
      return encodeFrame(T, w.i8(need(c.power, isPower, "power")).toBytes());
    case "startPower2":
      return encodeFrame(
        T,
        w
          .i8(need(c.power1, isPower, "power1"))
          .i8(need(c.power2, isPower, "power2"))
          .toBytes(),
      );
    case "startSpeed":
      w.i8(need(c.speed, isSpeed, "speed"));
      break;
    case "startSpeed2":
      w.i8(need(c.speed1, isSpeed, "speed1")).i8(need(c.speed2, isSpeed, "speed2"));
      break;
    case "startSpeedForTime":
      w.i16(need(c.time, isTime, "time")).i8(need(c.speed, isPlainSpeed, "speed"));
      break;
    case "startSpeedForDegrees":
      w.i32(need(c.degrees, isDegrees, "degrees")).i8(need(c.speed, isPlainSpeed, "speed"));
      break;
    case "gotoAbsolutePosition":
      w.i32(c.absPos).i8(need(c.speed, isGotoSpeed, "speed"));
      break;
    case "writeDirectModeData":
      return encodeFrame(T, w.u8(c.mode).bytes(c.data).toBytes());
  }
  w.u8(need(c.maxPower, isMaxPower, "maxPower"));
  if ("endState" in c) w.u8(need(c.endState, isEndState, "endState"));
  w.u8(profileByte(c.useProfile));
  return encodeFrame(T, w.toBytes());
}

/** A field read fine but holds a value the doc does not allow. `offset` is payload-relative. */
class BadField extends Error {
  constructor(readonly offset: number) {
    super(`bad field at offset ${offset}`);
  }
}

function field(r: Reader, read: () => number, ok: (v: number) => boolean): number {
  const at = r.offset;
  const v = read();
  if (!ok(v)) throw new BadField(at);
  return v;
}

function readProfile(r: Reader): UseProfile {
  const at = r.offset;
  const v = r.u8();
  if ((v & ~0x03) !== 0) throw new BadField(at);
  return { acc: (v & 0x01) !== 0, dec: (v & 0x02) !== 0 };
}

function readCommand(r: Reader): PortOutputCommand {
  const sub = r.u8();
  switch (sub) {
    case SUB.startPower:
      return { sub: "startPower", power: field(r, () => r.i8(), isPower) };
    case SUB.startPower2:
      return {
        sub: "startPower2",
        power1: field(r, () => r.i8(), isPower),
        power2: field(r, () => r.i8(), isPower),
      };
    case SUB.startSpeed:
      return {
        sub: "startSpeed",
        speed: field(r, () => r.i8(), isLenientSpeed),
        maxPower: field(r, () => r.u8(), isMaxPower),
        useProfile: readProfile(r),
      };
    case SUB.startSpeed2:
      return {
        sub: "startSpeed2",
        speed1: field(r, () => r.i8(), isLenientSpeed),
        speed2: field(r, () => r.i8(), isLenientSpeed),
        maxPower: field(r, () => r.u8(), isMaxPower),
        useProfile: readProfile(r),
      };
    case SUB.startSpeedForTime:
      return {
        sub: "startSpeedForTime",
        time: r.u16(),
        speed: field(r, () => r.i8(), isLenientSpeed),
        maxPower: field(r, () => r.u8(), isMaxPower),
        endState: field(r, () => r.u8(), isEndState) as EndState,
        useProfile: readProfile(r),
      };
    case SUB.startSpeedForDegrees:
      return {
        sub: "startSpeedForDegrees",
        degrees: r.u32(),
        speed: field(r, () => r.i8(), isLenientSpeed),
        maxPower: field(r, () => r.u8(), isMaxPower),
        endState: field(r, () => r.u8(), isEndState) as EndState,
        useProfile: readProfile(r),
      };
    case SUB.gotoAbsolutePosition:
      return {
        sub: "gotoAbsolutePosition",
        absPos: r.i32(),
        speed: field(r, () => r.i8(), isGotoSpeed),
        maxPower: field(r, () => r.u8(), isMaxPower),
        endState: field(r, () => r.u8(), isEndState) as EndState,
        useProfile: readProfile(r),
      };
    case SUB.writeDirectModeData:
      return { sub: "writeDirectModeData", mode: r.u8(), data: r.rest() };
    default:
      return { sub: "unknown", subCommand: sub, payload: r.rest() };
  }
}

const nibble = <K extends string>(v: number, names: Record<K, number>, at: number): K => {
  const key = (Object.keys(names) as K[]).find((k) => names[k] === v);
  if (key === undefined) throw new BadField(at);
  return key;
};

/** Decodes the payload of a Port Output Command (doc 3.26). Unmodelled sub-commands are `unknown`. */
export function decodePortOutputCommand(
  payload: Uint8Array,
): PortOutputCommandMessage | DecodeError {
  try {
    return guardReads(T, () => {
      const r = new Reader(payload);
      const port = r.u8();
      const sc = r.u8();
      return {
        type: "portOutputCommand",
        port,
        startup: nibble(sc >> 4, STARTUP, 1),
        completion: nibble(sc & 0x0f, COMPLETION, 1),
        command: readCommand(r),
      } as const;
    });
  } catch (e) {
    if (e instanceof BadField) {
      return { kind: "error", reason: "bad-field", messageType: T, offset: e.offset };
    }
    throw e;
  }
}
