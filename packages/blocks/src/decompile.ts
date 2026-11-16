import type { Program } from "@mecahub/ir";
import type { BlockState, WorkspaceState } from "./serialization.js";
import { BLOCK_SPECS, type BlockSpec, type FieldArg, type InputArg } from "./spec.js";

// The inverse of compile.ts, driven by the same spec table. Statement and script ids become block
// ids; expressions get no id (Blockly assigns one on load). Number literals are written as shadows,
// the way the toolbox attaches them, so they stay directly editable.

type Node = Record<string, unknown>;

const SCRIPT_X = 20;
const SCRIPT_Y = 20;
const SCRIPT_SPACING = 260;

const ONE_THOUSAND = { type: "number", value: 1000 };

const rowsByKind = new Map<string, BlockSpec[]>();
for (const row of BLOCK_SPECS) {
  const key = `${row.ir.group}:${row.ir.kind}`;
  rowsByKind.set(key, [...(rowsByKind.get(key) ?? []), row]);
}

const fieldAccepts = (arg: FieldArg, value: unknown): boolean => {
  switch (arg.kind) {
    case "enum":
      return typeof value === "string" && arg.values.includes(value);
    case "boolean":
      return typeof value === "boolean";
    case "number":
      return typeof value === "number";
    case "variable":
      return typeof value === "string";
  }
};

/**
 * The block for an IR node: same group and kind, same fixed properties, same set of other
 * properties (so `if` with and without `else` are two blocks), every dropdown value allowed.
 */
const rowFor = (group: BlockSpec["ir"]["group"], node: Node): BlockSpec => {
  const kind = String(node.type);
  const found = (rowsByKind.get(`${group}:${kind}`) ?? []).find((row) => {
    const fixed = Object.entries(row.ir.fixed ?? {});
    if (!fixed.every(([k, v]) => node[k] === v)) return false;
    const present = Object.keys(node)
      .filter((k) => k !== "type" && k !== "id" && !fixed.some(([f]) => f === k))
      .filter((k) => node[k] !== undefined)
      .sort();
    const wanted = row.args.map((a) => a.key).sort();
    if (present.join() !== wanted.join()) return false;
    return row.args.every((a) => a.slot !== "field" || fieldAccepts(a, node[a.key]));
  });
  if (!found) throw new Error(`no block for ${group} ${JSON.stringify(kind)}`);
  return found;
};

const fieldValue = (arg: FieldArg, value: unknown): unknown =>
  arg.kind === "boolean" ? String(value) : arg.kind === "variable" ? { id: value } : value;

/** A time input shows seconds; see compile.ts for the other direction. */
const toSeconds = (ms: Node): Node =>
  ms.type === "number"
    ? { type: "number", value: (ms.value as number) / 1000 }
    : ms.type === "arithmetic" && ms.op === "*" && isLiteral(ms.right, 1000) && !isLiteral(ms.left)
      ? (ms.left as Node)
      : { type: "arithmetic", op: "/", left: ms, right: ONE_THOUSAND };

const isLiteral = (node: unknown, value?: number): boolean => {
  const n = node as Node;
  return n.type === "number" && (value === undefined || n.value === value);
};

const valueInput = (
  arg: InputArg,
  expression: Node,
): { block?: BlockState; shadow?: BlockState } => {
  const shown = arg.kind === "value" && arg.seconds ? toSeconds(expression) : expression;
  return shown.type === "number"
    ? { shadow: { type: "mh_number", fields: { NUM: shown.value } } }
    : { block: toBlock("expression", shown) };
};

/** Links statements with `next`, iteratively, and returns the first block. */
const chain = (statements: Node[]): BlockState | undefined => {
  const blocks = statements.map((s) => toBlock("statement", s, String(s.id)));
  for (let i = blocks.length - 2; i >= 0; i--)
    (blocks[i] as BlockState).next = { block: blocks[i + 1] as BlockState };
  return blocks[0];
};

const toBlock = (group: BlockSpec["ir"]["group"], node: Node, id?: string): BlockState => {
  const spec = rowFor(group, node);
  const block: BlockState = { type: spec.type };
  if (id !== undefined) block.id = id;
  const fields: Record<string, unknown> = {};
  const inputs: NonNullable<BlockState["inputs"]> = {};
  for (const arg of spec.args) {
    const value = node[arg.key];
    if (arg.slot === "field") fields[arg.name] = fieldValue(arg, value);
    else if (arg.kind === "value") inputs[arg.name] = valueInput(arg, value as Node);
    else {
      const first = chain(value as Node[]);
      if (first) inputs[arg.name] = { block: first };
    }
  }
  if (Object.keys(fields).length > 0) block.fields = fields;
  if (Object.keys(inputs).length > 0) block.inputs = inputs;
  return block;
};

/**
 * Turns an IR program into the JSON `Blockly.serialization.workspaces.load` reads, so a program
 * (an example, an activity, a saved file) can be opened in the editor. `compile(decompile(p))`
 * deep-equals `p`, with two documented exceptions. Variables are declared without `initial`
 * (blocks cannot hold it; it compiles back as 0). A millisecond expression that is not a literal
 * or `x * 1000` comes back as `(x / 1000) * 1000`, which means the same thing.
 * Throws on an IR node with no block: validate the program first.
 */
export const decompile = (program: Program): WorkspaceState => ({
  blocks: {
    languageVersion: 0,
    blocks: program.scripts.map((script, i) => {
      const hat = toBlock("trigger", script.trigger as unknown as Node, script.id);
      hat.x = SCRIPT_X;
      hat.y = SCRIPT_Y + i * SCRIPT_SPACING;
      const first = chain(script.body as unknown as Node[]);
      if (first) hat.next = { block: first };
      return hat;
    }),
  },
  variables: program.variables.map((v) => ({ id: v.id, name: v.name })),
});
