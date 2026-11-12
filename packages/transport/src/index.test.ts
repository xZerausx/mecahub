import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as api from "./index.js";
import * as web from "./web/index.js";

describe("@mecahub/transport", () => {
  it("exports the public runtime API", () => {
    expect(Object.keys(api).sort()).toEqual(
      [
        "FakeTransport",
        "LWP3_CHARACTERISTIC_UUID",
        "LWP3_SERVICE_UUID",
        "TransportError",
        "TransportErrorCode",
        "createWriteQueue",
      ].sort(),
    );
  });

  it("does not re-export the web adapter from the root", () => {
    for (const name of Object.keys(web)) expect(api).not.toHaveProperty(name);
    expect(readFileSync(new URL("./index.ts", import.meta.url), "utf8")).not.toMatch(/web/i);
  });

  it("exports the web adapter API", () => {
    expect(Object.keys(web).sort()).toEqual(
      ["WebBleTransport", "createWebBleTransport", "isWebBluetoothAvailable"].sort(),
    );
  });

  it("publishes the web adapter only through the './web' subpath", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      exports: Record<string, string>;
    };
    expect(pkg.exports).toEqual({ ".": "./src/index.ts", "./web": "./src/web/index.ts" });
  });
});
