import { decode, encodeHubProperty, encodePortOutputCommand, splitFrames } from "@mecahub/lwp3";
import { FakeBluetooth } from "@mecahub/transport/testing";
import { WebBleTransport } from "@mecahub/transport/web";
import { describe, expect, it } from "vitest";
import { SimulatedHub, defaultMoveHubConfig } from "../hub/index.js";
import { bridgeFakeBluetooth } from "./fake-bluetooth-bridge.js";

const requestName = encodeHubProperty({
  type: "hubProperty",
  operation: "requestUpdate",
  property: "advertisingName",
});

function make() {
  const hub = new SimulatedHub(defaultMoveHubConfig());
  const bluetooth = new FakeBluetooth();
  const bridge = bridgeFakeBluetooth(bluetooth, hub);
  const transport = new WebBleTransport(bluetooth);
  const notifications: Uint8Array[] = [];
  transport.onNotify((bytes) => notifications.push(bytes));
  return { hub, bluetooth, bridge, transport, notifications };
}

describe("bridgeFakeBluetooth", () => {
  it("relays app writes to the hub and hub frames back as notifications (derivado del layout)", async () => {
    const { hub, transport, notifications } = make();
    await transport.requestDevice();
    await transport.connect();
    expect(hub.connected).toBe(true);
    await transport.write(requestName);
    const messages = notifications.flatMap((n) => splitFrames(n).frames).map((f) => decode(f));
    expect(
      messages.some(
        (m) => "type" in m && m.type === "hubProperty" && m.property === "advertisingName",
      ),
    ).toBe(true);
  });

  it("a motor command written through the link moves the simulated motor", async () => {
    const { hub, transport } = make();
    await transport.requestDevice();
    await transport.connect();
    await transport.write(requestName); // the hub announces its ports on the first message
    await transport.write(
      encodePortOutputCommand({
        port: 0,
        startup: "immediate",
        completion: "none",
        command: {
          sub: "startSpeed",
          speed: 50,
          maxPower: 100,
          useProfile: { acc: false, dec: false },
        },
      }),
    );
    expect(hub.motorState(0).running).toBe(true);
    expect(hub.motorState(0).speed).toBe(50);
  });

  it("a link drop on the device side disconnects the hub", async () => {
    const { hub, bluetooth, transport } = make();
    await transport.requestDevice();
    await transport.connect();
    bluetooth.device.drop();
    expect(hub.connected).toBe(false);
  });

  it("dispose detaches: later hub frames do not reach the link", async () => {
    const { hub, bridge, transport, notifications } = make();
    await transport.requestDevice();
    await transport.connect();
    bridge.dispose();
    notifications.length = 0;
    hub.receive(requestName);
    expect(notifications).toHaveLength(0);
  });
});
