import { HubError } from "@mecahub/hub";
import { RuntimeError } from "@mecahub/runtime";
import { TransportError } from "@mecahub/transport";
import { describe, expect, it } from "vitest";
import { fromRunError, fromRunResult, fromTransportError, isLinkLoss } from "./problem.js";

// Vectors: error classes built by hand from the public constructors of hub, runtime and transport
// ('derivado del layout').

describe("fromTransportError (a failed connect)", () => {
  it.each(["gatt", "no-device", "not-connected"] as const)("%s -> connect-failed", (code) => {
    expect(fromTransportError(new TransportError(code))).toBe("connect-failed");
  });

  it("a dismissed chooser is not a problem", () => {
    expect(fromTransportError(new TransportError("cancelled"))).toBeUndefined();
  });

  it("unsupported is not a badge: the button explains it instead", () => {
    expect(fromTransportError(new TransportError("unsupported"))).toBeUndefined();
  });

  it("a hub that never answered while connecting (HubError timeout) -> connect-failed", () => {
    expect(fromTransportError(new HubError("timeout"))).toBe("connect-failed");
  });

  it("any other failure while connecting -> connect-failed", () => {
    expect(fromTransportError(new Error("boom"))).toBe("connect-failed");
    expect(fromTransportError("weird")).toBe("connect-failed");
  });
});

describe("isLinkLoss", () => {
  it("knows the three ways the link ends", () => {
    expect(isLinkLoss(new HubError("link-lost"))).toBe(true);
    expect(isLinkLoss(new TransportError("not-connected"))).toBe(true);
    expect(isLinkLoss(new HubError("disposed"))).toBe(true);
  });
  it("does not take a rejection or a timeout for a lost link", () => {
    expect(isLinkLoss(new HubError("rejected"))).toBe(false);
    expect(isLinkLoss(new HubError("timeout"))).toBe(false);
    expect(isLinkLoss(new Error("x"))).toBe(false);
  });
});

describe("fromRunError", () => {
  it("missing-device and sensor-timeout map one to one", () => {
    expect(fromRunError(new RuntimeError("missing-device", "x"))).toBe("missing-device");
    expect(fromRunError(new RuntimeError("sensor-timeout", "x"))).toBe("sensor-timeout");
  });

  it("stop-failed maps to stop-failed", () => {
    expect(fromRunError(new RuntimeError("stop-failed", "x"))).toBe("stop-failed");
  });

  it("hub-error caused by a lost link -> link-lost", () => {
    expect(
      fromRunError(new RuntimeError("hub-error", "x", { cause: new HubError("link-lost") })),
    ).toBe("link-lost");
    expect(
      fromRunError(
        new RuntimeError("hub-error", "x", { cause: new TransportError("not-connected") }),
      ),
    ).toBe("link-lost");
  });

  it("hub-error rejected or busy -> hub-error", () => {
    expect(
      fromRunError(new RuntimeError("hub-error", "x", { cause: new HubError("rejected") })),
    ).toBe("hub-error");
    expect(fromRunError(new RuntimeError("hub-error", "x", { cause: new HubError("busy") }))).toBe(
      "hub-error",
    );
    expect(fromRunError(new RuntimeError("hub-error", "x"))).toBe("hub-error");
  });

  it("an invalid program or a busy run is not a hub problem (the editor marks blocks instead)", () => {
    expect(fromRunError(new RuntimeError("invalid-program", "x"))).toBeUndefined();
    expect(fromRunError(new RuntimeError("busy", "x"))).toBeUndefined();
  });
});

describe("fromRunResult", () => {
  it("only an error result has a problem", () => {
    expect(fromRunResult({ reason: "completed" })).toBeUndefined();
    expect(fromRunResult({ reason: "stopped" })).toBeUndefined();
    expect(fromRunResult({ reason: "error", error: new RuntimeError("missing-device", "x") })).toBe(
      "missing-device",
    );
  });
});
