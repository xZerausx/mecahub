/** Thrown by Reader when a read goes past the end of the buffer. Internal to decoders. */
export class ReaderRangeError extends RangeError {
  readonly offset: number;
  constructor(offset: number) {
    super(`read past end of buffer at offset ${offset}`);
    this.name = "ReaderRangeError";
    this.offset = offset;
  }
}

/** Bounds-checked cursor over bytes. Multibyte values are little-endian. */
export class Reader {
  private readonly view: DataView;
  private pos: number;

  constructor(
    private readonly data: Uint8Array,
    start = 0,
  ) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    this.pos = start;
  }

  get offset(): number {
    return this.pos;
  }

  get remaining(): number {
    return Math.max(0, this.data.length - this.pos);
  }

  private take(n: number): number {
    if (this.pos + n > this.data.length) throw new ReaderRangeError(this.pos);
    const at = this.pos;
    this.pos += n;
    return at;
  }

  u8(): number {
    return this.view.getUint8(this.take(1));
  }
  i8(): number {
    return this.view.getInt8(this.take(1));
  }
  u16(): number {
    return this.view.getUint16(this.take(2), true);
  }
  i16(): number {
    return this.view.getInt16(this.take(2), true);
  }
  u32(): number {
    return this.view.getUint32(this.take(4), true);
  }
  i32(): number {
    return this.view.getInt32(this.take(4), true);
  }
  f32(): number {
    return this.view.getFloat32(this.take(4), true);
  }

  /** MAC address: the doc (3.5.5 note G) says big-endian, i.e. bytes in display order. */
  mac(): number[] {
    const at = this.take(6);
    return Array.from(this.data.subarray(at, at + 6));
  }

  /** Consumes and returns every remaining byte. */
  rest(): Uint8Array {
    const at = this.take(this.remaining);
    return this.data.slice(at);
  }
}

function checked(value: number, min: number, max: number, kind: string): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${kind} out of range: ${value}`);
  }
  return value;
}

/** Growable little-endian writer. Throws RangeError on out-of-range input. */
export class Writer {
  private readonly out: number[] = [];

  u8(v: number): this {
    this.out.push(checked(v, 0, 0xff, "u8"));
    return this;
  }
  i8(v: number): this {
    return this.u8(checked(v, -0x80, 0x7f, "i8") & 0xff);
  }
  u16(v: number): this {
    checked(v, 0, 0xffff, "u16");
    return this.u8(v & 0xff).u8(v >> 8);
  }
  i16(v: number): this {
    return this.u16(checked(v, -0x8000, 0x7fff, "i16") & 0xffff);
  }
  u32(v: number): this {
    checked(v, 0, 0xffffffff, "u32");
    return this.u16(v & 0xffff).u16(v >>> 16);
  }
  i32(v: number): this {
    return this.u32(checked(v, -0x80000000, 0x7fffffff, "i32") >>> 0);
  }
  f32(v: number): this {
    const view = new DataView(new ArrayBuffer(4));
    view.setFloat32(0, v, true);
    return this.bytes(new Uint8Array(view.buffer));
  }
  bytes(b: ArrayLike<number>): this {
    for (let i = 0; i < b.length; i++) this.u8(b[i] as number);
    return this;
  }

  toBytes(): Uint8Array {
    return Uint8Array.from(this.out);
  }
}
