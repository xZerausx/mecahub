export interface Version {
  readonly major: number;
  readonly minor: number;
  readonly bugfix: number;
  readonly build: number;
}

const isBcd = (v: number, digits: number): boolean => {
  for (let i = 0; i < digits; i++) if (((v >> (4 * i)) & 0xf) > 9) return false;
  return true;
};

const fromBcd = (v: number, digits: number): number => {
  let out = 0;
  for (let i = digits - 1; i >= 0; i--) out = out * 10 + ((v >> (4 * i)) & 0xf);
  return out;
};

const toBcd = (v: number, digits: number): number => {
  let out = 0;
  for (let i = 0; i < digits; i++) out |= (Math.floor(v / 10 ** i) % 10) << (4 * i);
  return out;
};

export interface DecodedVersion extends Version {
  /** The Int32 exactly as received. */
  readonly raw: number;
  /** False when bit 31 is set or any bug-fix/build/minor nibble is > 9; fields are then raw nibble values. */
  readonly bcd: boolean;
}

/**
 * Decodes the Int32 of doc 3.5.6: `0MMM mmmm | BBBB BBBB | bbbb bbbb bbbb bbbb`
 * (bug-fix and build are BCD). Lenient: never fails. When the value is not valid BCD
 * (or bit 31 is set) `bcd` is false and the fields combine the raw nibble values in base 10.
 */
export function decodeVersion(raw: number): DecodedVersion {
  const minor = (raw >> 24) & 0xf;
  const bugfix = (raw >> 16) & 0xff;
  const build = raw & 0xffff;
  // TODO(hw): behaviour of real hubs on non-BCD values is unverified
  const bcd = raw >= 0 && minor <= 9 && isBcd(bugfix, 2) && isBcd(build, 4);
  return {
    raw,
    bcd,
    major: (raw >> 28) & 0x7,
    minor,
    bugfix: fromBcd(bugfix, 2),
    build: fromBcd(build, 4),
  };
}

/** Inverse of decodeVersion. Throws RangeError when a field does not fit its layout. */
export function encodeVersion({ major, minor, bugfix, build }: Version): number {
  const fits = (v: number, max: number) => Number.isInteger(v) && v >= 0 && v <= max;
  if (!fits(major, 7) || !fits(minor, 9) || !fits(bugfix, 99) || !fits(build, 9999)) {
    throw new RangeError("version field out of range");
  }
  return ((major << 28) | (minor << 24) | (toBcd(bugfix, 2) << 16) | toBcd(build, 4)) >>> 0;
}
