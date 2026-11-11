import { Reader, Writer, guardReads } from "./bytes.js";
import { MessageType } from "./constants.js";
import { encodeFrame } from "./header.js";
import type { DecodeError, HubAttachedIoMessage } from "./messages.js";
import { decodeVersion, encodeVersion } from "./version.js";
import type { Version } from "./version.js";

const T = MessageType.HubAttachedIo;

const EVENT = { detached: 0x00, attached: 0x01, attachedVirtual: 0x02 } as const;

/** Encodes a Hub Attached I/O frame (upstream; used by simulators). */
export function encodeHubAttachedIo(msg: HubAttachedIoMessage<Version>): Uint8Array {
  const w = new Writer().u8(msg.port).u8(EVENT[msg.event]);
  switch (msg.event) {
    case "detached":
      break;
    case "attached":
      w.u16(msg.ioType)
        .i32(encodeVersion(msg.hardwareVersion))
        .i32(encodeVersion(msg.softwareVersion));
      break;
    case "attachedVirtual":
      w.u16(msg.ioType).u8(msg.portA).u8(msg.portB);
      break;
  }
  return encodeFrame(T, w.toBytes());
}

/** Decodes the payload (after the common header) of a Hub Attached I/O message (doc 3.8). */
export function decodeHubAttachedIo(payload: Uint8Array): HubAttachedIoMessage | DecodeError {
  return guardReads(T, () => {
    const r = new Reader(payload);
    const port = r.u8();
    const event = r.u8();
    switch (event) {
      case EVENT.detached:
        return { type: "hubAttachedIo", event: "detached", port } as const;
      case EVENT.attached:
        return {
          type: "hubAttachedIo",
          event: "attached",
          port,
          ioType: r.u16(),
          hardwareVersion: decodeVersion(r.i32()),
          softwareVersion: decodeVersion(r.i32()),
        } as const;
      case EVENT.attachedVirtual:
        return {
          type: "hubAttachedIo",
          event: "attachedVirtual",
          port,
          ioType: r.u16(),
          portA: r.u8(),
          portB: r.u8(),
        } as const;
      default:
        return { kind: "error", reason: "bad-field", messageType: T, offset: 1 } as const;
    }
  });
}
