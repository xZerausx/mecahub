import type { Script, Trigger } from "@mecahub/ir";
import { beforeEach, describe, expect, it } from "vitest";
import { advance, harness, settle } from "./test-support/harness.js";
import { cmp, num, onStart, program, resetIds, s, script } from "./test-support/ir.js";

beforeEach(resetIds);

const on = (id: string, trigger: Trigger, ...body: Script["body"]): Script =>
  script(id, trigger, body);
const sensor = (name: "color" | "distance", port: "C" | "D") =>
  ({ type: "sensor", sensor: name, port }) as const;
const see = (
  h: ReturnType<typeof harness>,
  color: Parameters<typeof h.device.pushColorDistance>[1]["color"],
) => h.device.pushColorDistance("D", { color, distance: 10 });

describe("sensor setup", () => {
  it("subscribes only to the sensors the program uses, and drops them at the end", async () => {
    const h = harness();
    await h.start(
      program([
        on("c", { type: "colorSeen", port: "D", color: "red" }, s.led("red")),
        on("b", { type: "buttonPressed" }, s.led("blue")),
      ]),
    );
    expect(h.device.subscriptions).toEqual(["button", "colorDistance.D"]);
    h.runtime.stop();
    expect(h.device.subscriptions).toEqual([]);
  });

  it("subscribes to what expressions read (tilt, motor position, color sensor)", async () => {
    const h = harness();
    await h.start(
      program([
        onStart("s", [
          s.waitUntil(cmp(">", { type: "sensor", sensor: "tiltX" }, num(0))),
          s.waitUntil(cmp(">", { type: "sensor", sensor: "motorPosition", port: "A" }, num(0))),
          s.waitUntil({ type: "colorIs", port: "C", color: "red" }),
        ]),
      ]),
    );
    expect(h.device.subscriptions).toEqual(["colorDistance.C", "position.A", "tilt"]);
    h.runtime.stop();
  });

  it("a program that reads no sensor subscribes to nothing", async () => {
    const h = harness();
    await h.start(program([onStart("s", [s.led("red")])]));
    expect(h.device.log).toEqual(["led(red)"]);
  });

  it("start scripts begin only after every sensor reported once, all together", async () => {
    const h = harness();
    h.device.autoInitial = false;
    await h.start(
      program([
        onStart("a", [
          s.waitUntil(cmp("<", { ...sensor("distance", "D") }, num(100))),
          s.led("red"),
        ]),
        onStart("b", [s.led("blue")]),
      ]),
    );
    expect(h.device.log).toEqual(["subscribe(colorDistance.D)"]);
    h.device.pushColorDistance("D", { color: "none", distance: 5 });
    await settle();
    expect(h.device.log).toContain("led(blue)");
    await advance(h.clock, 20);
    expect(h.device.log).toContain("led(red)");
  });

  it("a sensor that never reports ends the run with sensor-timeout and nothing moves", async () => {
    const h = harness();
    h.device.autoInitial = false;
    await h.start(
      program([
        onStart("a", [s.led("red"), s.waitUntil(cmp("<", sensor("distance", "D"), num(5)))]),
      ]),
    );
    await advance(h.clock, 2100);
    expect(h.result?.reason).toBe("error");
    expect(h.result?.error?.code).toBe("sensor-timeout");
    expect(h.device.log).toEqual([
      "subscribe(colorDistance.D)",
      "stopAll",
      "unsubscribe(colorDistance.D)",
    ]);
    expect(h.clock.pending).toBe(0);
  });

  it("a missing device ends the run with missing-device before anything is sent", async () => {
    const h = harness();
    h.device.missing.add("colorDistance:D");
    await h.start(
      program([
        onStart("a", [s.start("A", 10), s.waitUntil({ type: "colorIs", port: "D", color: "red" })]),
      ]),
    );
    expect(h.result?.error?.code).toBe("missing-device");
    expect(h.device.log).toEqual([]);
  });

  it("a missing motor is caught up front too", async () => {
    const h = harness();
    h.device.missing.add("motor:C");
    await h.start(program([onStart("a", [s.led("red"), s.start("C", 10)])]));
    expect(h.result?.error?.code).toBe("missing-device");
    expect(h.device.log).toEqual([]);
  });

  it("a subscription failing ends the run and releases the others", async () => {
    const h = harness();
    h.device.failNext = { prefix: "subscribe(tilt)", error: new Error("mode-conflict") };
    await h.start(
      program([
        on("t", { type: "tilt", direction: "forward" }, s.led("red")),
        on("b", { type: "buttonPressed" }, s.led("blue")),
      ]),
    );
    expect(h.result?.error?.code).toBe("hub-error");
    expect(h.device.subscriptions).toEqual([]);
  });

  it("STOP during setup ends the run and the late subscriptions are dropped", async () => {
    const h = harness();
    h.device.autoInitial = false;
    await h.start(program([on("b", { type: "buttonPressed" }, s.led("red"))]));
    h.runtime.stop();
    await settle();
    expect(h.result).toEqual({ reason: "stopped" });
    expect(h.device.subscriptions).toEqual([]);
  });
});

