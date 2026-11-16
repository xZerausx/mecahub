import { describe, expect, it } from "vitest";
import en from "../../../content/i18n/en.json";
import es from "../../../content/i18n/es.json";
import { BLOCK_STYLES, HAT_STYLE, blockDefinitions, messageKeys } from "./definitions.js";
import { iconSrc } from "./icons.js";
import { BLOCK_SPECS, fieldArgs, inputArgs } from "./spec.js";

const catalog = en as Record<string, string>;
const ADVANCED = BLOCK_SPECS.filter((b) => b.level === "advanced");
const ICON_ROWS = BLOCK_SPECS.filter((b) => b.level === "icons");

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
    for (const row of ADVANCED) {
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
      if (!def.type.startsWith("mh_icon_")) {
        expect(def.message0, def.type).toBe(messages[`blocks.${def.type}.message`]);
      }
      expect(def.tooltip, def.type).toBe(messages[`blocks.${def.type}.tooltip`]);
    }
  });

  it("gives icon blocks alt text and option alt text, and no message", () => {
    for (const row of ICON_ROWS) {
      expect(messages[`blocks.${row.type}.message`], row.type).toBeUndefined();
      expect(messages[`blocks.${row.type}.alt`], row.type).toBeTypeOf("string");
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
    expect(ICON_ROWS.some((b) => inputArgs(b).length > 0)).toBe(false);
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
    expect(hats).toHaveLength(6); // five Advanced hats and the Icons "when start" flag
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

  describe("icons level", () => {
    const iconDefs = ICON_ROWS.map((r) => def(r.type));

    it("contains no literal text: message0 is only tokens and every option is an image", () => {
      for (const d of iconDefs) {
        expect(d.message0 ?? "", d.type).toMatch(/^%\d+( %\d+)*$/);
        expect(d).not.toHaveProperty("message1");
        for (const arg of d.args0 ?? []) {
          expect(["field_image", "field_number", "field_dropdown"], d.type).toContain(arg.type);
          if (arg.type === "field_dropdown") {
            for (const [label] of arg.options) {
              expect(typeof label, `${d.type} option`).toBe("object");
            }
          }
        }
        expect((d.message0 ?? "").match(/%\d+/g), d.type).toHaveLength(d.args0?.length ?? 0);
      }
    });

    it("shows the block icon as a field_image with a data URI and alt text from the catalog", () => {
      const forward = def("mh_icon_forward").args0?.[0];
      expect(forward).toEqual({
        type: "field_image",
        name: "ICON",
        src: iconSrc("forward"),
        width: 40,
        height: 40,
        alt: catalog["blocks.mh_icon_forward.alt"],
      });
    });

    it("emits image dropdown options with the swatch, alt text and IR value", () => {
      const dropdown = def("mh_icon_led").args0?.find((a) => a.type === "field_dropdown");
      expect(dropdown).toMatchObject({ name: "COLOR" });
      const options = dropdown && "options" in dropdown ? dropdown.options : [];
      expect(options.map(([, v]) => v)).toEqual([
        "green",
        "red",
        "blue",
        "yellow",
        "white",
        "black",
      ]);
      expect(options[1]).toEqual([
        {
          src: iconSrc("swatch_red"),
          width: 32,
          height: 32,
          alt: catalog["blocks.mh_icon_led.option.red"],
        },
        "red",
      ]);
    });

    it("bounds the steps field to integers 1..9", () => {
      expect(def("mh_icon_turn_left").args0?.[1]).toEqual({
        type: "field_number",
        name: "STEPS",
        value: 1,
        min: 1,
        max: 9,
        precision: 1,
      });
      expect(def("mh_icon_wait").args0?.[1]).toMatchObject({ name: "SECONDS", min: 1, max: 9 });
    });

    it("draws the flag as a hat and the stop as a terminal", () => {
      expect(def("mh_icon_when_start")).toMatchObject({ style: HAT_STYLE, nextStatement: null });
      expect(def("mh_icon_stop")).toMatchObject({ previousStatement: null });
      expect(def("mh_icon_stop")).not.toHaveProperty("nextStatement");
    });
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
