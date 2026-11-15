import { encodeHubProperty } from "@mecahub/lwp3";
import type { SimulatedHub } from "../hub/simulated-hub.js";

/**
 * Connects the hub and sends a harmless first message (a name request), so the hub's attached-IO
 * burst goes out now (default `announcePortsOn: "firstMessage"`). Callers clear what was sent.
 */
export function connectAndSpeak(hub: SimulatedHub): void {
  hub.connect();
  hub.receive(
    encodeHubProperty({
      type: "hubProperty",
      operation: "requestUpdate",
      property: "advertisingName",
    }),
  );
}
