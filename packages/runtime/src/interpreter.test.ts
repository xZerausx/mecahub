import { beforeEach, describe, expect, it } from "vitest";
import { advance, harness, settle } from "./test-support/harness.js";
import { calc, cmp, num, onStart, program, resetIds, s, variable } from "./test-support/ir.js";

beforeEach(resetIds);

const run = async (body: Parameters<typeof onStart>[1], variables = [] as never[]) => {
  const h = harness();
  await h.start(program([onStart("s", body)], variables));
  return h;
};

describe("simple statements", () => {
  it("sends the motor, drive and LED commands, in order", async () => {
    const h = await run([
      s.start("A", 50),
      s.stop("A", "float"),
      s.driveStart(40, -40),
      s.driveStop("brake"),
      s.stop("B", "brake"),
      s.led("red"),
    ]);
    expect(h.device.log).toEqual([
      "motor.A.run(50)",
      "motor.A.float",
      "drive.run(40,-40)",
      "drive.brake",
      "motor.B.brake",
      "led(red)",
    ]);
    expect(h.result).toEqual({ reason: "completed" });
  });

  it("playSound does not block and goes to the sound sink", async () => {
    const h = await run([s.sound("beep"), s.sound("horn")]);
    expect(h.sounds).toEqual(["beep", "horn"]);
    expect(h.result?.reason).toBe("completed");
  });

  it("wait takes clock time", async () => {
    const h = await run([s.wait(500), s.led("blue")]);
    expect(h.device.log).toEqual([]);
    await advance(h.clock, 490);
    expect(h.device.log).toEqual([]);
    await advance(h.clock, 20);
    expect(h.device.log).toEqual(["led(blue)"]);
  });
});

describe("timed motor statements", () => {
  it("runFor waits for the hub's feedback before the next statement", async () => {
    const h = await run([s.forTime("A", 60, 1000), s.led("green")]);
    expect(h.device.log).toEqual(["motor.A.runFor(1000,60)"]);
    h.device.complete("motor.A");
    await settle();
    expect(h.device.log).toEqual(["motor.A.runFor(1000,60)", "led(green)"]);
  });

  it("rotate waits for feedback", async () => {
    const h = await run([s.forDegrees("B", -40, 360), s.led("green")]);
    expect(h.device.log).toEqual(["motor.B.rotate(360,-40)"]);
    h.device.complete();
    await settle();
    expect(h.device.log.at(-1)).toBe("led(green)");
  });

  it("clamps computed speed, and splits long times into hub-sized chunks", async () => {
    const h = await run([s.forTime("A", calc("*", 100, 5), 70_000)]);
    expect(h.device.log).toEqual(["motor.A.runFor(32767,100)"]);
    h.device.complete();
    await settle();
    h.device.complete();
    await settle();
    expect(h.device.log).toEqual([
      "motor.A.runFor(32767,100)",
      "motor.A.runFor(32767,100)",
      "motor.A.runFor(4466,100)",
    ]);
  });

  it("a ForTime at speed 0 just waits", async () => {
    const h = await run([s.forTime("A", 0, 300), s.led("red")]);
    expect(h.device.log).toEqual([]);
    await advance(h.clock, 310);
    expect(h.device.log).toEqual(["led(red)"]);
  });

  it("a ForDegrees whose computed speed or angle is 0 skips the command", async () => {
    const h = await run([s.forDegrees("A", num(0.2), 90), s.forDegrees("A", 50, 0), s.led("red")]);
    expect(h.device.log).toEqual(["led(red)"]);
  });

  it("negative computed times and angles count as 0", async () => {
    const h = await run([s.forTime("A", 50, calc("-", 0, 10)), s.led("red")]);
    expect(h.device.log).toEqual(["led(red)"]);
  });
});

describe("drive statements with a speed per motor", () => {
  it("driveForTime runs A and B in parallel and waits for both", async () => {
    const h = await run([s.driveForTime(50, -30, 800), s.led("green")]);
    expect(h.device.log).toEqual(["motor.A.runFor(800,50)", "motor.B.runFor(800,-30)"]);
    h.device.complete("motor.A");
    await settle();
    expect(h.device.log).not.toContain("led(green)");
    h.device.complete("motor.B");
    await settle();
    expect(h.device.log.at(-1)).toBe("led(green)");
  });

  it("driveForDegrees rotates each motor; a zero-speed wheel is held (pivot turn)", async () => {
    const h = await run([s.driveForDegrees(50, 0, 200)]);
    expect(h.device.log).toEqual(["motor.A.rotate(200,50)", "motor.B.brake"]);
  });

  it("driveForDegrees with both speeds 0 skips the command", async () => {
    const h = await run([s.driveForDegrees(calc("*", 0, 5), 0, 200), s.led("red")]);
    expect(h.device.log).toEqual(["led(red)"]);
  });

  it("driveForTime with both speeds 0 just waits", async () => {
    const h = await run([s.driveForTime(0, 0, 200), s.led("red")]);
    expect(h.device.log).toEqual([]);
    await advance(h.clock, 210);
    expect(h.device.log).toEqual(["led(red)"]);
  });
});

