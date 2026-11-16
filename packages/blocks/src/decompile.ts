import type { Program } from "@mecahub/ir";
import { MAX_DEPTH, MAX_SECONDS } from "./compile.js";
import { jsonEqual } from "./json.js";
import type { BlockState, WorkspaceState } from "./serialization.js";
import { BLOCK_SPECS, type BlockSpec, type FieldArg, type InputArg, type Level } from "./spec.js";

// The inverse of compile.ts, driven by the same spec table. Statement and script ids become block
// ids; expressions get no id (Blockly assigns one on load). Number literals are written as shadows,
// the way the toolbox attaches them, so they stay directly editable.

type Node = Record<string, unknown>;

export type DecompileError = { code: "unknown-node" | "too-deep"; message: string };
/** Something the blocks cannot hold, so the state differs from the program. */
export type DecompileWarning =
  | { code: "variable-initial-dropped"; variableId: string }
  | { code: "time-over-limit"; statementId: string };
export type DecompileResult =
  | { ok: true; state: WorkspaceState; warnings: DecompileWarning[] }
  | { ok: false; errors: DecompileError[] };

class Failure extends Error {
  constructor(readonly error: DecompileError) {
    super(error.message);
  }
}

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
    case "count": {
      const steps = isLiteral(value) ? (value as Node).value : undefined;
      return (
        typeof steps === "number" &&
        Number.isInteger(steps / arg.unit) &&
        steps / arg.unit >= arg.min &&
        steps / arg.unit <= arg.max
      );
    }
  }
};

/**
 * The block for an IR node: same group and kind, same fixed properties, same set of other
 * properties (so `if` with and without `else` are two blocks), every dropdown value allowed.
 */
const rowFor = (group: BlockSpec["ir"]["group"], node: Node, level: Level): BlockSpec => {
  const kind = String(node.type);
  const candidates = (rowsByKind.get(`${group}:${kind}`) ?? [])
    .filter((row) => level === "icons" || row.level === "advanced")
    // At the icons level an icon block wins over the advanced block that could hold the same node.
    .sort((a, b) => Number(b.level === "icons") - Number(a.level === "icons"));
  const found = candidates.find((row) => {
    const fixed = Object.entries(row.ir.fixed ?? {});
    if (!fixed.every(([k, v]) => jsonEqual(node[k], v))) return false;
    const present = Object.keys(node)
      .filter((k) => k !== "type" && k !== "id" && !fixed.some(([f]) => f === k))
      .filter((k) => node[k] !== undefined)
      .sort();
    const wanted = row.args.flatMap((a) => (a.slot === "icon" ? [] : [a.key])).sort();
    if (present.join() !== wanted.join()) return false;
    return row.args.every((a) => a.slot !== "field" || fieldAccepts(a, node[a.key]));
  });
  if (!found) {
    throw new Failure({
      code: "unknown-node",
      message: `no block for ${group} ${JSON.stringify(kind)}`,
    });
  }
  return found;
};

const fieldValue = (arg: FieldArg, value: unknown): unknown =>
  arg.kind === "boolean"
    ? String(value)
    : arg.kind === "variable"
      ? { id: value }
      : arg.kind === "count"
        ? ((value as Node).value as number) / arg.unit
        : value;

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
  depth: number,
  level: Level,
): { block?: BlockState; shadow?: BlockState } => {
  const shown = arg.kind === "value" && arg.seconds ? toSeconds(expression) : expression;
  return shown.type === "number"
    ? { shadow: { type: "mh_number", fields: { NUM: shown.value } } }
    : { block: toBlock("expression", shown, depth + 1, level) };
};

/** Links statements with `next`, iteratively, and returns the first block. */
const chain = (statements: Node[], depth: number, level: Level): BlockState | undefined => {
  checkDepth(depth);
  const blocks = statements.map((s) => toBlock("statement", s, depth, level, String(s.id)));
  for (let i = blocks.length - 2; i >= 0; i--)
    (blocks[i] as BlockState).next = { block: blocks[i + 1] as BlockState };
  return blocks[0];
};

const checkDepth = (depth: number): void => {
  if (depth > MAX_DEPTH) {
    throw new Failure({
      code: "too-deep",
      message: `blocks would be nested more than ${MAX_DEPTH} levels deep`,
    });
  }
};

