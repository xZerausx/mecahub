import { ManualClock } from "@mecahub/simulator";
import { describe, expect, it, vi } from "vitest";
import { Cancelled, race, sleep, yieldTurn } from "./abortable.js";
import { realRuntimeClock } from "./clock.js";

const flush = () => new Promise<void>((r) => setImmediate(r));

describe("sleep", () => {
  it("resolves when the clock reaches the deadline", async () => {
    const clock = new ManualClock();
    const done = vi.fn();
    void sleep(clock, 100, new AbortController().signal).then(done);
    clock.advance(99);
    await flush();
    expect(done).toHaveBeenCalledTimes(0);
    clock.advance(1);
    await flush();
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("rejects with Cancelled as soon as the signal aborts and clears its timer", async () => {
    const clock = new ManualClock();
    const ctl = new AbortController();
    const p = sleep(clock, 1000, ctl.signal);
    expect(clock.pending).toBe(1);
    ctl.abort();
    await expect(p).rejects.toBeInstanceOf(Cancelled);
    expect(clock.pending).toBe(0);
  });

  it("rejects at once (and sets no timer) when the signal is already aborted", async () => {
    const clock = new ManualClock();
    const ctl = new AbortController();
    ctl.abort();
    await expect(sleep(clock, 5, ctl.signal)).rejects.toBeInstanceOf(Cancelled);
    expect(clock.pending).toBe(0);
  });

  it("leaves no timer behind after resolving", async () => {
    const clock = new ManualClock();
    const p = sleep(clock, 5, new AbortController().signal);
    clock.advance(5);
    await p;
    expect(clock.pending).toBe(0);
  });
});

describe("race", () => {
  it("passes the promise's value through", async () => {
    await expect(race(Promise.resolve(7), new AbortController().signal)).resolves.toBe(7);
  });

  it("passes the promise's rejection through", async () => {
    await expect(
      race(Promise.reject(new Error("x")), new AbortController().signal),
    ).rejects.toThrow("x");
  });

  it("rejects with Cancelled when the signal aborts first, without an unhandled rejection", async () => {
    const ctl = new AbortController();
    const never = new Promise<number>((_, reject) =>
      setTimeout(() => reject(new Error("late")), 5),
    );
    const p = race(never, ctl.signal);
    ctl.abort();
    await expect(p).rejects.toBeInstanceOf(Cancelled);
    await new Promise((r) => setTimeout(r, 15)); // the late rejection must be swallowed
  });
});

describe("yieldTurn", () => {
  it("takes a macrotask on the clock, not a microtask", async () => {
    const clock = new ManualClock();
    const done = vi.fn();
    void yieldTurn(clock, new AbortController().signal).then(done);
    await flush();
    expect(done).toHaveBeenCalledTimes(0);
    clock.advance(0);
    await flush();
    expect(done).toHaveBeenCalledTimes(1);
  });
});

describe("realRuntimeClock", () => {
  it("resolves the global timers at call time (so fake timers apply)", () => {
    const handle = realRuntimeClock.setTimeout(() => undefined, 10_000);
    realRuntimeClock.clearTimeout(handle);
    expect(typeof realRuntimeClock.now()).toBe("number");
  });
});