describe("control flow", () => {
  it("repeat runs its body n times (counts clamp to integers >= 0)", async () => {
    const h = await run([s.repeat(3, [s.led("red")]), s.repeat(calc("-", 0, 2), [s.led("blue")])]);
    await advance(h.clock, 100);
    expect(h.device.log).toEqual(["led(red)", "led(red)", "led(red)"]);
    expect(h.result?.reason).toBe("completed");
  });

  it("if / else picks a branch", async () => {
    const h = await run([
      s.if(cmp("<", num(1), num(2)), [s.led("red")], [s.led("blue")]),
      s.if(cmp(">", num(1), num(2)), [s.led("green")], [s.led("white")]),
      s.if(cmp(">", num(1), num(2)), [s.led("pink")]),
    ]);
    expect(h.device.log).toEqual(["led(red)", "led(white)"]);
  });

  it("while loops until its condition is false; variables reset on every run", async () => {
    const v = { id: "v", name: "n", initial: 2 };
    const h = harness();
    const prog = program(
      [onStart("s", [s.while(cmp("<", variable("v"), num(5)), [s.change("v", 1), s.led("red")])])],
      [v],
    );
    await h.start(prog);
    await advance(h.clock, 100);
    expect(h.device.log).toEqual(["led(red)", "led(red)", "led(red)"]);
    h.device.log.length = 0;
    void h.runtime.run(prog);
    await advance(h.clock, 100);
    expect(h.device.log).toHaveLength(3); // initial 2 again, not 5
  });

  it("forever repeats until STOP", async () => {
    const h = await run([s.forever([s.led("red"), s.wait(100)])]);
    await advance(h.clock, 350);
    expect(h.device.log.filter((l) => l === "led(red)").length).toBe(4);
    expect(h.result).toBeUndefined();
    h.runtime.stop();
    await settle();
    expect(h.result).toEqual({ reason: "stopped" });
  });

  it("waitUntil polls its condition (another script flips the variable)", async () => {
    const h = harness();
    await h.start(
      program(
        [
          onStart("a", [s.waitUntil(cmp(">", variable("v"), num(0))), s.led("green")]),
          onStart("b", [s.wait(200), s.set("v", 1)]),
        ],
        [{ id: "v", name: "v", initial: 0 }],
      ),
    );
    await advance(h.clock, 150);
    expect(h.device.log).toEqual([]);
    await advance(h.clock, 100);
    expect(h.device.log).toEqual(["led(green)"]);
  });

  it("scripts run in parallel", async () => {
    const h = harness();
    await h.start(
      program([
        onStart("a", [s.wait(100), s.led("red")]),
        onStart("b", [s.wait(50), s.led("blue")]),
      ]),
    );
    await advance(h.clock, 120);
    expect(h.device.log).toEqual(["led(blue)", "led(red)"]);
    expect(h.result?.reason).toBe("completed");
  });

  it("stopScript ends only its own script", async () => {
    const h = harness();
    await h.start(
      program([
        onStart("a", [s.led("red"), s.stopScript(), s.led("pink")]),
        onStart("b", [s.wait(100), s.led("blue")]),
      ]),
    );
    await advance(h.clock, 150);
    expect(h.device.log).toEqual(["led(red)", "led(blue)"]);
    expect(h.result).toEqual({ reason: "completed" });
  });

  it("the stopAll statement halts everything and ends the run with reason stopAll", async () => {
    const h = harness();
    await h.start(
      program([
        onStart("a", [s.forever([s.wait(10)])]),
        onStart("b", [s.wait(50), s.stopAll(), s.led("pink")]),
      ]),
    );
    await advance(h.clock, 100);
    expect(h.device.log).toEqual(["stopAll"]);
    expect(h.result).toEqual({ reason: "stopAll" });
  });
});

describe("yield fairness", () => {
  it("a forever with only setVariable starves neither another script nor STOP", async () => {
    const h = harness();
    await h.start(
      program(
        [
          onStart("spin", [s.forever([s.change("v", 1)])]),
          onStart("other", [s.wait(100), s.led("red")]),
        ],
        [{ id: "v", name: "v", initial: 0 }],
      ),
    );
    await advance(h.clock, 120);
    expect(h.device.log).toEqual(["led(red)"]);
    h.runtime.stop();
    await settle();
    expect(h.result).toEqual({ reason: "stopped" });
  });

  it("an empty repeat and a never-true waitUntil also yield", async () => {
    const h = harness();
    await h.start(
      program([
        onStart("a", [s.repeat(100_000, [])]),
        onStart("b", [s.waitUntil(cmp("<", num(1), num(0)))]),
        onStart("c", [s.wait(30), s.led("red")]),
      ]),
    );
    await advance(h.clock, 40);
    expect(h.device.log).toEqual(["led(red)"]);
    h.runtime.stop();
  });
});

