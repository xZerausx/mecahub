import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { programSchema } from "./schema.js";
import type { Expression, Program, Statement } from "./types.js";

export type ValidationError = { path: string; code: string; message: string };
export type ValidationResult =
  { ok: true; program: Program } | { ok: false; errors: ValidationError[] };

const MAX_ERRORS = 100;
/**
 * Upper bound of objects and arrays in one program, checked before the schema runs. Ajv reports
 * every error (allErrors), which is superlinear on huge invalid input; the budget (and the schema's
 * maxItems) bound that work, so one validator with allErrors is enough.
 */
const MAX_NODES = 20_000;

/** Counts objects and arrays iteratively (no recursion, terminates on cycles). */
const withinBudget = (root: unknown): boolean => {
  let count = 0;
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || typeof node !== "object") continue;
    if (++count > MAX_NODES) return false;
    if (Array.isArray(node)) {
      if (node.length > MAX_NODES) return false;
      for (const child of node) stack.push(child);
    } else {
      for (const child of Object.values(node)) stack.push(child);
    }
  }
  return true;
};

let compiled: ValidateFunction | undefined;
/** Compiled on first use, once. */
const schemaValidator = (): ValidateFunction => {
  compiled ??= new Ajv2020({ allErrors: true, strict: true, discriminator: true }).compile(
    programSchema,
  );
  return compiled;
};

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const append = (path: string, key: string | number): string =>
  typeof key === "number"
    ? `${path}[${key}]`
    : IDENTIFIER.test(key)
      ? path === ""
        ? key
        : `${path}.${key}`
      : `${path}[${JSON.stringify(key)}]`;

/** "/scripts/0/body/1" -> "scripts[0].body[1]" */
const toPath = (pointer: string): string => {
  let path = "";
  for (const raw of pointer.split("/").slice(1)) {
    const part = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    path = append(path, /^(0|[1-9]\d*)$/.test(part) ? Number(part) : part);
  }
  return path;
};

const valueAt = (root: unknown, pointer: string): unknown => {
  let node = root;
  for (const raw of pointer.split("/").slice(1)) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[raw.replaceAll("~1", "/").replaceAll("~0", "~")];
  }
  return node;
};

const fromAjv = (e: ErrorObject, root: unknown): ValidationError | undefined => {
  const here = toPath(e.instancePath);
  const message = e.message ?? "is invalid";
  const params = e.params as Record<string, unknown>;
  const make = (path: string, code: string, text = message): ValidationError => ({
    path,
    code,
    message: path === "" ? text : `${path}: ${text}`,
  });
  switch (e.keyword) {
    case "if":
      return undefined; // wrapper of a failed `then`, which reports the real problem
    case "required":
      return make(append(here, String(params.missingProperty)), "required", "is required");
    case "additionalProperties":
      return make(
        append(here, String(params.additionalProperty)),
        "unknown-property",
        "is not allowed here",
      );
    case "discriminator": {
      // Ajv reports an unknown tag value as error: "mapping" and a missing/non-string tag as "tag".
      const tagPath = append(here, "type");
      if (params.error === "mapping") {
        return make(
          tagPath,
          "unknown-type",
          `unknown type ${JSON.stringify(valueAt(root, `${e.instancePath}/type`))}`,
        );
      }
      const holder = valueAt(root, e.instancePath);
      const missing = holder !== null && typeof holder === "object" && !("type" in holder);
      return missing
        ? make(tagPath, "required", "is required")
        : make(tagPath, "type", "must be a string");
    }
    case "oneOf":
    case "anyOf":
      return make(here, "no-match", message);
    case "const":
      return here === "irVersion"
        ? make(
            here,
            "unsupported-version",
            "unsupported irVersion (this validator reads version 1)",
          )
        : make(here, "const");
    case "enum":
      return make(
        here,
        "enum",
        `must be one of ${(params.allowedValues as unknown[]).map((v) => JSON.stringify(v)).join(", ")}`,
      );
    case "type":
      return make(here, "type", message);
    case "minimum":
    case "maximum":
    case "exclusiveMinimum":
    case "exclusiveMaximum":
      return make(here, "out-of-range", message);
    case "maxItems":
      return make(here, "too-many", message);
    case "minLength":
      return make(here, "too-short", "must not be empty");
    case "false schema":
      return make(here, "forbidden", "is not allowed here");
    default:
      return make(here, e.keyword);
  }
};

