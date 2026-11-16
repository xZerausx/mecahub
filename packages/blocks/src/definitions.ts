import { iconSrc } from "./icons.js";
import { BLOCK_SPECS, fieldArgs, type Arg, type BlockSpec, type CategoryId } from "./spec.js";

/** The i18n catalog: flat `key -> text` (content/i18n/<locale>.json). */
export type Messages = Readonly<Record<string, string>>;

/** A dropdown option shown as a picture; `alt` is its accessible name. */
export type ImageOption = { src: string; width: number; height: number; alt: string };

/** One entry of a Blockly JSON `argsN` list. Plain data: no Blockly runtime is needed to build it. */
export type ArgJson =
  | {
      type: "field_dropdown";
      name: string;
      options: [label: string | ImageOption, value: string][];
    }
  | { type: "field_number"; name: string; value: number }
  | { type: "field_number"; name: string; value: number; min: number; max: number; precision: 1 }
  | { type: "field_image"; name: string; src: string; width: number; height: number; alt: string }
  | { type: "field_variable"; name: string; variable: string }
  | { type: "input_value"; name: string; check: "Number" | "Boolean" }
  | { type: "input_statement"; name: string };

/** A block definition in Blockly's JSON format (`Blockly.common.createBlockDefinitionsFromJsonArray`). */
export type BlockJson = {
  type: string;
  tooltip: string;
  colour?: number;
  inputsInline: boolean;
  /** Hats only: the name of `BLOCK_STYLES`' entry, which carries the colour and the cap. */
  style?: typeof HAT_STYLE;
  previousStatement?: null;
  nextStatement?: null;
  output?: "Number" | "Boolean";
} & { [line: `message${number}`]: string } & { [line: `args${number}`]: ArgJson[] };

/** Blockly hues (0-360), one per toolbox category. */
export const CATEGORY_COLOURS: Readonly<Record<CategoryId, number>> = {
  events: 45,
  motors: 210,
  drive: 230,
  lightSound: 290,
  control: 120,
  variables: 20,
  sensors: 180,
  math: 260,
  logic: 330,
};

/** Block style of the hats. */
export const HAT_STYLE = "mh_hat" as const;

/**
 * Blockly 13.4.0 draws the cap of a hat only from a block style that has `hat: "cap"` (jsonInit
 * ignores a top-level `hat`, and an inline `style` object would be consumed by the first
 * instance). The editor must add this to its theme: `Blockly.Theme.defineTheme(name, { base,
 * blockStyles: BLOCK_STYLES })`.
 */
export const BLOCK_STYLES = {
  [HAT_STYLE]: { colourPrimary: String(CATEGORY_COLOURS.events), hat: "cap" },
} as const;

const key = (type: string, rest: string): string => `blocks.${type}.${rest}`;
const VARIABLE_DEFAULT = "blocks.variable.default";

const optionValues = (field: Arg): readonly string[] =>
  field.kind === "enum" ? field.values : field.kind === "boolean" ? ["true", "false"] : [];

/** Every i18n key the catalogue needs; the tests check each exists in every locale. */
export const messageKeys = (): string[] => [
  VARIABLE_DEFAULT,
  ...BLOCK_SPECS.flatMap((row) => [
    // Icon blocks show no text: their `.alt` (and `.option.<v>`) only label the pictures.
    ...(row.level === "icons" ? [key(row.type, "alt")] : [key(row.type, "message")]),
    key(row.type, "tooltip"),
    ...fieldArgs(row).flatMap((f) => optionValues(f).map((v) => key(row.type, `option.${v}`))),
    ...row.args.flatMap((a) => (a.kind === "statements" ? [key(row.type, `input.${a.name}`)] : [])),
  ]),
];

const text = (messages: Messages, k: string): string => {
  const value = messages[k];
  if (value === undefined) throw new Error(`missing message "${k}"`);
  return value;
};

/** Size, in pixels at scale 1, of the block picture and of a dropdown swatch. */
const ICON_SIZE = 40;
const SWATCH_SIZE = 32;

const argJson = (messages: Messages, row: BlockSpec, arg: Arg): ArgJson => {
  switch (arg.kind) {
    case "enum":
    case "boolean":
      return {
        type: "field_dropdown",
        name: arg.name,
        options: optionValues(arg).map((v) => {
          const alt = text(messages, key(row.type, `option.${v}`));
          const icon = arg.kind === "enum" ? arg.icons?.[v] : undefined;
          return [
            icon ? { src: iconSrc(icon), width: SWATCH_SIZE, height: SWATCH_SIZE, alt } : alt,
            v,
          ];
        }),
      };
    case "icon":
      return {
        type: "field_image",
        name: arg.name,
        src: iconSrc(arg.icon),
        width: ICON_SIZE,
        height: ICON_SIZE,
        alt: text(messages, key(row.type, "alt")),
      };
    case "count":
      return {
        type: "field_number",
        name: arg.name,
        value: arg.initial,
        min: arg.min,
        max: arg.max,
        precision: 1,
      };
    case "number":
      return { type: "field_number", name: arg.name, value: arg.initial };
    case "variable":
      return { type: "field_variable", name: arg.name, variable: text(messages, VARIABLE_DEFAULT) };
    case "value":
      return { type: "input_value", name: arg.name, check: arg.check };
    case "statements":
      return { type: "input_statement", name: arg.name };
  }
};

const define = (messages: Messages, row: BlockSpec): BlockJson => {
  const inline = row.args.filter((a) => a.kind !== "statements");
  const def: BlockJson = {
    type: row.type,
    // An icon block has no words: its message is only the tokens of its pictures and fields.
    message0:
      row.level === "icons"
        ? inline.map((_, i) => `%${i + 1}`).join(" ")
        : text(messages, key(row.type, "message")),
    tooltip: text(messages, key(row.type, "tooltip")),
    colour: CATEGORY_COLOURS[row.category],
    inputsInline: true,
  };
  if (inline.length > 0) def.args0 = inline.map((a) => argJson(messages, row, a));
  row.args
    .filter((a) => a.kind === "statements")
    .forEach((a, i) => {
      def[`message${i + 1}`] = text(messages, key(row.type, `input.${a.name}`));
      def[`args${i + 1}`] = [argJson(messages, row, a)];
    });
  switch (row.shape) {
    case "hat":
      def.style = HAT_STYLE;
      delete def.colour;
      def.nextStatement = null;
      break;
    case "statement":
      def.previousStatement = null;
      def.nextStatement = null;
      break;
    case "terminal":
      def.previousStatement = null;
      break;
    case "number":
      def.output = "Number";
      break;
    case "boolean":
      def.output = "Boolean";
      break;
  }
  return def;
};

/**
 * Blockly JSON definitions for every block in the spec, with labels, tooltips and dropdown options
 * from `messages`. Pure; throws on a missing message rather than rendering a key. The editor
 * registers the result with `Blockly.common.defineBlocksWithJsonArray` (apps/web, not this package).
 */
export const blockDefinitions = (messages: Messages): BlockJson[] =>
  BLOCK_SPECS.map((row) => define(messages, row));
