import { TransportError, TransportErrorCode } from "@mecahub/transport";
import { describe, expect, it } from "vitest";
import en from "../../../../content/i18n/en.json";
import { errorKey } from "./error-key.js";

describe("errorKey", () => {
  it("maps every TransportError code to an existing i18n key", () => {
    const keys = new Set<string>();
    for (const code of Object.values(TransportErrorCode)) {
      const key = errorKey(new TransportError(code));
      expect(Object.keys(en), code).toContain(key);
      keys.add(key);
    }
    expect(keys.size).toBe(Object.values(TransportErrorCode).length);
  });

  it("uses a generic message for anything else", () => {
    const key = errorKey(new Error("boom"));
    expect(key).toBe("dev.connect.error.unknown");
    expect(Object.keys(en)).toContain(key);
  });
});