const schemaErrors = (errors: ErrorObject[], root: unknown): ValidationError[] => {
  const out: ValidationError[] = [];
  const seen = new Set<string>();
  for (const e of errors) {
    const mapped = fromAjv(e, root);
    if (!mapped) continue;
    const key = `${mapped.path}\u0000${mapped.code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(mapped);
    if (out.length >= MAX_ERRORS) break;
  }
  return out;
};

// ------------------------------------------------------------------ semantic layer

const semanticErrors = (program: Program): ValidationError[] => {
  const errors: ValidationError[] = [];
  const add = (path: string, code: string, message: string) => {
    if (errors.length < MAX_ERRORS) errors.push({ path, code, message: `${path}: ${message}` });
  };

  const variableIds = new Set<string>();
  const variableNames = new Set<string>();
  program.variables.forEach((v, i) => {
    const p = `variables[${i}]`;
    if (variableIds.has(v.id))
      add(`${p}.id`, "duplicate-variable-id", `variable id "${v.id}" is declared twice`);
    variableIds.add(v.id);
    if (variableNames.has(v.name))
      add(`${p}.name`, "duplicate-variable-name", `variable name "${v.name}" is declared twice`);
    variableNames.add(v.name);
  });

  const blockIds = new Set<string>();
  const claim = (id: string, path: string) => {
    if (blockIds.has(id)) add(`${path}.id`, "duplicate-id", `id "${id}" is used more than once`);
    blockIds.add(id);
  };
  const checkVariable = (id: string, path: string) => {
    if (!variableIds.has(id)) add(path, "undeclared-variable", `variable "${id}" is not declared`);
  };

  const isZero = (e: Expression) => e.type === "number" && e.value === 0;
  const zero = (path: string) =>
    add(path, "zero-speed", "a literal speed of 0 never reaches the requested degrees");

  const expression = (node: Expression, path: string): void => {
    switch (node.type) {
      case "variable":
        checkVariable(node.variable, append(path, "variable"));
        return;
      case "random":
        if (
          node.min.type === "number" &&
          node.max.type === "number" &&
          node.min.value > node.max.value
        ) {
          add(append(path, "max"), "random-range", "max must not be less than min");
        }
        expression(node.min, append(path, "min"));
        expression(node.max, append(path, "max"));
        return;
      case "arithmetic":
      case "compare":
      case "logic":
        expression(node.left, append(path, "left"));
        expression(node.right, append(path, "right"));
        return;
      case "not":
        expression(node.operand, append(path, "operand"));
        return;
      default:
        return;
    }
  };

  const statements = (list: Statement[], path: string): void => {
    list.forEach((s, i) => {
      const p = `${path}[${i}]`;
      claim(s.id, p);
      switch (s.type) {
        case "setVariable":
          checkVariable(s.variable, append(p, "variable"));
          expression(s.value, append(p, "value"));
          return;
        case "changeVariable":
          checkVariable(s.variable, append(p, "variable"));
          expression(s.by, append(p, "by"));
          return;
        case "repeat":
          expression(s.times, append(p, "times"));
          statements(s.body, append(p, "body"));
          return;
        case "forever":
          statements(s.body, append(p, "body"));
          return;
        case "while":
          expression(s.condition, append(p, "condition"));
          statements(s.body, append(p, "body"));
          return;
        case "if":
          expression(s.condition, append(p, "condition"));
          statements(s.then, append(p, "then"));
          if (s.else) statements(s.else, append(p, "else"));
          return;
        case "waitUntil":
          expression(s.condition, append(p, "condition"));
          return;
        case "wait":
          expression(s.ms, append(p, "ms"));
          return;
        case "driveStart":
        case "driveForTime":
        case "driveForDegrees":
          expression(s.speedA, append(p, "speedA"));
          expression(s.speedB, append(p, "speedB"));
          if (s.type === "driveForTime") expression(s.ms, append(p, "ms"));
          if (s.type === "driveForDegrees") {
            if (isZero(s.speedA) && isZero(s.speedB)) zero(append(p, "speedA"));
            expression(s.degrees, append(p, "degrees"));
          }
          return;
        case "motorStart":
        case "motorRunForTime":
        case "motorRunForDegrees":
          expression(s.speed, append(p, "speed"));
          if (s.type === "motorRunForTime") expression(s.ms, append(p, "ms"));
          if (s.type === "motorRunForDegrees") {
            if (isZero(s.speed)) zero(append(p, "speed"));
            expression(s.degrees, append(p, "degrees"));
          }
          return;
        default:
          return;
      }
    });
  };

  program.scripts.forEach((script, i) => {
    const p = `scripts[${i}]`;
    claim(script.id, p);
    statements(script.body, append(p, "body"));
  });
  return errors;
};

// ----------------------------------------------------------------------- public API

/**
 * Validates an unknown value as an IR program. Layer 1 is the JSON Schema; layer 2 (semantic: unique
 * ids, declared variables, literal random ranges) only runs when layer 1 passed. Never throws.
 * Error `code`s are stable keys for the UI to map to i18n later; `message` is developer-facing English.
 */
export const validateProgram = (value: unknown): ValidationResult => {
  let validate: ValidateFunction;
  try {
    validate = schemaValidator();
  } catch {
    return fail("internal", "the schema validator could not be built");
  }
  try {
    if (!withinBudget(value)) {
      return fail("too-large", `the program has more than ${MAX_NODES} objects and arrays`);
    }
    if (!validate(value)) {
      return { ok: false, errors: schemaErrors(validate.errors ?? [], value) };
    }
    const errors = semanticErrors(value as Program);
    // A copy: the caller keeps its own object, and the runtime gets one nobody else can mutate.
    return errors.length === 0
      ? { ok: true, program: structuredClone(value) as Program }
      : { ok: false, errors };
  } catch (error) {
    // Stack overflow on absurdly deep input, or a hostile getter/proxy.
    return error instanceof RangeError
      ? fail("too-deep", "the program is nested too deeply")
      : fail("unreadable", "the value could not be read");
  }
};

const fail = (code: string, message: string): ValidationResult => ({
  ok: false,
  errors: [{ path: "", code, message }],
});
