// Own minimal types for the JSON of `Blockly.serialization.workspaces.save`, so this package never
// loads Blockly. They describe what the decompiler writes; the compiler reads `unknown` through the
// defensive helpers below, because its input comes from files.

export type BlockState = {
  type: string;
  id?: string;
  x?: number;
  y?: number;
  fields?: Record<string, unknown>;
  inputs?: Record<string, { block?: BlockState; shadow?: BlockState }>;
  next?: { block: BlockState };
};

export type WorkspaceState = {
  blocks: { languageVersion: 0; blocks: BlockState[] };
  variables: { id: string; name: string }[];
};

/** A block as the compiler sees it after the defensive parse. */
export type BlockNode = {
  type: string;
  id: string | undefined;
  fields: unknown;
  inputs: unknown;
  next: unknown;
  /** False for a block disabled in the editor (`enabled: false`, or the older `disabled: true`). */
  enabled: boolean;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** An own property of a plain object, or undefined: never reads through the prototype chain. */
export const own = (holder: unknown, key: string): unknown =>
  isRecord(holder) && Object.hasOwn(holder, key) ? holder[key] : undefined;

/** Parses one serialized block; undefined when it is not an object at all. */
export const readBlock = (raw: unknown): BlockNode | undefined => {
  if (!isRecord(raw)) return undefined;
  const type = own(raw, "type");
  const id = own(raw, "id");
  return {
    type: typeof type === "string" ? type : "",
    id: typeof id === "string" && id !== "" ? id : undefined,
    fields: own(raw, "fields"),
    inputs: own(raw, "inputs"),
    next: own(raw, "next"),
    enabled: own(raw, "enabled") !== false && own(raw, "disabled") !== true,
  };
};
