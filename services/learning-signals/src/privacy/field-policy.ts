import { readFileSync } from "node:fs";

import { parseDocument } from "yaml";
import { z } from "zod";

const fieldKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/);

const policyTokenSchema = z.string().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/);

export const valueClassSchema = z.enum([
  "identifier",
  "age",
  "currency",
  "categorical",
  "date",
  "boolean",
  "number",
]);

export const previewFormatSchema = z.enum([
  "none",
  "age_band",
  "currency_band",
  "enum",
]);

const fieldEntrySchema = z
  .object({
    value_class: valueClassSchema,
    preview: previewFormatSchema,
    preview_allowed: z.boolean().default(false),
    store_raw_operational: z.boolean().default(false),
    allowed_values: z.array(policyTokenSchema).min(1).max(128).optional(),
  })
  .strict()
  .superRefine((entry, context) => {
    if (entry.preview === "enum" && !entry.allowed_values) {
      context.addIssue({
        code: "custom",
        message: "enum preview requires allowed_values",
      });
    }
    if (entry.preview !== "enum" && entry.allowed_values) {
      context.addIssue({
        code: "custom",
        message: "allowed_values requires enum preview",
      });
    }
    if (entry.preview_allowed && entry.preview === "none") {
      context.addIssue({
        code: "custom",
        message: "none preview cannot be enabled",
      });
    }
    if (entry.preview === "age_band" && entry.value_class !== "age") {
      context.addIssue({
        code: "custom",
        message: "age_band requires the age value class",
      });
    }
    if (entry.preview === "currency_band" && entry.value_class !== "currency") {
      context.addIssue({
        code: "custom",
        message: "currency_band requires the currency value class",
      });
    }
    if (entry.preview === "enum" && entry.value_class !== "categorical") {
      context.addIssue({
        code: "custom",
        message: "enum preview requires the categorical value class",
      });
    }
    if (
      entry.allowed_values &&
      new Set(entry.allowed_values).size !== entry.allowed_values.length
    ) {
      context.addIssue({
        code: "custom",
        message: "allowed_values must be unique",
      });
    }
  });

const fieldPolicyDocumentSchema = z
  .object({
    version: z.string().regex(/^field-policy-v[1-9][0-9]*$/),
    notes: z
      .object({
        dlp_forward_allowed: z.boolean().default(false),
      })
      .strict(),
    fields: z.record(fieldKeySchema, fieldEntrySchema).refine(
      (fields) => Object.keys(fields).length > 0,
      "at least one field policy is required",
    ),
  })
  .strict();

type ParsedFieldEntry = z.infer<typeof fieldEntrySchema>;

export type FieldPolicyEntry = {
  valueClass: z.infer<typeof valueClassSchema>;
  preview: z.infer<typeof previewFormatSchema>;
  previewAllowed: boolean;
  storeRawOperational: boolean;
  allowedValues: readonly string[];
};

export class FieldPolicy {
  readonly version: string;
  readonly dlpForwardAllowed: boolean;

  private readonly entries: ReadonlyMap<string, FieldPolicyEntry>;

  constructor(parsed: z.infer<typeof fieldPolicyDocumentSchema>) {
    this.version = parsed.version;
    this.dlpForwardAllowed = parsed.notes.dlp_forward_allowed;
    this.entries = new Map(
      Object.entries(parsed.fields).map(([fieldKey, entry]) => [
        fieldKey,
        toPolicyEntry(entry),
      ]),
    );
  }

  get(fieldKey: string): FieldPolicyEntry | undefined {
    return this.entries.get(fieldKey);
  }

  fieldKeys(): readonly string[] {
    return [...this.entries.keys()];
  }
}

function toPolicyEntry(entry: ParsedFieldEntry): FieldPolicyEntry {
  return Object.freeze({
    valueClass: entry.value_class,
    preview: entry.preview,
    previewAllowed: entry.preview_allowed,
    storeRawOperational: entry.store_raw_operational,
    allowedValues: Object.freeze([...(entry.allowed_values ?? [])]),
  });
}

export function parseFieldPolicy(raw: string): FieldPolicy {
  if (Buffer.byteLength(raw, "utf8") > 64 * 1024) {
    throw new Error("Invalid field policy.");
  }

  try {
    const document = parseDocument(raw, {
      merge: false,
      strict: true,
      uniqueKeys: true,
    });
    if (document.errors.length > 0 || document.warnings.length > 0) {
      throw new Error("invalid YAML");
    }
    const value: unknown = document.toJS({ maxAliasCount: 0 });
    const parsed = fieldPolicyDocumentSchema.safeParse(value);
    if (!parsed.success) throw new Error("invalid field policy shape");
    return new FieldPolicy(parsed.data);
  } catch {
    throw new Error("Invalid field policy.");
  }
}

const defaultFieldPolicyUrl = new URL("../../config/field_policy.yaml", import.meta.url);

export function loadFieldPolicy(url: URL = defaultFieldPolicyUrl): FieldPolicy {
  return parseFieldPolicy(readFileSync(url, "utf8"));
}
