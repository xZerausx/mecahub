import { validateProgram, type Program } from "@mecahub/ir";
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

/** Most errors returned; `failures` keeps counting past it. */
const MAX_ERRORS = 100;
/** Same budget as `validateProgram`: objects and arrays in the input, counted before walking it. */
const MAX_NODES = 20_000;

/**
 * Longest literal time a time input accepts, in seconds (an hour). Beyond it a number is almost
 * surely a typo, and a huge one would overflow the milliseconds. Negative times are not checked
 * here: the IR validation reports them (`out-of-range`) on the statement.
 */
export const MAX_SECONDS = 3600;

export type Context = {
  errors: CompileError[];
  /** Every error reported, also the ones past MAX_ERRORS: a node is built only when this did not move. */
  failures: number;
  variables: Set<string>;
  /** `too-large` is reported once, not once per level. */
  tooLarge: boolean;
};

export const createContext = (variables: Iterable<string>): Context => ({
  errors: [],
  failures: 0,
  variables: new Set(variables),
  tooLarge: false,
});

const fail = (ctx: Context, code: string, message: string, blockId?: string): void => {
  ctx.failures++;
  if (ctx.errors.length < MAX_ERRORS) {
    ctx.errors.push({ ...(blockId === undefined ? {} : { blockId }), code, message });
  }
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
    case "count":
      // Whole steps within the block's range, scaled to the IR literal: 2 steps of 360 = 720.
      return typeof raw === "number" && Number.isInteger(raw) && raw >= arg.min && raw <= arg.max
        ? { value: { type: "number", value: raw * arg.unit } }
        : bad(`expected a whole number from ${arg.min} to ${arg.max}`);
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
 * Builds the IR node of a block from its fields, value inputs and statement inputs (the part every
 * block shares). Returns undefined when anything below it failed.
 */
const buildNode = (
  spec: BlockSpec,
  node: BlockNode,
  ctx: Context,
  depth: number,
): IrNode | undefined => {
  const before = ctx.failures;
  const out: IrNode = { type: spec.ir.kind, ...structuredClone(spec.ir.fixed) };
  for (const arg of spec.args) {
    if (arg.slot === "icon") continue;
    if (arg.slot === "field") {
      const read = readField(arg, node, ctx);
      if (read) out[arg.key] = read.value;
    } else if (arg.kind === "value") {
      const value = compileInput(own(node.inputs, arg.name), arg, ctx, node.id, depth);
      if (value) out[arg.key] = value;
    } else {
      out[arg.key] = compileChain(own(own(node.inputs, arg.name), "block"), ctx, depth + 1);
    }
  }
  return ctx.failures === before ? out : undefined;
};

const tooDeep = (ctx: Context): void => {
  if (!ctx.tooLarge) fail(ctx, "too-large", `blocks are nested more than ${MAX_DEPTH} levels deep`);
  ctx.tooLarge = true;
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

// ---------------------------------------------------------------------- statements

const noId = (ctx: Context, node: BlockNode): string | undefined => {
  if (node.id === undefined) fail(ctx, "bad-field", `a ${node.type} block has no id`);
  return node.id;
};

/**
 * Compiles a stack of statements by walking its `next` links in a loop (a long stack never
 * recurses). A disabled block is skipped and the stack continues after it.
 */
const compileChain = (first: unknown, ctx: Context, depth: number): IrNode[] => {
  const out: IrNode[] = [];
  if (depth > MAX_DEPTH) {
    tooDeep(ctx);
    return out;
  }
  let current = first;
  while (current !== undefined && current !== null) {
    const node = readBlock(current);
    const spec = node && specFor(node.type);
    if (!node || !spec) {
      fail(ctx, "unknown-block", `unknown block type "${node?.type ?? typeof current}"`, node?.id);
      break;
    }
    const following = own(node.next, "block");
    if (!node.enabled) {
      current = following;
      continue;
    }
    if (spec.shape !== "statement" && spec.shape !== "terminal") {
      fail(
        ctx,
        "type-mismatch",
        `${node.type} cannot be used inside a stack of statements`,
        node.id,
      );
      break;
    }
    const id = noId(ctx, node);
    const built = buildNode(spec, node, ctx, depth);
    if (built && id !== undefined) out.push({ id, ...built });
    if (spec.shape === "terminal" && following !== undefined && following !== null) {
      fail(ctx, "type-mismatch", `no block can follow ${node.type}`, readBlock(following)?.id);
      break;
    }
    current = following;
  }
  return out;
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
  if (value && arg.seconds) {
    if (value.type === "number" && (value.value as number) > MAX_SECONDS) {
      fail(
        ctx,
        "bad-field",
        `${arg.name}: ${String(value.value)} seconds is more than the ${MAX_SECONDS} allowed`,
        ownerId,
      );
      return undefined;
    }
    return secondsToMs(value);
  }
  return value;
};

// ------------------------------------------------------------------------- program

export type CompileResult = { ok: true; program: Program } | { ok: false; errors: CompileError[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Counts objects and arrays iteratively (no recursion, terminates on cycles). */
const withinBudget = (root: unknown): boolean => {
  let count = 0;
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || typeof node !== "object") continue;
    if (++count > MAX_NODES) return false;
    for (const child of Array.isArray(node) ? node : Object.values(node)) stack.push(child);
  }
  return true;
};

const readVariables = (
  state: unknown,
  ctx: Context,
): { id: string; name: string; initial: 0 }[] => {
  const raw = own(state, "variables");
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    fail(ctx, "bad-field", "variables must be a list");
    return [];
  }
  const out: { id: string; name: string; initial: 0 }[] = [];
  for (const entry of raw) {
    const id = own(entry, "id");
    const name = own(entry, "name");
    if (typeof id === "string" && id !== "" && typeof name === "string" && name !== "") {
      out.push({ id, name, initial: 0 });
    } else {
      fail(ctx, "bad-field", "a variable needs a non-empty id and name");
    }
  }
  return out;
};

const compileScript = (hat: BlockNode, spec: BlockSpec, ctx: Context): IrNode | undefined => {
  const id = noId(ctx, hat);
  const trigger = buildNode(spec, hat, ctx, 0);
  const body = compileChain(own(hat.next, "block"), ctx, 1);
  return id !== undefined && trigger ? { id, trigger, body } : undefined;
};

const PATH_TOKEN = /([A-Za-z_$][\w$]*)|\[(\d+)\]|\["((?:[^"\\]|\\.)*)"\]/g;