describe("expressions read the latest sensor values", () => {
  it("distance and color", async () => {
    const h = harness();
    await h.start(
      program([
        onStart("s", [
          s.waitUntil(cmp("<", sensor("distance", "D"), num(3))),
          s.if(cmp("=", sensor("color", "D"), num(9)), [s.led("red")], [s.led("blue")]),
        ]),
      ]),
    );
    h.device.pushColorDistance("D", { color: "red", distance: 2 });
    await advance(h.clock, 20);
    expect(h.device.log).toContain("led(red)");
    expect(h.device.log).not.toContain("led(blue)");
  });

  it("motorPosition is relative to the first reading of the run", async () => {
    const h = harness();
    h.device.initial.position = 100;
    await h.start(
      program([
        onStart("s", [
          s.waitUntil(cmp(">=", { type: "sensor", sensor: "motorPosition", port: "A" }, num(90))),
          s.led("red"),
        ]),
      ]),
    );
    h.device.pushPosition("A", 150);
    await advance(h.clock, 20);
    expect(h.device.log).not.toContain("led(red)");
    h.device.pushPosition("A", 190);
    await advance(h.clock, 20);
    expect(h.device.log).toContain("led(red)");
  });

  it("tilt and button", async () => {
    const h = harness();
    await h.start(
      program([
        onStart("s", [
          s.waitUntil({ type: "sensor", sensor: "button" }),
          s.waitUntil(cmp("<", { type: "sensor", sensor: "tiltY" }, num(-10))),
          s.led("green"),
        ]),
      ]),
    );
    h.device.pushButton(true);
    await advance(h.clock, 20);
    h.device.pushTilt(0, -30);
    await advance(h.clock, 20);
    expect(h.device.log).toContain("led(green)");
  });
});

