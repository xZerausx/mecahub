import { own, readBlock, type BlockNode } from "./serialization.js";
import { specFor, type BlockSpec, type FieldArg, type InputArg } from "./spec.js";

/** A plain IR node while it is being built; `validateProgram` is what makes it a typed `Program`. */
export type IrNode = Record<string, unknown>;

export type CompileError = {
  /** The Blockly block the problem is on, when it has an id. */
  blockId?: string;
  /**
   * `missing-input`, `type-mismatch`, `unknown-block`, `bad-field` or `too-large` from the
   * compiler; any other value is the code of an IR validation error (for example `zero-speed`).
   */
  code: string;
  message: string;
};

/** Deepest block nesting the compiler follows (value inputs and statement inputs). */
export const MAX_DEPTH = 100;

export type Context = {
  errors: CompileError[];
  variables: ReadonlySet<string>;
  /** `too-large` is reported once, not once per level. */
  tooLarge: boolean;
};

export const createContext = (variables: Iterable<string>): Context => ({
  errors: [],
  variables: new Set(variables),
  tooLarge: false,
});

const fail = (ctx: Context, code: string, message: string, blockId?: string): void => {
  ctx.errors.push({ ...(blockId === undefined ? {} : { blockId }), code, message });
};

// ------------------------------------------------------------------------- fields

const readField = (
  arg: FieldArg,
  node: BlockNode,
  ctx: Context,
): { value: unknown } | undefined => {
  const raw = own(node.fields, arg.name);
  const bad = (why: string): undefined => {
    fail(ctx, "bad-field", `${node.type}.${arg.name}: ${why}`, node.id);
    return undefined;
  };
  switch (arg.kind) {
    case "enum":
      return typeof raw === "string" && arg.values.includes(raw)
        ? { value: raw }
        : bad(`expected one of ${arg.values.join(", ")}`);
    case "boolean":
      return raw === "true" || raw === "false"
        ? { value: raw === "true" }
        : bad('expected "true" or "false"');
    case "number":
      return typeof raw === "number" && Number.isFinite(raw)
        ? { value: raw }
        : bad("expected a finite number");
    case "variable": {
      const id = own(raw, "id");
      if (typeof id !== "string") return bad("expected a variable reference");
      return ctx.variables.has(id) ? { value: id } : bad(`variable "${id}" is not declared`);
    }
  }
};

// -------------------------------------------------------------------- expressions

const secondsToMs = (seconds: IrNode): IrNode =>
  seconds.type === "number" && typeof seconds.value === "number"
    ? { type: "number", value: Math.round(seconds.value * 1000) }
    : { type: "arithmetic", op: "*", left: seconds, right: { type: "number", value: 1000 } };

/**
 * Builds the IR node of a block from its fields and value inputs (the part every block shares).
 * Statement inputs are the caller's business. Returns undefined when anything below it failed.
 */
const buildNode = (
  spec: BlockSpec,
  node: BlockNode,
  ctx: Context,
  depth: number,
): IrNode | undefined => {
  const before = ctx.errors.length;
  const out: IrNode = { type: spec.ir.kind, ...spec.ir.fixed };
  for (const arg of spec.args) {
    if (arg.slot === "field") {
      const read = readField(arg, node, ctx);
      if (read) out[arg.key] = read.value;
    } else if (arg.kind === "value") {
      const value = compileInput(own(node.inputs, arg.name), arg, ctx, node.id, depth);
      if (value) out[arg.key] = value;
    }
  }
  return ctx.errors.length === before ? out : undefined;
};

const compileExpressionBlock = (
  raw: unknown,
  check: "Number" | "Boolean",
  ctx: Context,
  depth: number,
): IrNode | undefined => {
  if (depth > MAX_DEPTH) {
    if (!ctx.tooLarge)
      fail(ctx, "too-large", `blocks are nested more than ${MAX_DEPTH} levels deep`);
    ctx.tooLarge = true;
    return undefined;
  }
  const node = readBlock(raw);
  const spec = node && specFor(node.type);
  if (!node || !spec) {
    fail(ctx, "unknown-block", `unknown block type "${node?.type ?? typeof raw}"`, node?.id);
    return undefined;
  }
  if (spec.shape !== (check === "Number" ? "number" : "boolean")) {
    fail(ctx, "type-mismatch", `${node.type} cannot be used where a ${check} is expected`, node.id);
    return undefined;
  }
  return buildNode(spec, node, ctx, depth);
};

/** The block to use for an input: the attached one, else its shadow; disabled blocks do not count. */
const chooseBlock = (input: unknown): unknown => {
  for (const key of ["block", "shadow"]) {
    const candidate = own(input, key);
    if (candidate === undefined || candidate === null) continue;
    if (readBlock(candidate)?.enabled === false) continue;
    return candidate;
  }
  return undefined;
};

/**
 * Compiles one value input of `ownerId`'s block. `raw` is the serialized input (`{block?, shadow?}`).
 * An input with neither is `missing-input`: there are no silent defaults. A time input (`seconds`)
 * holds seconds in the editor and milliseconds in the IR.
 */
export const compileInput = (
  raw: unknown,
  arg: InputArg,
  ctx: Context,
  ownerId: string | undefined,
  depth = 0,
): IrNode | undefined => {
  if (arg.kind !== "value") throw new Error(`${arg.name} is not a value input`);
  const chosen = chooseBlock(raw);
  if (chosen === undefined) {
    fail(ctx, "missing-input", `the ${arg.name} input is empty`, ownerId);
    return undefined;
  }
  const value = compileExpressionBlock(chosen, arg.check, ctx, depth + 1);
  return value && arg.seconds ? secondsToMs(value) : value;
};
