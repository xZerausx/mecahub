// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { createFakeHubTransport, type FakeHubControls } from "./e2e-fake-hub.js";

type WithControls = { __fakeHub?: FakeHubControls };
afterEach(() => {
  delete (globalThis as WithControls).__fakeHub;
});

describe("createFakeHubTransport (browser tests only)", () => {
  it("is a transport whose other end is a simulated hub, and exposes a way to drop its link", async () => {
    const transport = createFakeHubTransport();
    expect(transport.state).toBe("idle");
    await transport.requestDevice();
    await transport.connect();
    expect(transport.state).toBe("connected");
    const controls = (globalThis as WithControls).__fakeHub;
    expect(controls).toBeDefined();
    controls?.drop();
    expect(transport.state).toBe("disconnected");
  });
});