describe("edge-triggered scripts", () => {
  const colorProgram = () =>
    program([
      on(
        "red",
        { type: "colorSeen", port: "D", color: "red" },
        s.led("red"),
        s.wait(100),
        s.led("black"),
      ),
    ]);

  it("fires on the false-to-true edge only, and re-arms when the condition is false again", async () => {
    const h = harness();
    await h.start(colorProgram());
    expect(h.device.log).toEqual(["subscribe(colorDistance.D)"]);
    see(h, "red");
    await advance(h.clock, 200);
    see(h, "red"); // still red: no new edge
    h.device.pushColorDistance("D", { color: "red", distance: 4 });
    await advance(h.clock, 200);
    expect(h.device.log.filter((l) => l === "led(red)")).toHaveLength(1);
    see(h, "blue");
    see(h, "red");
    await advance(h.clock, 200);
    expect(h.device.log.filter((l) => l === "led(red)")).toHaveLength(2);
  });

  it("an event whose script is still running is dropped, not queued", async () => {
    const h = harness();
    await h.start(colorProgram());
    see(h, "red");
    await advance(h.clock, 30);
    see(h, "blue");
    see(h, "red"); // script still waiting: dropped
    await advance(h.clock, 300);
    expect(h.device.log.filter((l) => l === "led(red)")).toHaveLength(1);
    see(h, "blue");
    see(h, "red");
    await advance(h.clock, 20);
    expect(h.device.log.filter((l) => l === "led(red)")).toHaveLength(2);
  });

  it("a condition already true when the run starts fires once", async () => {
    const h = harness();
    h.device.initial.colorDistance = { color: "red", distance: 10 };
    await h.start(colorProgram());
    await advance(h.clock, 20);
    expect(h.device.log).toContain("led(red)");
  });

  it("distanceBelow compares against the sensor's raw units", async () => {
    const h = harness();
    await h.start(
      program([on("near", { type: "distanceBelow", port: "D", value: 5 }, s.led("red"))]),
    );
    h.device.pushColorDistance("D", { color: "none", distance: 5 });
    await advance(h.clock, 20);
    expect(h.device.log).not.toContain("led(red)");
    h.device.pushColorDistance("D", { color: "none", distance: 4 });
    await advance(h.clock, 20);
    expect(h.device.log).toContain("led(red)");
  });

  it("the button fires on press and again after a release", async () => {
    const h = harness();
    await h.start(program([on("b", { type: "buttonPressed" }, s.led("red"))]));
    h.device.pushButton(true);
    await advance(h.clock, 20);
    h.device.pushButton(true);
    h.device.pushButton(false);
    h.device.pushButton(true);
    await advance(h.clock, 20);
    expect(h.device.log.filter((l) => l === "led(red)")).toHaveLength(2);
  });

  it.each([
    ["forward", 0, 30],
    ["backward", 0, -30],
    ["right", 30, 0],
    ["left", -30, 0],
  ] as const)("tilt %s fires past the threshold on its axis", async (direction, x, y) => {
    const h = harness();
    await h.start(program([on("t", { type: "tilt", direction }, s.led("red"))]));
    h.device.pushTilt(x / 3, y / 3); // 10 degrees: below the threshold
    await advance(h.clock, 20);
    expect(h.device.log).not.toContain("led(red)");
    h.device.pushTilt(x, y);
    await advance(h.clock, 20);
    expect(h.device.log).toContain("led(red)");
  });

  it("tilt re-arms only once it falls below the release angle (hysteresis)", async () => {
    const h = harness();
    await h.start(program([on("t", { type: "tilt", direction: "forward" }, s.led("red"))]));
    const fired = () => h.device.log.filter((l) => l === "led(red)").length;
    h.device.pushTilt(0, 21);
    await advance(h.clock, 20);
    expect(fired()).toBe(1);
    h.device.pushTilt(0, 17); // wobbling around the threshold: still tilted
    h.device.pushTilt(0, 22);
    await advance(h.clock, 20);
    expect(fired()).toBe(1);
    h.device.pushTilt(0, 14); // released
    h.device.pushTilt(0, 21);
    await advance(h.clock, 20);
    expect(fired()).toBe(2);
  });

  it("a program with only event scripts never finishes by itself; STOP resolves it", async () => {
    const h = harness();
    await h.start(colorProgram());
    await advance(h.clock, 5000);
    expect(h.result).toBeUndefined();
    expect(h.runtime.running).toBe(true);
    h.runtime.stop();
    await settle();
    expect(h.result).toEqual({ reason: "stopped" });
  });

  it("a stopAll inside an event script halts the run", async () => {
    const h = harness();
    await h.start(program([on("x", { type: "buttonPressed" }, s.stopAll())]));
    h.device.pushButton(true);
    await settle();
    expect(h.result).toEqual({ reason: "stopAll" });
    expect(h.device.subscriptions).toEqual([]);
  });

  it("sensor updates after the run ended do nothing", async () => {
    const h = harness();
    await h.start(colorProgram());
    h.runtime.stop();
    h.device.log.length = 0;
    see(h, "red");
    await advance(h.clock, 50);
    expect(h.device.log).toEqual([]);
  });
});
