import { describe, expect, it } from "vitest";
import en from "../../../content/i18n/en.json";
import es from "../../../content/i18n/es.json";
import { BLOCK_STYLES, HAT_STYLE, blockDefinitions, messageKeys } from "./definitions.js";
import { BLOCK_SPECS, fieldArgs, inputArgs } from "./spec.js";

const catalogs = { en, es } as Record<string, Record<string, string>>;
const nonStatementArgs = (type: string) => {
  const row = BLOCK_SPECS.find((b) => b.type === type);
  return (row?.args ?? []).filter((a) => a.kind !== "statements");
};
const tokens = (message: string): string[] => (message.match(/%\d+/g) ?? []).sort();
const expectedTokens = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `%${i + 1}`).sort();

describe.each(Object.keys(catalogs))("block messages (%s)", (locale) => {
  const messages = catalogs[locale] as Record<string, string>;

  it("defines every key the spec needs, non-empty", () => {
    for (const key of messageKeys()) {
      expect(messages[key], key).toBeTypeOf("string");
      expect((messages[key] as string).trim(), key).not.toBe("");
    }
  });

  it("has no blocks.* key the spec does not use", () => {
    const used = new Set(messageKeys());
    const extra = Object.keys(messages).filter((k) => k.startsWith("blocks.") && !used.has(k));
    expect(extra.filter((k) => !k.startsWith("blocks.category."))).toEqual([]);
  });

  it("uses exactly the tokens %1..%n in each message, n = number of arguments", () => {
    for (const row of BLOCK_SPECS) {
      const message = messages[`blocks.${row.type}.message`] as string;
      expect(tokens(message), row.type).toEqual(expectedTokens(nonStatementArgs(row.type).length));
      for (const input of inputArgs(row).filter((i) => i.kind === "statements")) {
        const label = messages[`blocks.${row.type}.input.${input.name}`] as string;
        expect(tokens(label), `${row.type}.${input.name}`).toEqual(["%1"]);
      }
    }
  });

  it("builds a definition for every spec row", () => {
    const defs = blockDefinitions(messages);
    expect(defs.map((d) => d.type)).toEqual(BLOCK_SPECS.map((b) => b.type));
    for (const def of defs) {
      expect(def.message0, def.type).toBe(messages[`blocks.${def.type}.message`]);
      expect(def.tooltip, def.type).toBe(messages[`blocks.${def.type}.tooltip`]);
    }
  });
});

describe("wording for kids", () => {
  it("avoids programmer jargon and regional words in every block text", () => {
    for (const [locale, catalog] of Object.entries(catalogs)) {
      for (const [key, text] of Object.entries(catalog)) {
        if (!key.startsWith("blocks.")) continue;
        expect(text, `${locale} ${key}`).not.toMatch(/script|parlante|altavoz|ejecuta/i);
      }
    }
  });
});

describe("time is shown in seconds", () => {
  it("says seconds in every message of a block with a time input", () => {
    const timed = BLOCK_SPECS.filter((b) =>
      inputArgs(b).some((i) => i.kind === "value" && i.seconds),
    );
    expect(timed.map((b) => b.type).sort()).toEqual(
      ["mh_drive_for_time", "mh_motor_run_for_time", "mh_wait"].sort(),
    );
    for (const row of timed) {
      expect(en[`blocks.${row.type}.message` as keyof typeof en], row.type).toMatch(/second/i);
      expect(es[`blocks.${row.type}.message` as keyof typeof es], row.type).toMatch(/segundo/i);
    }
  });
});

