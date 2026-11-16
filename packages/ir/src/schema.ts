import schemaJson from "../schema/program.schema.json" with { type: "json" };

/** The JSON Schema (draft 2020-12) of IR v1. Its `$id` is an identifier only: nothing fetches it. */
export const programSchema = schemaJson;
