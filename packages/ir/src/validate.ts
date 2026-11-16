import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { programSchema } from "./schema.js";
import type { Expression, Program, Statement } from "./types.js";

export type ValidationError = { path: string; code: string; message: string };
export type ValidationResult =
  { ok: true; program: Program } | { ok: false; errors: ValidationError[] };

const MAX_ERRORS = 100;

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
  const add = (path: string, code: string, message: string) =>
    errors.push({ path, code, message: `${path}: ${message}` });

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
          if (s.type === "driveForDegrees") expression(s.degrees, append(p, "degrees"));
          return;
        case "motorStart":
        case "motorRunForTime":
        case "motorRunForDegrees":
          expression(s.speed, append(p, "speed"));
          if (s.type === "motorRunForTime") expression(s.ms, append(p, "ms"));
          if (s.type === "motorRunForDegrees") expression(s.degrees, append(p, "degrees"));
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
  try {
    const validate = schemaValidator();
    if (!validate(value)) {
      return { ok: false, errors: schemaErrors(validate.errors ?? [], value) };
    }
    const program = value as Program;
    const errors = semanticErrors(program);
    return errors.length === 0 ? { ok: true, program } : { ok: false, errors };
  } catch (error) {
    // Stack overflow on absurdly deep or cyclic input, or a hostile getter/proxy.
    const tooDeep = error instanceof RangeError;
    return {
      ok: false,
      errors: [
        {
          path: "",
          code: tooDeep ? "too-deep" : "unreadable",
          message: tooDeep
            ? "the program is nested too deeply (or contains a cycle)"
            : "the value could not be read",
        },
      ],
    };
  }
};