const toBlock = (
  group: BlockSpec["ir"]["group"],
  node: Node,
  depth: number,
  level: Level,
  id?: string,
): BlockState => {
  checkDepth(depth);
  const spec = rowFor(group, node, level);
  const block: BlockState = { type: spec.type };
  if (id !== undefined) block.id = id;
  const fields: Record<string, unknown> = {};
  const inputs: NonNullable<BlockState["inputs"]> = {};
  for (const arg of spec.args) {
    if (arg.slot === "icon") continue;
    const value = node[arg.key];
    if (arg.slot === "field") fields[arg.name] = fieldValue(arg, value);
    else if (arg.kind === "value") inputs[arg.name] = valueInput(arg, value as Node, depth, level);
    else {
      const first = chain(value as Node[], depth + 1, level);
      if (first) inputs[arg.name] = { block: first };
    }
  }
  if (Object.keys(fields).length > 0) block.fields = fields;
  if (Object.keys(inputs).length > 0) block.inputs = inputs;
  return block;
};

/** Statements, in program order, whose time literal is over MAX_SECONDS (it would not compile back). */
const overLimitTimes = (program: Program): DecompileWarning[] => {
  const out: DecompileWarning[] = [];
  const stack: Node[] = [];
  for (const script of [...program.scripts].reverse()) {
    stack.push(...[...(script.body as unknown as Node[])].reverse());
  }
  while (stack.length > 0) {
    const node = stack.pop() as Node;
    const ms = node.ms as Node | undefined;
    if (ms?.type === "number" && (ms.value as number) > MAX_SECONDS * 1000) {
      out.push({ code: "time-over-limit", statementId: String(node.id) });
    }
    for (const key of ["else", "then", "body"]) {
      if (Array.isArray(node[key])) stack.push(...[...(node[key] as Node[])].reverse());
    }
  }
  return out;
};

/**
 * Turns an IR program into the JSON `Blockly.serialization.workspaces.load` reads, so a program
 * (an example, an activity, a saved file) can be opened in the editor. `compile(decompile(p))`
 * deep-equals `p`, with documented exceptions:
 *
 * - Variables are declared without `initial` (blocks cannot hold it; it compiles back as 0). Each
 *   one that had a non-zero value is reported in `warnings`.
 * - A millisecond expression that is not a literal or `x * 1000` comes back as
 *   `(x / 1000) * 1000`, which means the same thing. `x * 1000` with a literal `x` does too.
 * - A time literal over `MAX_SECONDS` seconds is shown but does not compile back (`bad-field`);
 *   each is reported as `time-over-limit` with the statement id.
 * - A millisecond literal is shown as `ms / 1000` seconds and compiled back with rounding to whole
 *   milliseconds, so a non-integer ms in the IR comes back rounded.
 *
 * `options.level` (default `advanced`) picks the blocks: at `icons` an icon block is used where
 * one holds the node exactly (a forward step is `driveForDegrees` at +50/+50 for a whole number of
 * turns), otherwise the Advanced block is used, so an Icons program may decompile to Advanced
 * blocks. At `advanced` only Advanced blocks are produced.
 *
 * Never throws: an IR node with no block is `unknown-node` and nesting past compile's `MAX_DEPTH`
 * is `too-deep`. Validate the program first.
 */
export const decompile = (program: Program, options: { level?: Level } = {}): DecompileResult => {
  const level = options.level ?? "advanced";
  try {
    const blocks = program.scripts.map((script, i) => {
      const hat = toBlock("trigger", script.trigger as unknown as Node, 1, level, script.id);
      hat.x = SCRIPT_X;
      hat.y = SCRIPT_Y + i * SCRIPT_SPACING;
      const first = chain(script.body as unknown as Node[], 1, level);
      if (first) hat.next = { block: first };
      return hat;
    });
    return {
      ok: true,
      state: {
        blocks: { languageVersion: 0, blocks },
        variables: program.variables.map((v) => ({ id: v.id, name: v.name })),
      },
      warnings: [
        ...program.variables
          .filter((v) => v.initial !== 0)
          .map((v): DecompileWarning => ({ code: "variable-initial-dropped", variableId: v.id })),
        ...overLimitTimes(program),
      ],
    };
  } catch (error) {
    if (error instanceof Failure) return { ok: false, errors: [error.error] };
    if (error instanceof RangeError) {
      return {
        ok: false,
        errors: [{ code: "too-deep", message: "the program is nested too deeply" }],
      };
    }
    throw error;
  }
};
