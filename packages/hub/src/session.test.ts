import {
  ErrorCode,
  MessageType,
  encodeGenericError,
  encodeHubAttachedIo,
  encodePortInputFormat,
  encodePortInputFormatSetup,
  encodePortOutputCommand,
  encodePortOutputFeedback,
  encodePortValueSingle,
} from "@mecahub/lwp3";
import type { PortOutputCommandMessage } from "@mecahub/lwp3";
import { SimulatedHub, SimulatorTransport, defaultMoveHubConfig } from "@mecahub/simulator";
import { FakeTransport, TransportError } from "@mecahub/transport";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HubError } from "./errors.js";
import { HubSession } from "./session.js";
import type { SessionEvent } from "./session.js";

// Vector origin: every frame is built with the lwp3 encoders from the doc layouts ('derivado del
// layout', docs 3.9, 3.17, 3.23, 3.26, 3.32); none is a hub capture. The feedback flag values
// (0x01 in progress, 0x02 completed, 0x04 discarded, 0x08 idle, 0x0A completed + idle) are doc 3.32.
const A = 0x00;
const B = 0x01;
const profile = { acc: false, dec: false };

const timed = (
  port: number,
  completion: "none" | "feedback" = "feedback",
  startup: "buffer" | "immediate" = "immediate",
): Omit<PortOutputCommandMessage, "type"> => ({
  port,
  startup,
  completion,
  command: {
    sub: "startSpeedForTime",
    time: 100,
    speed: 50,
    maxPower: 100,
    endState: 127,
    useProfile: profile,
  },
});

const fb = (port: number, flags: number) => encodePortOutputFeedback({ ports: [{ port, flags }] });

async function ready() {
  const transport = new FakeTransport();
  await transport.requestDevice();
  await transport.connect();
  const session = new HubSession(transport);
  const events: SessionEvent[] = [];
  session.onEvent((e) => events.push(e));
  return { transport, session, events };
}

const settled = (p: Promise<unknown>) =>
  p.then(
    (v) => ({ ok: true as const, v }),
    (e: unknown) => ({ ok: false as const, e }),
  );

afterEach(() => vi.useRealTimers());

describe("HubSession: inbound", () => {
  it("splits a notification into frames and dispatches each one as a typed message, in order", async () => {
    const { transport, events } = await ready();
    const attached = encodeHubAttachedIo({
      type: "hubAttachedIo",
      event: "detached",
      port: 3,
    });
    const err = encodeGenericError({ commandType: 0x01, code: ErrorCode.InvalidUse });
    transport.emitNotify(Uint8Array.of(...attached, ...err));
    expect(events.map((e) => (e.kind === "message" ? e.message.type : e.kind))).toEqual([
      "hubAttachedIo",
      "genericError",
    ]);
  });

  it("surfaces a malformed frame as a decode-error event, never throws, and keeps going", async () => {
    const { transport, events } = await ready();
    // 0x45 with no value byte: header ok, payload too short (see lwp3 port-value.test.ts)
    const bad = Uint8Array.of(0x04, 0x00, 0x45, 0x00);
    const good = encodeGenericError({ commandType: 0x01, code: 1 });
    expect(() => transport.emitNotify(Uint8Array.of(...bad, ...good))).not.toThrow();
    expect(events.map((e) => e.kind)).toEqual(["decode-error", "message"]);
    const first = events[0];
    expect(first?.kind === "decode-error" && first.error.reason).toBe("payload-too-short");
    expect(first?.kind === "decode-error" && first.frame).toEqual(bad);
  });

  it("surfaces a truncated chunk as a framing-error event after the frames before it", async () => {
    const { transport, events } = await ready();
    const good = encodeGenericError({ commandType: 0x01, code: 1 });
    transport.emitNotify(Uint8Array.of(...good, 0x09, 0x00, 0x04));
    expect(events.map((e) => e.kind)).toEqual(["message", "framing-error"]);
  });

  it("an unsubscribed listener hears nothing more", async () => {
    const { transport, session } = await ready();
    const heard: SessionEvent[] = [];
    const off = session.onEvent((e) => heard.push(e));
    off();
    transport.emitNotify(encodeGenericError({ commandType: 1, code: 1 }));
    expect(heard).toEqual([]);
  });

  it("a link loss emits link-lost once", async () => {
    const { transport, events } = await ready();
    transport.emitDisconnect();
    expect(events.filter((e) => e.kind === "link-lost")).toHaveLength(1);
  });
});

