import { describe, expect, it } from "vitest";
import en from "../../../content/i18n/en.json";
import es from "../../../content/i18n/es.json";
import { createTranslator, detectLocale, type MessageKey } from "./i18n.js";

describe("i18n catalogs", () => {
  it("en and es define exactly the same keys", () => {
    expect(Object.keys(es).sort()).toEqual(Object.keys(en).sort());
  });

  it("no message is empty", () => {
    for (const catalog of [en, es]) {
      for (const [key, value] of Object.entries(catalog)) {
        expect(value.trim(), key).not.toBe("");
      }
    }
  });
});

describe("createTranslator", () => {
  it("translates by locale", () => {
    expect(createTranslator("en")("dev.connect.connect")).toBe(en["dev.connect.connect"]);
    expect(createTranslator("es")("dev.connect.connect")).toBe(es["dev.connect.connect"]);
    expect(es["dev.connect.connect"]).not.toBe(en["dev.connect.connect"]);
  });

  it("interpolates {params}", () => {
    expect(createTranslator("en")("dev.connect.batteryValue", { percent: 87 })).toBe("87%");
  });

  it("falls back to the key itself when it is unknown", () => {
    expect(createTranslator("en")("nope.missing" as MessageKey)).toBe("nope.missing");
  });
});

describe("detectLocale", () => {
  it("picks es for Spanish variants and en otherwise", () => {
    expect(detectLocale("es-AR")).toBe("es");
    expect(detectLocale("es")).toBe("es");
    expect(detectLocale("en-US")).toBe("en");
    expect(detectLocale("fr")).toBe("en");
    expect(detectLocale(undefined)).toBe("en");
  });
});
