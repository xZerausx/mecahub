import {
  encodeGenericError,
  encodePortOutputCommand,
  encodePortOutputFeedback,
  type PortOutputCommandMessage,
} from "@mecahub/lwp3";
import { describe, expect, it } from "vitest";
import { ManualClock } from "./clock.js";
import { defaultMoveHubConfig } from "./config.js";
import { SimulatedHub } from "./simulated-hub.js";

// Startup/completion semantics (doc 3.26 startup and completion nibbles, doc 3.32 feedback bits):
// the nibble values and the flag bits are derivado del layout; everything about WHEN a hub sends
// which flags, and a buffer of exactly one slot, is supuesto, TODO(hw) (see docs/protocol-notes.md:
// no capture has a 0x82 yet, and the existing 0x0A note).
// Discarding a command that runs until replaced (start speed/power, direct mode) reports nothing:
// it was already complete when it started (doc 3.32 note), so there is nothing left to discard.
const A = 0x00;
const B = 0x01;
const AB = 0x10;
const IN_PROGRESS = 0x01;
const COMPLETED = 0x02;
const DISCARDED = 0x04;
const IDLE_COMPLETED = 0x0a;
const BUSY_FULL = 0x10;

const profile = { acc: false, dec: false };
type Command = PortOutputCommandMessage["command"];
const forTime = (time: number, speed = 100): Command => ({
  sub: "startSpeedForTime",
  time,
  speed,
  maxPower: 100,
  endState: 127,
  useProfile: profile,
});
const startSpeed = (speed: number): Command => ({
  sub: "startSpeed",
  speed,
  maxPower: 100,
  useProfile: profile,
});
const fb = (port: number, flags: number) => encodePortOutputFeedback({ ports: [{ port, flags }] });

function connected() {
  const clock = new ManualClock();
  const hub = new SimulatedHub(defaultMoveHubConfig(), { clock });
  const sent: Uint8Array[] = [];
  hub.onSend((f) => sent.push(f));
  hub.connect();
  sent.length = 0;
  const send = (
    port: number,
    command: Command,
    startup: "buffer" | "immediate",
    completion: "none" | "feedback",
  ) => hub.receive(encodePortOutputCommand({ port, startup, completion, command }));
  return { hub, clock, sent, send };
}