describe("HubSession.send", () => {
  it("writes the bytes with the given priority", async () => {
    const { transport, session } = await ready();
    const spy = vi.spyOn(transport, "write");
    const bytes = Uint8Array.of(1, 2, 3);
    await session.send(bytes, { priority: "urgent" });
    await session.send(bytes);
    expect(spy.mock.calls[0]?.[1]).toEqual({ priority: "urgent" });
    expect(spy.mock.calls[1]?.[1]?.priority ?? "normal").toBe("normal");
    expect(transport.writes).toHaveLength(2);
  });
});

describe("HubSession.setInputFormat", () => {
  it("writes 0x41 and resolves on the matching 0x47", async () => {
    const { transport, session } = await ready();
    const p = session.setInputFormat(A, 2, 1, true);
    await vi.waitFor(() => expect(transport.writes).toHaveLength(1));
    expect(transport.writes[0]).toEqual(
      encodePortInputFormatSetup({
        type: "portInputFormatSetup",
        port: A,
        mode: 2,
        deltaInterval: 1,
        notify: true,
      }),
    );
    // another port's reply and another mode's reply are not ours
    transport.emitNotify(
      encodePortInputFormat({
        type: "portInputFormat",
        port: B,
        mode: 2,
        deltaInterval: 1,
        notify: true,
      }),
    );
    transport.emitNotify(
      encodePortInputFormat({
        type: "portInputFormat",
        port: A,
        mode: 1,
        deltaInterval: 1,
        notify: true,
      }),
    );
    let done = false;
    void p.then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);
    transport.emitNotify(
      encodePortInputFormat({
        type: "portInputFormat",
        port: A,
        mode: 2,
        deltaInterval: 1,
        notify: true,
      }),
    );
    await expect(p).resolves.toEqual({
      type: "portInputFormat",
      port: A,
      mode: 2,
      deltaInterval: 1,
      notify: true,
    });
  });

  it("rejects with 'rejected' on a generic error for 0x41", async () => {
    const { transport, session } = await ready();
    const p = settled(session.setInputFormat(A, 2, 1, true));
    await vi.waitFor(() => expect(transport.writes).toHaveLength(1));
    transport.emitNotify(
      encodeGenericError({
        commandType: MessageType.PortInputFormatSetupSingle,
        code: ErrorCode.InvalidUse,
      }),
    );
    const r = await p;
    expect(!r.ok && r.e).toBeInstanceOf(HubError);
    expect(!r.ok && (r.e as HubError).code).toBe("rejected");
    expect(!r.ok && (r.e as HubError).hubError).toEqual({
      type: "genericError",
      commandType: 0x41,
      code: ErrorCode.InvalidUse,
    });
  });

  it("ignores a generic error for another command", async () => {
    const { transport, session } = await ready();
    const p = session.setInputFormat(A, 2, 1, true);
    await vi.waitFor(() => expect(transport.writes).toHaveLength(1));
    transport.emitNotify(encodeGenericError({ commandType: 0x81, code: ErrorCode.InvalidUse }));
    transport.emitNotify(
      encodePortInputFormat({
        type: "portInputFormat",
        port: A,
        mode: 2,
        deltaInterval: 1,
        notify: true,
      }),
    );
    await expect(p).resolves.toMatchObject({ port: A });
  });

  it("rejects with 'timeout' when the hub never answers", async () => {
    vi.useFakeTimers();
    const transport = new FakeTransport();
    await transport.requestDevice();
    await transport.connect();
    const session = new HubSession(transport, { requestTimeoutMs: 500 });
    const p = settled(session.setInputFormat(A, 2, 1, true));
    await vi.advanceTimersByTimeAsync(499);
    await vi.advanceTimersByTimeAsync(1);
    const r = await p;
    expect(!r.ok && (r.e as HubError).code).toBe("timeout");
  });

  it("rejects with the transport error when the write fails, and forgets the request", async () => {
    const { transport, session } = await ready();
    transport.emitDisconnect();
    const r = await settled(session.setInputFormat(A, 2, 1, true));
    expect(!r.ok && r.e).toBeInstanceOf(TransportError);
  });

  it("rejects with 'link-lost' when the link drops while waiting", async () => {
    const { transport, session } = await ready();
    const p = settled(session.setInputFormat(A, 2, 1, true));
    await vi.waitFor(() => expect(transport.writes).toHaveLength(1));
    transport.emitDisconnect();
    const r = await p;
    expect(!r.ok && (r.e as HubError).code).toBe("link-lost");
  });
});