describe("highlight events", () => {
  it("containers emit enter before the body and exit after it", async () => {
    const h = harness();
    const led = s.led("red");
    const inner = s.if(cmp("<", num(1), num(2)), [led]);
    const loop = s.repeat(2, [inner]);
    await h.start(program([onStart("s", [loop])]));
    await advance(h.clock, 50);
    const [L, I, E] = [loop.id, inner.id, led.id];
    expect(h.events).toEqual([
      `+${L}`,
      `+${I}`,
      `+${E}`,
      `-${E}`,
      `-${I}`,
      `+${I}`,
      `+${E}`,
      `-${E}`,
      `-${I}`,
      `-${L}`,
    ]);
  });

  it("an unsubscribed listener hears nothing more", async () => {
    const h = harness();
    const seen: string[] = [];
    const off = h.runtime.onBlockEnter((e) => seen.push(e.statementId));
    off();
    await h.start(program([onStart("s", [s.led("red")])]));
    expect(seen).toEqual([]);
  });
});

describe("conflicting commands (last command wins per port)", () => {
  it("a new command on a port ends the statement waiting on it; its script continues", async () => {
    const h = harness();
    await h.start(
      program([
        onStart("a", [s.forTime("A", 50, 5000), s.led("red")]),
        onStart("b", [s.wait(100), s.start("A", -20)]),
      ]),
    );
    expect(h.device.log).toEqual(["motor.A.runFor(5000,50)"]);
    await advance(h.clock, 120);
    expect(h.device.log).toEqual(["motor.A.runFor(5000,50)", "motor.A.run(-20)", "led(red)"]);
  });

  it("a command on B replaces a waiting drive on AB, and a drive replaces a waiting command on A", async () => {
    const h = harness();
    await h.start(
      program([
        onStart("a", [s.driveForTime(50, 50, 5000), s.led("red")]),
        onStart("b", [s.wait(100), s.start("B", 10)]),
        onStart("c", [s.wait(200), s.forTime("A", 30, 5000), s.led("pink")]),
        onStart("d", [s.wait(300), s.driveStart(10, 10)]),
      ]),
    );
    await advance(h.clock, 350);
    expect(h.device.log).toContain("led(red)");
    expect(h.device.log).toContain("led(pink)");
    expect(h.device.log.at(-1)).toBe("led(pink)");
  });

  it("commands on different ports do not interfere", async () => {
    const h = harness();
    await h.start(
      program([
        onStart("a", [s.forTime("A", 50, 5000), s.led("red")]),
        onStart("b", [s.wait(100), s.start("B", 10)]),
      ]),
    );
    await advance(h.clock, 150);
    expect(h.device.log).not.toContain("led(red)");
  });
});

describe("errors and refusals", () => {
  it("a hub error reaches onError with its script and statement, then the run ends with a STOP", async () => {
    const h = harness();
    const bad = s.start("A", 50);
    h.device.failNext = { prefix: "motor.A.run(", error: new Error("link lost") };
    await h.start(program([onStart("s", [bad, s.led("red")])]));
    expect(h.errors).toEqual([{ scriptId: "s", statementId: bad.id, code: "hub-error" }]);
    expect(h.device.log).toEqual(["motor.A.run(50)", "stopAll"]);
    expect(h.result?.reason).toBe("error");
    expect(h.result?.error?.code).toBe("hub-error");
  });

  it("an invalid program is refused without touching the device", async () => {
    const h = harness();
    await h.start({ irVersion: 2 } as never);
    expect(h.result?.reason).toBe("error");
    expect(h.result?.error?.code).toBe("invalid-program");
    expect(h.device.log).toEqual([]);
  });

  it("run() while running returns a busy result and leaves the first run alone", async () => {
    const h = await run([s.forever([s.wait(10)])]);
    const second = await h.runtime.run(program([onStart("x", [s.led("red")])]));
    expect(second.reason).toBe("error");
    expect(second.error?.code).toBe("busy");
    expect(h.runtime.running).toBe(true);
    expect(h.device.log).toEqual([]);
    h.runtime.stop();
    await settle();
    expect(h.runtime.running).toBe(false);
  });

  it("onFinished hears the result", async () => {
    const h = harness();
    const seen: string[] = [];
    h.runtime.onFinished((r) => seen.push(r.reason));
    await h.start(program([onStart("s", [s.led("red")])]));
    expect(seen).toEqual(["completed"]);
  });

  it("a program can run again after it finished", async () => {
    const h = harness();
    const prog = program([onStart("s", [s.led("red")])]);
    await h.start(prog);
    await h.start(prog);
    expect(h.device.log).toEqual(["led(red)", "led(red)"]);
  });
});