describe("output command feedback (0x82)", () => {
  it("completion none: never any feedback, not even when the command ends or is replaced", () => {
    const { clock, sent, send } = connected();
    send(A, forTime(50), "immediate", "none");
    clock.advance(100);
    send(A, forTime(50), "immediate", "none");
    send(A, startSpeed(10), "immediate", "none");
    expect(sent).toEqual([]);
  });

  it("a timed command with feedback: in progress at the start, completed + idle when it ends", () => {
    const { clock, sent, send } = connected();
    send(A, forTime(100), "immediate", "feedback");
    expect(sent.splice(0)).toEqual([fb(A, IN_PROGRESS)]);
    clock.advance(90);
    expect(sent).toEqual([]);
    clock.advance(10);
    expect(sent.splice(0)).toEqual([fb(A, IDLE_COMPLETED)]);
    clock.advance(1000);
    expect(sent).toEqual([]);
  });

  it("a command that runs until replaced is over as soon as it starts: in progress, then completed + idle", () => {
    const { sent, send } = connected();
    send(A, startSpeed(50), "immediate", "feedback");
    expect(sent.splice(0)).toEqual([fb(A, IN_PROGRESS), fb(A, IDLE_COMPLETED)]);
  });

  it("a move that is already there is in progress and completed at once", () => {
    const { sent, send } = connected();
    send(
      A,
      {
        sub: "gotoAbsolutePosition",
        absPos: 0,
        speed: 50,
        maxPower: 100,
        endState: 126,
        useProfile: profile,
      },
      "immediate",
      "feedback",
    );
    expect(sent.splice(0)).toEqual([fb(A, IN_PROGRESS), fb(A, IDLE_COMPLETED)]);
  });

  it("virtual port commands report the virtual port", () => {
    const { clock, sent, send } = connected();
    send(AB, forTime(20), "immediate", "feedback");
    clock.advance(20);
    expect(sent.splice(0)).toEqual([fb(AB, IN_PROGRESS), fb(AB, IDLE_COMPLETED)]);
  });

  it("an immediate command replaces the running one: that one is reported discarded, only if it asked for feedback", () => {
    const { hub, sent, send } = connected();
    send(A, forTime(1000), "immediate", "feedback");
    sent.length = 0;
    send(A, startSpeed(-30), "immediate", "none");
    expect(sent.splice(0)).toEqual([fb(A, DISCARDED)]);
    expect(hub.motorState(A).speed).toBe(-30);
    send(A, forTime(1000), "immediate", "none");
    send(A, startSpeed(20), "immediate", "none");
    expect(sent).toEqual([]);
  });

  it("the discarded report comes before the new command's own in-progress", () => {
    const { sent, send } = connected();
    send(A, forTime(1000), "immediate", "feedback");
    sent.length = 0;
    send(A, forTime(500), "immediate", "feedback");
    expect(sent.splice(0)).toEqual([fb(A, DISCARDED), fb(A, IN_PROGRESS)]);
  });

  it("a buffered command waits for the running one, which then reports completed (not idle) and the next starts", () => {
    const { hub, clock, sent, send } = connected();
    send(A, forTime(100, 100), "immediate", "feedback");
    send(A, forTime(50, -100), "buffer", "feedback");
    expect(sent.splice(0)).toEqual([fb(A, IN_PROGRESS)]);
    expect(hub.motorState(A).speed).toBe(100);
    clock.advance(100);
    expect(sent.splice(0)).toEqual([fb(A, COMPLETED), fb(A, IN_PROGRESS)]);
    expect(hub.motorState(A).speed).toBe(-100);
    clock.advance(50);
    expect(sent.splice(0)).toEqual([fb(A, IDLE_COMPLETED)]);
    expect(hub.motorState(A)).toEqual({ position: 50, speed: 0, running: false });
  });

  it("the buffer holds one command: a second buffered one is refused with busy/full, even without feedback", () => {
    const { hub, clock, sent, send } = connected();
    send(A, forTime(100), "immediate", "none");
    send(A, forTime(10, -50), "buffer", "none");
    send(A, forTime(10, 25), "buffer", "none");
    expect(sent.splice(0)).toEqual([fb(A, BUSY_FULL)]);
    clock.advance(1000);
    // the first buffered one ran (-50% for 10 ms), the refused one never did
    expect(hub.motorState(A).position).toBe(100 - 5);
  });

  it("a buffered command on a port with nothing in progress starts right away", () => {
    const { hub, sent, send } = connected();
    send(A, startSpeed(40), "buffer", "feedback");
    expect(sent.splice(0)).toEqual([fb(A, IN_PROGRESS), fb(A, IDLE_COMPLETED)]);
    expect(hub.motorState(A).speed).toBe(40);
    send(A, startSpeed(-40), "buffer", "none"); // the run-until-replaced one was already complete
    expect(hub.motorState(A).speed).toBe(-40);
    expect(sent).toEqual([]);
  });

  it("an immediate command discards the running one and the buffered one", () => {
    const { hub, sent, send } = connected();
    send(A, forTime(1000), "immediate", "feedback");
    send(A, forTime(1000), "buffer", "feedback");
    sent.length = 0;
    send(A, { sub: "startPower", power: 127 }, "immediate", "none");
    expect(sent.splice(0)).toEqual([fb(A, DISCARDED)]);
    expect(hub.motorState(A).running).toBe(false);
  });

  it("a command that takes a motor from another port's command discards that one", () => {
    const { hub, sent, send } = connected();
    send(AB, forTime(1000), "immediate", "feedback");
    sent.length = 0;
    send(A, startSpeed(10), "immediate", "none");
    expect(sent.splice(0)).toEqual([fb(AB, DISCARDED)]);
    expect(hub.motorState(B).running).toBe(false);
  });

  it("losing the link is silent: nothing is reported, and the commands are gone", () => {
    const { hub, clock, sent, send } = connected();
    send(A, forTime(1000), "immediate", "feedback");
    send(A, forTime(1000), "buffer", "feedback");
    sent.length = 0;
    hub.disconnect();
    clock.advance(5000);
    expect(sent).toEqual([]);
  });

  it("a command that is refused gets an error and no feedback", () => {
    const { sent, send } = connected();
    send(0x03, startSpeed(10), "immediate", "feedback");
    expect(sent.splice(0)).toEqual([encodeGenericError({ commandType: 0x81, code: 0x06 })]);
    send(
      B,
      { sub: "unknown", subCommand: 0x14, payload: new Uint8Array() },
      "immediate",
      "feedback",
    );
    expect(sent.splice(0)).toEqual([encodeGenericError({ commandType: 0x81, code: 0x05 })]);
  });

  it("a timed command whose speed is zero still ends on time: feedback fires and the buffered command starts", () => {
    const { hub, clock, sent, send } = connected();
    send(A, forTime(100, 0), "immediate", "feedback"); // nothing moves, but 100 ms must pass
    send(A, forTime(50, 100), "buffer", "feedback");
    expect(sent.splice(0)).toEqual([fb(A, IN_PROGRESS)]);
    clock.advance(99);
    expect(sent).toEqual([]);
    clock.advance(1);
    expect(sent.splice(0)).toEqual([fb(A, COMPLETED), fb(A, IN_PROGRESS)]);
    expect(hub.motorState(A).speed).toBe(100);
    clock.advance(50);
    expect(sent.splice(0)).toEqual([fb(A, IDLE_COMPLETED)]);
    expect(clock.pending).toBe(0);
  });

  it("STOP: an immediate brake on a running motor also kills the buffered command, which never starts", () => {
    const { hub, clock, send } = connected();
    send(A, forTime(1000, 100), "immediate", "none");
    send(A, forTime(1000, 100), "buffer", "none");
    clock.advance(20);
    send(A, { sub: "startPower", power: 127 }, "immediate", "none");
    const at = hub.motorState(A).position;
    expect(at).toBe(20);
    clock.advance(5000);
    expect(hub.motorState(A)).toEqual({ position: at, speed: 0, running: false });
    expect(clock.pending).toBe(0);
  });

  it("STOP: the same with a command that runs until replaced and a buffered one waiting", () => {
    const { hub, clock, send } = connected();
    send(A, startSpeed(100), "immediate", "none");
    send(A, forTime(1000, 100), "buffer", "none"); // nothing in progress: starts at once
    clock.advance(20);
    send(A, { sub: "startPower", power: 127 }, "immediate", "none");
    clock.advance(5000);
    expect(hub.motorState(A)).toEqual({ position: 20, speed: 0, running: false });
  });
});