describe("blockDefinitions", () => {
  const defs = Object.fromEntries(blockDefinitions(en).map((d) => [d.type, d]));
  const def = (type: string) => {
    const found = defs[type];
    if (!found) throw new Error(`no definition for ${type}`);
    return found;
  };

  it("follows the spec shape for connections", () => {
    expect(def("mh_when_start")).toMatchObject({ nextStatement: null });
    expect(def("mh_when_start")).not.toHaveProperty("hat");
    expect(def("mh_when_start")).not.toHaveProperty("previousStatement");
    expect(def("mh_wait")).toMatchObject({ previousStatement: null, nextStatement: null });
    expect(def("mh_stop_all")).toMatchObject({ previousStatement: null });
    expect(def("mh_stop_all")).not.toHaveProperty("nextStatement");
    expect(def("mh_number")).toMatchObject({ output: "Number" });
    expect(def("mh_compare")).toMatchObject({ output: "Boolean" });
  });

  it("draws hats with a cap through a named block style, the only way Blockly 13.4.0 reads it", () => {
    // jsonInit ignores a top-level `hat`; an inline `style` object is consumed (set to null) by the
    // first instance of a shared definition. A named style defined in the theme has neither problem.
    const hats = Object.values(defs).filter(
      (d) => d.nextStatement === null && !("previousStatement" in d),
    );
    expect(hats).toHaveLength(5);
    for (const hat of hats) {
      expect(hat.style, hat.type).toBe(HAT_STYLE);
      expect(hat).not.toHaveProperty("colour"); // Blockly rejects a style together with a colour
      expect(hat).not.toHaveProperty("hat");
    }
    expect(BLOCK_STYLES[HAT_STYLE]).toEqual({ colourPrimary: "45", hat: "cap" });
    expect(def("mh_wait")).not.toHaveProperty("style");
    expect(def("mh_wait").colour).toBeTypeOf("number");
  });

  it("emits dropdowns with labels from the catalog and IR values", () => {
    const port = def("mh_motor_start").args0?.[0];
    expect(port).toMatchObject({ type: "field_dropdown", name: "PORT" });
    expect(port && "options" in port && port.options).toEqual([
      ["A", "A"],
      ["B", "B"],
      ["C", "C"],
      ["D", "D"],
    ]);
    const bool = def("mh_boolean").args0?.[0];
    expect(bool && "options" in bool && bool.options).toEqual([
      [en["blocks.mh_boolean.option.true"], "true"],
      [en["blocks.mh_boolean.option.false"], "false"],
    ]);
  });

  it("emits value inputs with their check, number and variable fields", () => {
    expect(def("mh_motor_start").args0?.[1]).toEqual({
      type: "input_value",
      name: "SPEED",
      check: "Number",
    });
    expect(def("mh_when_distance_below").args0?.[1]).toMatchObject({
      type: "field_number",
      name: "VALUE",
      value: 5,
    });
    expect(def("mh_set_variable").args0?.[0]).toMatchObject({
      type: "field_variable",
      name: "VAR",
    });
  });

  it("puts each statement input on its own line", () => {
    const ifElse = def("mh_if_else");
    expect(ifElse.message0).toBe(en["blocks.mh_if_else.message"]);
    expect(ifElse.message1).toBe(en["blocks.mh_if_else.input.THEN"]);
    expect(ifElse.args1).toEqual([{ type: "input_statement", name: "THEN" }]);
    expect(ifElse.message2).toBe(en["blocks.mh_if_else.input.ELSE"]);
    expect(ifElse.args2).toEqual([{ type: "input_statement", name: "ELSE" }]);
    // a block with only a statement input still has a first line
    expect(def("mh_forever").message0).toBe(en["blocks.mh_forever.message"]);
    expect(def("mh_forever").args0).toBeUndefined();
    expect(def("mh_forever").args1).toEqual([{ type: "input_statement", name: "BODY" }]);
  });

  it("is pure: the same messages give equal output and the input is not mutated", () => {
    const copy = structuredClone(en);
    expect(blockDefinitions(en)).toEqual(blockDefinitions(copy));
    expect(en).toEqual(copy);
  });

  it("throws on a missing message instead of showing a key", () => {
    const rest: Record<string, string> = { ...en };
    delete rest["blocks.mh_wait.message"];
    expect(() => blockDefinitions(rest)).toThrow(/blocks\.mh_wait\.message/);
  });

  it("never collides option values inside one block", () => {
    for (const row of BLOCK_SPECS) {
      const values = fieldArgs(row).flatMap((f) =>
        f.kind === "enum" ? [...f.values] : f.kind === "boolean" ? ["true", "false"] : [],
      );
      expect(new Set(values).size, row.type).toBe(values.length);
    }
  });
});