/**
 * The script or statement an IR validation path (`scripts[0].body[2].then[1].speed`) runs through,
 * as its block id: the deepest list element with an id below `scripts`.
 */
const blockIdAt = (program: unknown, path: string): string | undefined => {
  let node: unknown = program;
  let id: string | undefined;
  let first = true;
  for (const token of path.matchAll(PATH_TOKEN)) {
    const key: string | number =
      token[1] ??
      (token[2] !== undefined ? Number(token[2]) : (JSON.parse(`"${token[3]}"`) as string));
    if (first && key !== "scripts") return undefined;
    first = false;
    node =
      Array.isArray(node) || isRecord(node)
        ? (node as Record<string | number, unknown>)[key]
        : undefined;
    if (typeof key === "number" && isRecord(node) && typeof node.id === "string") id = node.id;
  }
  return id;
};

/**
 * Compiles the JSON of `Blockly.serialization.workspaces.save` to an IR program. Each hat block
 * with its stack is a script; stacks that do not start with a hat and disabled blocks are ignored.
 * Never throws: input comes from files, so it is read defensively, and the result always passes
 * `validateProgram` (its errors come back on the nearest block). An empty input is `missing-input`
 * and never a default.
 */
export const compile = (state: unknown): CompileResult => {
  if (!isRecord(state)) {
    return {
      ok: false,
      errors: [{ code: "bad-field", message: "the workspace state must be an object" }],
    };
  }
  if (!withinBudget(state)) {
    return {
      ok: false,
      errors: [
        {
          code: "too-large",
          message: `the workspace has more than ${MAX_NODES} objects and arrays`,
        },
      ],
    };
  }
  const ctx = createContext([]);
  const variables = readVariables(state, ctx);
  for (const v of variables) ctx.variables.add(v.id);

  const container = own(state, "blocks");
  const inner = own(container, "blocks");
  let list: unknown[] = [];
  if (
    container !== undefined &&
    (!isRecord(container) || (inner !== undefined && !Array.isArray(inner)))
  ) {
    fail(ctx, "bad-field", "blocks.blocks must be a list");
  } else if (Array.isArray(inner)) {
    list = inner;
  }
  const scripts: IrNode[] = [];
  for (const raw of list) {
    const node = readBlock(raw);
    const spec = node && specFor(node.type);
    if (node?.enabled && !spec && node.type.startsWith("mh_")) {
      // Ours by prefix but unknown: a tampered or newer file, never silently dropped.
      fail(ctx, "unknown-block", `unknown block type "${node.type}"`, node.id);
      continue;
    }
    if (!node || !spec || spec.shape !== "hat" || !node.enabled) continue; // floating or disabled
    const script = compileScript(node, spec, ctx);
    if (script) scripts.push(script);
  }
  if (ctx.errors.length > 0) return { ok: false, errors: ctx.errors };

  const candidate = { irVersion: 1, variables, scripts };
  const checked = validateProgram(candidate);
  if (checked.ok) return { ok: true, program: checked.program };
  return {
    ok: false,
    errors: checked.errors.map((e) => {
      const blockId = blockIdAt(candidate, e.path);
      return { ...(blockId === undefined ? {} : { blockId }), code: e.code, message: e.message };
    }),
  };
};
