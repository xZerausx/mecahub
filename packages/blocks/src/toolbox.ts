import type { utils } from "blockly";
import { CATEGORY_COLOURS, type Messages } from "./definitions.js";
import { BLOCK_SPECS, inputArgs, type CategoryId, type Level } from "./spec.js";

/** Toolbox categories, in the order the editor lists them. */
export const CATEGORY_ORDER: readonly CategoryId[] = [
  "events",
  "motors",
  "drive",
  "lightSound",
  "control",
  "variables",
  "sensors",
  "math",
  "logic",
];

export const categoryKey = (id: CategoryId): string => `blocks.category.${id}`;

type BlockEntry = {
  kind: "block";
  type: string;
  inputs?: Record<string, { shadow: { type: "mh_number"; fields: { NUM: number } } }>;
};

/** Every Number value input starts with an `mh_number` shadow, so a new block is never half empty. */
const entry = (type: string): BlockEntry => {
  const spec = BLOCK_SPECS.find((s) => s.type === type);
  const inputs: NonNullable<BlockEntry["inputs"]> = {};
  for (const input of spec ? inputArgs(spec) : []) {
    if (input.kind === "value" && input.check === "Number") {
      inputs[input.name] = { shadow: { type: "mh_number", fields: { NUM: input.initial ?? 0 } } };
    }
  }
  return Object.keys(inputs).length > 0 ? { kind: "block", type, inputs } : { kind: "block", type };
};

/**
 * The toolbox as Blockly JSON (`Blockly.inject(..., { toolbox })`). `advanced` (the default) is one
 * category per spec category, names from `messages`; it throws on a missing category name.
 * Variables are offered as the three variable blocks; creating and renaming variables is the
 * editor's job (apps/web). `icons` is a flat flyout of the icon blocks: no categories, no text.
 * Pure. Both levels' blocks are always registered; the level only decides what is offered.
 */
export const toolbox = (
  messages: Messages,
  level: Level = "advanced",
): utils.toolbox.ToolboxInfo => {
  const offered = (s: { level: Level }): boolean => s.level === level;
  if (level === "icons") {
    return {
      kind: "flyoutToolbox",
      contents: BLOCK_SPECS.filter(offered).map((s) => entry(s.type)),
    };
  }
  return {
    kind: "categoryToolbox",
    contents: CATEGORY_ORDER.map((id) => {
      const name = messages[categoryKey(id)];
      if (name === undefined) throw new Error(`missing message "${categoryKey(id)}"`);
      return {
        kind: "category",
        name,
        colour: String(CATEGORY_COLOURS[id]),
        contents: BLOCK_SPECS.filter((s) => offered(s) && s.category === id).map((s) =>
          entry(s.type),
        ),
      };
    }),
  };
};
