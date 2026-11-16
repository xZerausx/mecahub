import { describe, expect, it } from "vitest";
import en from "../../../content/i18n/en.json";
import es from "../../../content/i18n/es.json";
import { CATEGORY_ORDER, toolbox } from "./toolbox.js";
import { BLOCK_SPECS, inputArgs, specFor } from "./spec.js";

type Entry = { kind: string; type?: string; inputs?: Record<string, unknown> };
type Category = { kind: string; name: string; colour: string; contents: Entry[] };

const ADVANCED = BLOCK_SPECS.filter((b) => b.level === "advanced");

const categories = (messages: Record<string, string>): Category[] => {
  const result = toolbox(messages);
  expect(result.kind).toBe("categoryToolbox");
  return (result.contents ?? []) as unknown as Category[];
};
const blocksOf = (cats: Category[]): Entry[] => cats.flatMap((c) => c.contents);

describe("toolbox", () => {
  const cats = categories(en);

  it("offers every block of the spec exactly once", () => {
    const types = blocksOf(cats).map((b) => b.type);
    expect(types.sort()).toEqual(ADVANCED.map((b) => b.type).sort());
  });

  it("groups blocks by the category in the spec, in a fixed order", () => {
    expect(cats.map((c) => c.contents.length > 0)).toEqual(cats.map(() => true));
    for (const cat of cats) {
      for (const entry of cat.contents) {
        const id = CATEGORY_ORDER[cats.indexOf(cat)];
        expect(specFor(entry.type ?? "")?.category, entry.type).toBe(id);
      }
    }
    expect(cats).toHaveLength(CATEGORY_ORDER.length);
  });

  it("gives every Number value input an mh_number shadow with its default", () => {
    for (const spec of ADVANCED) {
      const entry = blocksOf(cats).find((b) => b.type === spec.type);
      const numeric = inputArgs(spec).filter((i) => i.kind === "value" && i.check === "Number");
      for (const input of numeric) {
        const initial = input.kind === "value" ? (input.initial ?? 0) : 0;
        expect(entry?.inputs?.[input.name], `${spec.type}.${input.name}`).toEqual({
          shadow: { type: "mh_number", fields: { NUM: initial } },
        });
      }
      // nothing else gets a shadow: Boolean and statement inputs stay empty
      expect(Object.keys(entry?.inputs ?? {}).sort(), spec.type).toEqual(
        numeric.map((i) => i.name).sort(),
      );
    }
  });

  it("shows time defaults in seconds", () => {
    const wait = blocksOf(cats).find((b) => b.type === "mh_wait");
    expect(wait?.inputs?.TIME).toEqual({ shadow: { type: "mh_number", fields: { NUM: 1 } } });
  });

  it("takes a level: advanced is the default and icons is a flat flyout with no categories", () => {
    expect(toolbox(en, "advanced")).toEqual(toolbox(en));
    const flyout = toolbox(en, "icons");
    expect(flyout.kind).toBe("flyoutToolbox");
    for (const entry of (flyout.contents ?? []) as unknown as Entry[]) {
      expect(entry.kind).toBe("block");
      expect(specFor(entry.type ?? "")?.level).toBe("icons");
    }
  });

  it("offers every icon block once in the icons flyout, with no shadows and no names", () => {
    const flyout = toolbox(en, "icons");
    const entries = (flyout.contents ?? []) as unknown as Entry[];
    expect(entries.map((e) => e.type)).toEqual(
      BLOCK_SPECS.filter((b) => b.level === "icons").map((b) => b.type),
    );
    expect(entries.length).toBe(8);
    expect(JSON.stringify(flyout)).not.toMatch(/"name"|"inputs"|"category"/);
    expect(toolbox(es, "icons")).toEqual(flyout); // nothing in it depends on the language
  });

  it("names every category from the catalog, in both languages", () => {
    for (const messages of [en, es] as Record<string, string>[]) {
      for (const id of CATEGORY_ORDER) {
        expect(messages[`blocks.category.${id}`], id).toBeTypeOf("string");
      }
    }
    expect(cats.map((c) => c.name)).toEqual(
      CATEGORY_ORDER.map((id) => en[`blocks.category.${id}` as keyof typeof en]),
    );
    expect(categories(es)[0]?.name).not.toBe(cats[0]?.name);
  });

  it("gives each category a colour that matches its blocks", () => {
    for (const cat of cats) expect(cat.colour).toMatch(/^\d+$/);
    expect(new Set(cats.map((c) => c.colour)).size).toBe(cats.length);
  });

  it("is pure and throws on a missing category name", () => {
    expect(toolbox(en)).toEqual(toolbox(structuredClone(en)));
    const rest: Record<string, string> = { ...en };
    delete rest["blocks.category.motors"];
    expect(() => toolbox(rest)).toThrow(/blocks\.category\.motors/);
  });
});