describe("HubSession.portOutput", () => {
  it("without feedback resolves 'sent' once written, and registers nothing", async () => {
    const { transport, session } = await ready();
    await expect(session.portOutput(timed(A, "none"))).resolves.toBe("sent");
    expect(transport.writes[0]).toEqual(encodePortOutputCommand(timed(A, "none")));
    expect(session.discardPendingOutputs()).toBe(0);
  });

  it("with feedback resolves 'completed' on the completion report, not on 'in progress'", async () => {
    const { transport, session } = await ready();
    const p = session.portOutput(timed(A));
    await vi.waitFor(() => expect(transport.writes).toHaveLength(1));
    let done = false;
    void p.then(() => (done = true));
    transport.emitNotify(fb(A, 0x01)); // buffer empty, command in progress
    await Promise.resolve();
    expect(done).toBe(false);
    transport.emitNotify(fb(A, 0x0a)); // completed + idle
    await expect(p).resolves.toBe("completed");
  });

  it("resolves 'discarded' (does not reject) on a discarded report", async () => {
    const { transport, session } = await ready();
    const p = session.portOutput(timed(A));
    await vi.waitFor(() => expect(transport.writes).toHaveLength(1));
    transport.emitNotify(fb(A, 0x04));
    await expect(p).resolves.toBe("discarded");
  });

  it("correlates per port, in order", async () => {
    const { transport, session } = await ready();
    const a1 = session.portOutput(timed(A, "feedback", "buffer"));
    const b1 = session.portOutput(timed(B));
    const a2 = session.portOutput(timed(A, "feedback", "buffer"));
    await vi.waitFor(() => expect(transport.writes).toHaveLength(3));
    transport.emitNotify(fb(B, 0x0a));
    await expect(b1).resolves.toBe("completed");
    transport.emitNotify(fb(A, 0x02)); // first A done, a buffered one follows
    await expect(a1).resolves.toBe("completed");
    let second = false;
    void a2.then(() => (second = true));
    await Promise.resolve();
    expect(second).toBe(false);
    transport.emitNotify(fb(A, 0x0a));
    await expect(a2).resolves.toBe("completed");
  });

  it("handles several (port, flags) pairs in one 0x82", async () => {
    const { transport, session } = await ready();
    const a = session.portOutput(timed(A));
    const b = session.portOutput(timed(B));
    await vi.waitFor(() => expect(transport.writes).toHaveLength(2));
    transport.emitNotify(
      encodePortOutputFeedback({
        ports: [
          { port: A, flags: 0x0a },
          { port: B, flags: 0x04 },
        ],
      }),
    );
    await expect(Promise.all([a, b])).resolves.toEqual(["completed", "discarded"]);
  });

  it("a discard drops the older commands of the port but not the immediate one that caused it", async () => {
    const { transport, session } = await ready();
    const running = session.portOutput(timed(A));
    const buffered = session.portOutput(timed(A, "feedback", "buffer"));
    const replacement = session.portOutput(timed(A, "feedback", "immediate"));
    await vi.waitFor(() => expect(transport.writes).toHaveLength(3));
    transport.emitNotify(fb(A, 0x04)); // the hub discards the two it had
    await expect(Promise.all([running, buffered])).resolves.toEqual(["discarded", "discarded"]);
    let done = false;
    void replacement.then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);
    transport.emitNotify(fb(A, 0x0a));
    await expect(replacement).resolves.toBe("completed");
  });

  it("ignores a report nobody waits for", async () => {
    const { transport, session, events } = await ready();
    expect(() => transport.emitNotify(fb(A, 0x0a))).not.toThrow();
    expect(session.discardPendingOutputs()).toBe(0);
    expect(events.some((e) => e.kind === "message")).toBe(true);
  });

  it("rejects with 'rejected' on a generic error for 0x81 when exactly one command is pending", async () => {
    const { transport, session } = await ready();
    const only = settled(session.portOutput(timed(A)));
    await vi.waitFor(() => expect(transport.writes).toHaveLength(1));
    transport.emitNotify(
      encodeGenericError({
        commandType: MessageType.PortOutputCommand,
        code: ErrorCode.InvalidUse,
      }),
    );
    const r = await only;
    expect(!r.ok && (r.e as HubError).code).toBe("rejected");
  });

  it("a generic error with two pending commands (A and B) rejects nobody and surfaces as an event", async () => {
    const { transport, session, events } = await ready();
    const a = session.portOutput(timed(A));
    const b = session.portOutput(timed(B));
    await vi.waitFor(() => expect(transport.writes).toHaveLength(2));
    transport.emitNotify(
      encodeGenericError({
        commandType: MessageType.PortOutputCommand,
        code: ErrorCode.InvalidUse,
      }),
    );
    expect(events.filter((e) => e.kind === "unattributed-error")).toHaveLength(1);
    transport.emitNotify(fb(A, 0x0a));
    transport.emitNotify(fb(B, 0x0a));
    await expect(Promise.all([a, b])).resolves.toEqual(["completed", "completed"]);
  });

  it("a generic error after a later write of the same type (even without feedback) is unattributed", async () => {
    const { transport, session, events } = await ready();
    const rotate = session.portOutput(timed(A));
    await session.portOutput(timed(B, "none"));
    transport.emitNotify(
      encodeGenericError({
        commandType: MessageType.PortOutputCommand,
        code: ErrorCode.InvalidUse,
      }),
    );
    expect(events.filter((e) => e.kind === "unattributed-error")).toHaveLength(1);
    transport.emitNotify(fb(A, 0x0a));
    await expect(rotate).resolves.toBe("completed");
  });

  it("a generic error for a 0x81 nobody waits for surfaces as an event too", async () => {
    const { transport, events } = await ready();
    transport.emitNotify(
      encodeGenericError({
        commandType: MessageType.PortOutputCommand,
        code: ErrorCode.InvalidUse,
      }),
    );
    expect(events.filter((e) => e.kind === "unattributed-error")).toHaveLength(1);
  });

  it("busy/full (0x10) rejects the port's newest command 'busy'", async () => {
    const { transport, session } = await ready();
    const running = session.portOutput(timed(A));
    const refused = settled(session.portOutput(timed(A, "feedback", "buffer")));
    await vi.waitFor(() => expect(transport.writes).toHaveLength(2));
    transport.emitNotify(fb(A, 0x10));
    const r = await refused;
    expect(!r.ok && (r.e as HubError).code).toBe("busy");
    transport.emitNotify(fb(A, 0x0a));
    await expect(running).resolves.toBe("completed");
  });

  it("three quick immediate commands on one port each get their own outcome", async () => {
    const { transport, session } = await ready();
    const [r1, r2, r3] = [
      session.portOutput(timed(A)),
      session.portOutput(timed(A)),
      session.portOutput(timed(A)),
    ];
    await vi.waitFor(() => expect(transport.writes).toHaveLength(3));
    transport.emitNotify(fb(A, 0x04)); // the second displaced the first
    await expect(r1).resolves.toBe("discarded");
    transport.emitNotify(fb(A, 0x04)); // the third displaced the second
    await expect(r2).resolves.toBe("discarded");
    let third = false;
    void r3.then(() => (third = true));
    await Promise.resolve();
    expect(third).toBe(false);
    transport.emitNotify(fb(A, 0x0a));
    await expect(r3).resolves.toBe("completed");
  });

  it("the late 0x04 of a command settled by discardPendingOutputs is not taken by the next command", async () => {
    const { transport, session } = await ready();
    const old = session.portOutput(timed(A));
    await vi.waitFor(() => expect(transport.writes).toHaveLength(1));
    session.discardPendingOutputs();
    await expect(old).resolves.toBe("discarded");
    const fresh = session.portOutput(timed(A));
    await vi.waitFor(() => expect(transport.writes).toHaveLength(2));
    transport.emitNotify(fb(A, 0x04)); // the hub's report for the old one, arriving late
    let done = false;
    void fresh.then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);
    transport.emitNotify(fb(A, 0x0a));
    await expect(fresh).resolves.toBe("completed");
  });

  it("a command whose write was cancelled before reaching the hub leaves no late-report entry", async () => {
    const releases: (() => void)[] = [];
    const flush = async () => {
      for (let i = 0; i < 5; i++) {
        releases.splice(0).forEach((r) => r());
        await Promise.resolve();
      }
    };
    const transport = new FakeTransport({
      send: () => new Promise<void>((resolve) => releases.push(resolve)),
    });
    await transport.requestDevice();
    await transport.connect();
    const session = new HubSession(transport);
    void settled(session.portOutput(timed(B, "none"))); // in flight: holds the queue
    const queued = session.portOutput(timed(A)); // waits behind it
    session.discardPendingOutputs(); // what STOP does
    await expect(queued).resolves.toBe("discarded");
    const urgent = session.send(Uint8Array.of(1), { priority: "urgent" }); // cancels the queued write
    await flush();
    await urgent;
    const fresh = session.portOutput(timed(A));
    await flush();
    transport.emitNotify(fb(A, 0x0a)); // no late report was due: this one is the fresh command's own
    let done = false;
    void fresh.then(() => (done = true));
    await Promise.resolve();
    await Promise.resolve();
    expect(done).toBe(true);
  });

  it("a late completion is swallowed only before the new command's own in-progress report; a late discard any time in the window", async () => {
    const { transport, session } = await ready();
    const old1 = session.portOutput(timed(A));
    await vi.waitFor(() => expect(transport.writes).toHaveLength(1));
    session.discardPendingOutputs();
    await old1;
    const fresh1 = session.portOutput(timed(A));
    await vi.waitFor(() => expect(transport.writes).toHaveLength(2));
    transport.emitNotify(fb(A, 0x01)); // the new command started: what follows is its own
    transport.emitNotify(fb(A, 0x0a));
    await expect(fresh1).resolves.toBe("completed");

    const old2 = session.portOutput(timed(B));
    await vi.waitFor(() => expect(transport.writes).toHaveLength(3));
    session.discardPendingOutputs();
    await old2;
    const fresh2 = session.portOutput(timed(B));
    await vi.waitFor(() => expect(transport.writes).toHaveLength(4));
    transport.emitNotify(fb(B, 0x01));
    transport.emitNotify(fb(B, 0x04)); // still the old command's discard, even after the 0x01
    let done = false;
    void fresh2.then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);
    transport.emitNotify(fb(B, 0x0a));
    await expect(fresh2).resolves.toBe("completed");
  });

  it("a late completion of a timed-out command is swallowed, but only for 1 s", async () => {
    vi.useFakeTimers();
    const transport = new FakeTransport();
    await transport.requestDevice();
    await transport.connect();
    const session = new HubSession(transport);
    const old = settled(session.portOutput(timed(A), { timeoutMs: 100 }));
    await vi.advanceTimersByTimeAsync(100);
    await old;
    const fresh = session.portOutput(timed(A));
    await vi.advanceTimersByTimeAsync(0);
    transport.emitNotify(fb(A, 0x0a)); // the old command's late completion
    let done = false;
    void fresh.then(() => (done = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(false);
    transport.emitNotify(fb(A, 0x0a));
    await expect(fresh).resolves.toBe("completed");
    // a report that comes after the window is not swallowed
    const old2 = settled(session.portOutput(timed(A), { timeoutMs: 100 }));
    await vi.advanceTimersByTimeAsync(100);
    await old2;
    await vi.advanceTimersByTimeAsync(1001);
    const fresh2 = session.portOutput(timed(A));
    await vi.advanceTimersByTimeAsync(0);
    transport.emitNotify(fb(A, 0x0a));
    await expect(fresh2).resolves.toBe("completed");
    session.dispose();
  });

  it("rejects with 'timeout' when no report comes (per-command timeout wins over the default)", async () => {
    vi.useFakeTimers();
    const transport = new FakeTransport();
    await transport.requestDevice();
    await transport.connect();
    const session = new HubSession(transport, { feedbackTimeoutMs: 1000 });
    const short = settled(session.portOutput(timed(A), { timeoutMs: 200 }));
    const long = settled(session.portOutput(timed(B)));
    await vi.advanceTimersByTimeAsync(200);
    const r = await short;
    expect(!r.ok && (r.e as HubError).code).toBe("timeout");
    await vi.advanceTimersByTimeAsync(800);
    const l = await long;
    expect(!l.ok && (l.e as HubError).code).toBe("timeout");
  });

  it("rejects with 'link-lost' for every pending command when the link drops", async () => {
    const { transport, session } = await ready();
    const a = settled(session.portOutput(timed(A)));
    const b = settled(session.portOutput(timed(B)));
    await vi.waitFor(() => expect(transport.writes).toHaveLength(2));
    transport.emitDisconnect();
    for (const r of await Promise.all([a, b]))
      expect(!r.ok && (r.e as HubError).code).toBe("link-lost");
  });

  it("a write that fails (cancelled by an urgent one) rejects with the transport error and registers nothing", async () => {
    const gate: { release?: () => void } = {};
    const transport = new FakeTransport({
      send: () => new Promise<void>((resolve) => (gate.release = resolve)),
    });
    await transport.requestDevice();
    await transport.connect();
    const session = new HubSession(transport);
    void settled(session.portOutput(timed(A, "none"))); // in flight, holds the queue
    const queued = settled(session.portOutput(timed(B)));
    const urgent = session.send(Uint8Array.of(1), { priority: "urgent" });
    const r = await queued;
    expect(!r.ok && r.e).toBeInstanceOf(TransportError);
    expect(!r.ok && (r.e as TransportError).code).toBe("cancelled");
    expect(session.discardPendingOutputs()).toBe(0);
    gate.release?.();
    gate.release?.();
    await urgent.catch(() => undefined);
  });

  it("discardPendingOutputs settles everything pending as 'discarded' and reports how many", async () => {
    const { transport, session } = await ready();
    const a = session.portOutput(timed(A));
    const b = session.portOutput(timed(B));
    await vi.waitFor(() => expect(transport.writes).toHaveLength(2));
    expect(session.discardPendingOutputs()).toBe(2);
    await expect(Promise.all([a, b])).resolves.toEqual(["discarded", "discarded"]);
    expect(session.discardPendingOutputs()).toBe(0);
  });
});

