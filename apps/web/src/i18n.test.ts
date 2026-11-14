import { describe, expect, it } from "vitest";
import devEn from "../../../content/i18n/dev.en.json";
import devEs from "../../../content/i18n/dev.es.json";
import en from "../../../content/i18n/en.json";
import es from "../../../content/i18n/es.json";
import { createDevTranslator } from "./dev/dev-i18n.js";
import { createTranslator, detectLocale, type MessageKey } from "./i18n.js";

describe("i18n catalogs", () => {
  it("en and es define exactly the same keys", () => {
    expect(Object.keys(es).sort()).toEqual(Object.keys(en).sort());
  });

  it("the developer catalogs define exactly the same keys in en and es", () => {
    expect(Object.keys(devEs).sort()).toEqual(Object.keys(devEn).sort());
  });

  it("no message is empty", () => {
    for (const catalog of [en, es, devEn, devEs]) {
      for (const [key, value] of Object.entries(catalog)) {
        expect(value.trim(), key).not.toBe("");
      }
    }
  });

  it("the app catalog has no dev.* key and the developer one only dev.* keys", () => {
    for (const catalog of [en, es]) {
      expect(Object.keys(catalog).filter((k) => k.startsWith("dev."))).toEqual([]);
    }
    for (const catalog of [devEn, devEs]) {
      expect(Object.keys(catalog).filter((k) => !k.startsWith("dev."))).toEqual([]);
    }
  });
});

describe("createTranslator", () => {
  it("translates by locale", () => {
    expect(createTranslator("en")("app.title")).toBe(en["app.title"]);
    expect(createDevTranslator("en")("dev.connect.connect")).toBe(devEn["dev.connect.connect"]);
    expect(createDevTranslator("es")("dev.connect.connect")).toBe(devEs["dev.connect.connect"]);
    expect(devEs["dev.connect.connect"]).not.toBe(devEn["dev.connect.connect"]);
  });

  it("does not know the developer messages: they are not in the production catalog", () => {
    expect(createTranslator("en")("dev.lab.title" as MessageKey)).toBe("dev.lab.title");
    expect(createTranslator("es")("dev.connect.connect" as MessageKey)).toBe("dev.connect.connect");
  });

  it("interpolates {params}", () => {
    expect(createDevTranslator("en")("dev.connect.batteryValue", { percent: 87 })).toBe("87%");
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