describe("HubSession.dispose", () => {
  it("rejects pending requests with 'disposed', stops listening and is idempotent", async () => {
    const { transport, session, events } = await ready();
    const out = settled(session.portOutput(timed(A)));
    const fmt = settled(session.setInputFormat(A, 2, 1, true));
    await vi.waitFor(() => expect(transport.writes).toHaveLength(2));
    session.dispose();
    session.dispose();
    for (const r of await Promise.all([out, fmt]))
      expect(!r.ok && (r.e as HubError).code).toBe("disposed");
    const before = events.length;
    transport.emitNotify(encodeGenericError({ commandType: 1, code: 1 }));
    transport.emitDisconnect();
    expect(events).toHaveLength(before);
  });

  it("refuses new requests once disposed", async () => {
    const { session } = await ready();
    session.dispose();
    const r = await settled(session.portOutput(timed(A)));
    expect(!r.ok && (r.e as HubError).code).toBe("disposed");
    const f = await settled(session.setInputFormat(A, 2, 1, true));
    expect(!f.ok && (f.e as HubError).code).toBe("disposed");
  });

  it("leaves no timers behind", async () => {
    vi.useFakeTimers();
    const transport = new FakeTransport();
    await transport.requestDevice();
    await transport.connect();
    const session = new HubSession(transport);
    const p = settled(session.portOutput(timed(A)));
    await vi.advanceTimersByTimeAsync(0);
    const before = vi.getTimerCount();
    session.dispose();
    await p;
    expect(vi.getTimerCount()).toBeLessThan(before);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("HubSession over the simulated hub (main path)", () => {
  it("a timed motor command completes through the simulator's feedback", async () => {
    vi.useFakeTimers();
    const hub = new SimulatedHub(defaultMoveHubConfig());
    const sim = new SimulatorTransport(hub);
    await sim.requestDevice();
    await sim.connect();
    const session = new HubSession(sim);
    const p = session.portOutput(timed(A));
    await vi.advanceTimersByTimeAsync(300);
    await expect(p).resolves.toBe("completed");
    session.dispose();
    sim.dispose();
    hub.dispose();
  });

  it("an immediate command discards the timed one it replaces", async () => {
    vi.useFakeTimers();
    const hub = new SimulatedHub(defaultMoveHubConfig());
    const sim = new SimulatorTransport(hub);
    await sim.requestDevice();
    await sim.connect();
    const session = new HubSession(sim);
    const first = session.portOutput({
      ...timed(A),
      command: {
        ...timed(A).command,
        sub: "startSpeedForTime",
        time: 5000,
        speed: 50,
        maxPower: 100,
        endState: 127,
        useProfile: profile,
      },
    });
    await vi.advanceTimersByTimeAsync(50);
    const second = session.portOutput(timed(A));
    await vi.advanceTimersByTimeAsync(300);
    await expect(first).resolves.toBe("discarded");
    await expect(second).resolves.toBe("completed");
    session.dispose();
    sim.dispose();
    hub.dispose();
  });

  it("setInputFormat on a motor resolves and the position values arrive as events", async () => {
    vi.useFakeTimers();
    const hub = new SimulatedHub(defaultMoveHubConfig());
    const sim = new SimulatorTransport(hub);
    await sim.requestDevice();
    await sim.connect();
    const session = new HubSession(sim);
    const values: number[] = [];
    session.onEvent((e) => {
      if (e.kind === "message" && e.message.type === "portValue") values.push(e.message.raw.length);
    });
    await expect(session.setInputFormat(A, 2, 1, true)).resolves.toMatchObject({
      port: A,
      mode: 2,
    });
    expect(values).toEqual([4]);
    session.dispose();
    sim.dispose();
    hub.dispose();
    expect(encodePortValueSingle(A, Uint8Array.of(0, 0, 0, 0)).length).toBe(8);
  });
});
