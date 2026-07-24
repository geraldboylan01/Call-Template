import { readdirSync, readFileSync } from "node:fs";

import { z, type ZodType } from "zod";

import type { JsonPrimitive } from "./canonical-json.js";
import {
  EVENT_CONSENT_CLASSIFICATIONS,
  type EventConsentClassification,
} from "./consent.js";

const attributeName = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);

const stringPropertySchema = z
  .object({
    type: z.literal("string"),
    enum: z.array(z.string().max(256)).min(1),
    maxLength: z.number().int().positive().max(256),
  })
  .strict();

// Closed identifier formats. These reference tenant-defined structure (module
// UUIDs, module-authored question ids); the anchored lowercase charsets leave
// no room for natural-language free text, so the no-free-text attrs rule holds.
const IDENTIFIER_FORMAT_PATTERNS = {
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  id_slug: /^[a-z0-9][a-z0-9_.-]{0,63}$/,
} as const;

const identifierStringPropertySchema = z
  .object({
    type: z.literal("string"),
    format: z.enum(["uuid", "id_slug"]),
    maxLength: z.number().int().positive().max(64),
  })
  .strict()
  .superRefine((property, context) => {
    if (property.format === "uuid" && property.maxLength !== 36) {
      context.addIssue({
        code: "custom",
        message: "uuid identifier attributes must declare maxLength 36",
      });
    }
  });

const integerPropertySchema = z
  .object({
    type: z.literal("integer"),
    minimum: z.number().int().optional(),
    maximum: z.number().int().optional(),
  })
  .strict();

const numberPropertySchema = z
  .object({
    type: z.literal("number"),
    minimum: z.number().finite().optional(),
    maximum: z.number().finite().optional(),
  })
  .strict();

const booleanPropertySchema = z.object({ type: z.literal("boolean") }).strict();

const primitivePropertySchema = z.union([
  stringPropertySchema,
  identifierStringPropertySchema,
  integerPropertySchema,
  numberPropertySchema,
  booleanPropertySchema,
]);

const attrsJsonSchema = z
  .object({
    $schema: z.literal("http://json-schema.org/draft-07/schema#"),
    type: z.literal("object"),
    additionalProperties: z.literal(false),
    maxProperties: z.number().int().positive().max(32),
    required: z.array(attributeName),
    properties: z.record(attributeName, primitivePropertySchema),
  })
  .strict()
  .superRefine((schema, context) => {
    const propertyNames = new Set(Object.keys(schema.properties));
    for (const requiredName of schema.required) {
      if (!propertyNames.has(requiredName)) {
        context.addIssue({
          code: "custom",
          message: `required attribute ${requiredName} has no property schema`,
        });
      }
    }
    if (schema.maxProperties < propertyNames.size) {
      context.addIssue({
        code: "custom",
        message: "maxProperties is smaller than the declared property set",
      });
    }
    const lateProperty = schema.properties.late;
    if (!lateProperty || lateProperty.type !== "boolean") {
      context.addIssue({
        code: "custom",
        message: "every event schema must reserve boolean attrs.late",
      });
    }
  });

// A conditional-requirement rule: when a categorical property holds one of the
// listed values, the named attributes must be present. Used, for example, so
// session.completed must carry abandonment_cause exactly when it did not
// complete. Only string/enum trigger properties are supported; the `in` values
// are matched literally against the incoming attribute.
const requiredWhenRuleSchema = z
  .object({
    property: attributeName,
    in: z.array(z.string().max(256)).min(1),
    require: z.array(attributeName).min(1),
  })
  .strict();

const eventDefinitionSchema = z
  .object({
    ingestion: z.enum(["service", "internal"]).default("service"),
    // v1/v2 catalogs remain readable for historical outbox projection. New
    // catalogs use the closed M4 classification instead of the overly broad
    // legacy `essential` label.
    consent_scope: z.literal("essential").optional(),
    consent_class: z.enum(EVENT_CONSENT_CLASSIFICATIONS).optional(),
    // Attributes the service derives and stamps at persistence (for example
    // the pinned module_version_id). Clients may never supply them.
    server_owned: z.array(attributeName).default([]),
    required_when: z.array(requiredWhenRuleSchema).default([]),
    attrs_schema: attrsJsonSchema,
    forward_attrs: z.array(attributeName),
    forward_envelope: z.array(z.enum(["turn_index", "duration_ms"])),
  })
  .strict()
  .superRefine((definition, context) => {
    if (
      (definition.consent_scope === undefined) ===
      (definition.consent_class === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "each event must define exactly one of consent_scope or consent_class",
      });
    }
    const properties = new Set(Object.keys(definition.attrs_schema.properties));
    for (const forwardedName of definition.forward_attrs) {
      if (!properties.has(forwardedName)) {
        context.addIssue({
          code: "custom",
          message: `forwarded attribute ${forwardedName} has no property schema`,
        });
      }
    }
    const required = new Set(definition.attrs_schema.required);
    for (const serverOwnedName of definition.server_owned) {
      if (!properties.has(serverOwnedName)) {
        context.addIssue({
          code: "custom",
          message: `server-owned attribute ${serverOwnedName} has no property schema`,
        });
      }
      if (required.has(serverOwnedName)) {
        context.addIssue({
          code: "custom",
          message: `server-owned attribute ${serverOwnedName} cannot be client-required`,
        });
      }
      if (serverOwnedName === "late") {
        context.addIssue({
          code: "custom",
          message: "attrs.late is implicitly server-owned",
        });
      }
    }
    for (const rule of definition.required_when) {
      if (!properties.has(rule.property)) {
        context.addIssue({
          code: "custom",
          message: `required_when trigger ${rule.property} has no property schema`,
        });
      }
      for (const conditional of rule.require) {
        if (!properties.has(conditional)) {
          context.addIssue({
            code: "custom",
            message: `required_when target ${conditional} has no property schema`,
          });
        }
        if (required.has(conditional)) {
          context.addIssue({
            code: "custom",
            message: `required_when target ${conditional} is already unconditionally required`,
          });
        }
      }
    }
  });

const catalogFileSchema = z
  .object({
    $schema: z.string().url(),
    version: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    events: z.record(
      z.string().regex(/^[a-z][a-z0-9_.-]{0,119}$/),
      eventDefinitionSchema,
    ),
  })
  .strict();

type PrimitiveProperty = z.infer<typeof primitivePropertySchema>;
type EventDefinition = z.infer<typeof eventDefinitionSchema>;
type CatalogFile = z.infer<typeof catalogFileSchema>;

export type EventAttributes = Record<string, JsonPrimitive>;

export type ValidatedEventAttributes = {
  clientAttrs: EventAttributes;
  persistedAttrs: EventAttributes;
};

export type EventValidationResult =
  | { ok: true; value: ValidatedEventAttributes }
  | { ok: false; error: string };

function compileProperty(property: PrimitiveProperty): ZodType<JsonPrimitive> {
  if (property.type === "boolean") return z.boolean();

  if (property.type === "string") {
    if ("format" in property) {
      const formatPattern = IDENTIFIER_FORMAT_PATTERNS[property.format];
      return z
        .string()
        .max(property.maxLength)
        .refine(
          (value) => formatPattern.test(value),
          "value is not a well-formed identifier",
        );
    }
    const allowedValues = new Set(property.enum);
    return z
      .string()
      .max(property.maxLength)
      .refine((value) => allowedValues.has(value), "value is not an allowed category");
  }

  let numberSchema = z.number().finite();
  if (property.type === "integer") numberSchema = numberSchema.int();
  if (property.minimum !== undefined) numberSchema = numberSchema.min(property.minimum);
  if (property.maximum !== undefined) numberSchema = numberSchema.max(property.maximum);
  return numberSchema;
}

function compileAttrsSchema(definition: EventDefinition): ZodType<EventAttributes> {
  const required = new Set(definition.attrs_schema.required);
  const shape: Record<string, ZodType<JsonPrimitive> | z.ZodOptional<ZodType<JsonPrimitive>>> = {};

  for (const [name, property] of Object.entries(definition.attrs_schema.properties)) {
    const compiled = compileProperty(property);
    shape[name] = required.has(name) ? compiled : compiled.optional();
  }

  return z.object(shape).strict() as unknown as ZodType<EventAttributes>;
}

function safeAttributeName(name: string): string | undefined {
  return /^[a-z][a-z0-9_]{0,63}$/.test(name) ? name : undefined;
}

function validationError(
  eventType: string,
  issues: z.core.$ZodIssue[],
): string {
  const unknownKeyIssue = issues.find((issue) => issue.code === "unrecognized_keys");
  if (unknownKeyIssue?.code === "unrecognized_keys") {
    const firstKey = unknownKeyIssue.keys[0];
    const safeName = typeof firstKey === "string" ? safeAttributeName(firstKey) : undefined;
    return safeName
      ? `attrs.${safeName} not allowed for ${eventType}`
      : `attrs contains a disallowed key for ${eventType}`;
  }

  const firstIssue = issues[0];
  const firstPathPart = firstIssue?.path[0];
  const safeName =
    typeof firstPathPart === "string" ? safeAttributeName(firstPathPart) : undefined;
  return safeName
    ? `attrs.${safeName} invalid for ${eventType}`
    : `attrs invalid for ${eventType}`;
}

function hasOversizedString(attrs: Record<string, unknown>): boolean {
  return Object.values(attrs).some(
    (value) => typeof value === "string" && [...value].length > 256,
  );
}

function hasNestedValue(attrs: Record<string, unknown>): boolean {
  return Object.values(attrs).some((value) => value !== null && typeof value === "object");
}

export class EventCatalog {
  readonly version: string;

  private readonly definitions: ReadonlyMap<string, EventDefinition>;
  private readonly validators: ReadonlyMap<string, ZodType<EventAttributes>>;

  constructor(file: CatalogFile) {
    const revisionMatch = /-v([1-9][0-9]*)$/.exec(file.version);
    const revision = revisionMatch ? Number(revisionMatch[1]) : undefined;
    if (
      revision !== undefined &&
      revision >= 3 &&
      Object.values(file.events).some(
        (definition) => definition.consent_class === undefined,
      )
    ) {
      throw new Error("M4 telemetry catalogs require consent classifications.");
    }
    this.version = file.version;
    this.definitions = new Map(Object.entries(file.events));
    this.validators = new Map(
      Object.entries(file.events).map(([eventType, definition]) => [
        eventType,
        compileAttrsSchema(definition),
      ]),
    );
  }

  validateIncoming(
    eventType: string,
    attrs: Record<string, unknown>,
    addLateFlag: boolean,
  ): EventValidationResult {
    const definition = this.definitions.get(eventType);
    const validator = this.validators.get(eventType);
    if (!definition || !validator) return { ok: false, error: "event_type not allowed" };

    let serialized: string;
    try {
      serialized = JSON.stringify(attrs);
    } catch {
      return { ok: false, error: `attrs invalid for ${eventType}` };
    }
    if (Buffer.byteLength(serialized, "utf8") > 4096) {
      return { ok: false, error: "attrs exceeds 4096 bytes" };
    }
    const allowedAttributeNames = new Set(
      Object.keys(definition.attrs_schema.properties),
    );
    const unknownAttributeName = Object.keys(attrs).find(
      (name) => !allowedAttributeNames.has(name),
    );
    if (unknownAttributeName) {
      const safeName = safeAttributeName(unknownAttributeName);
      return {
        ok: false,
        error: safeName
          ? `attrs.${safeName} not allowed for ${eventType}`
          : `attrs contains a disallowed key for ${eventType}`,
      };
    }
    if (Object.hasOwn(attrs, "late")) {
      return { ok: false, error: "attrs.late is server-owned" };
    }
    for (const serverOwnedName of definition.server_owned) {
      if (Object.hasOwn(attrs, serverOwnedName)) {
        return { ok: false, error: `attrs.${serverOwnedName} is server-owned` };
      }
    }
    if (hasOversizedString(attrs)) {
      return { ok: false, error: `attrs string exceeds 256 characters for ${eventType}` };
    }
    if (hasNestedValue(attrs)) {
      return { ok: false, error: `nested attrs not allowed for ${eventType}` };
    }

    const parsed = validator.safeParse(attrs);
    if (!parsed.success) {
      return { ok: false, error: validationError(eventType, parsed.error.issues) };
    }

    for (const rule of definition.required_when) {
      const trigger = parsed.data[rule.property];
      if (typeof trigger !== "string" || !rule.in.includes(trigger)) continue;
      const missing = rule.require.find((name) => parsed.data[name] === undefined);
      if (missing) {
        return {
          ok: false,
          error: `attrs.${missing} is required for ${eventType} when ${rule.property} is ${trigger}`,
        };
      }
    }

    const clientAttrs = parsed.data;
    const persistedAttrs = addLateFlag ? { ...clientAttrs, late: true } : clientAttrs;
    const persistedResult = validator.safeParse(persistedAttrs);
    if (!persistedResult.success) {
      throw new Error("Server-derived event attributes violate the event catalog.");
    }

    return {
      ok: true,
      value: {
        clientAttrs,
        persistedAttrs: persistedResult.data,
      },
    };
  }

  /**
   * Merges service-derived attributes into an already validated attribute set
   * and re-validates the result. Only attributes the catalog declares as
   * server_owned may be stamped, so the persistence layer cannot widen an
   * event's shape beyond its published schema.
   */
  withServerAttributes(
    eventType: string,
    attrs: EventAttributes,
    patch: Readonly<Record<string, JsonPrimitive>>,
  ): EventAttributes {
    const definition = this.definitions.get(eventType);
    const validator = this.validators.get(eventType);
    if (!definition || !validator) {
      throw new Error("event_type not allowed");
    }
    for (const name of Object.keys(patch)) {
      if (!definition.server_owned.includes(name)) {
        throw new Error(
          "Only catalog-declared server-owned attributes may be stamped.",
        );
      }
    }
    const parsed = validator.safeParse({ ...attrs, ...patch });
    if (!parsed.success) {
      throw new Error("Server-derived event attributes violate the event catalog.");
    }
    return parsed.data;
  }

  serverOwnedAttributes(eventType: string): readonly string[] {
    return this.definitions.get(eventType)?.server_owned ?? [];
  }

  isEssential(eventType: string): boolean {
    return this.definitions.get(eventType)?.consent_scope === "essential";
  }

  consentClassification(
    eventType: string,
  ): EventConsentClassification | undefined {
    const definition = this.definitions.get(eventType);
    if (!definition) return undefined;
    // v1/v2 used a single broad "essential" label. Treat it as the most
    // conservative always-persist class for historical outbox rows; current
    // v3 definitions carry their precise contract/improvement classification.
    return definition.consent_class ??
      (definition.consent_scope === "essential"
        ? "contract_necessity"
        : undefined);
  }

  eventTypesForConsentClassification(
    classification: EventConsentClassification,
  ): readonly string[] {
    return [...this.definitions.keys()]
      .filter(
        (eventType) =>
          this.consentClassification(eventType) === classification,
      )
      .toSorted();
  }

  isServiceIngestible(eventType: string): boolean {
    return this.definitions.get(eventType)?.ingestion === "service";
  }

  projectProperties(
    eventType: string,
    attrs: unknown,
    envelope: { durationMs: number | null; turnIndex: number | null },
  ): EventAttributes {
    const definition = this.definitions.get(eventType);
    const validator = this.validators.get(eventType);
    if (!definition || !validator) throw new Error("Outbox catalog version is unavailable.");

    const parsed = validator.safeParse(attrs);
    if (!parsed.success) throw new Error("Persisted event attributes violate the event catalog.");

    const properties: EventAttributes = {};
    for (const name of definition.forward_attrs) {
      const value = parsed.data[name];
      if (value !== undefined) properties[name] = value;
    }
    for (const name of definition.forward_envelope) {
      const value = name === "turn_index" ? envelope.turnIndex : envelope.durationMs;
      if (value !== null) properties[name] = value;
    }
    return properties;
  }
}

const defaultCatalogUrl = new URL("../../config/telemetry-events.v3.json", import.meta.url);
const defaultCatalogDirectoryUrl = new URL("../../config/", import.meta.url);

export function loadEventCatalog(url: URL = defaultCatalogUrl): EventCatalog {
  const raw: unknown = JSON.parse(readFileSync(url, "utf8"));
  const parsed = catalogFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error("Invalid telemetry event catalog.");
  }
  return new EventCatalog(parsed.data);
}

export class EventCatalogRegistry {
  readonly current: EventCatalog;

  private readonly catalogs = new Map<string, EventCatalog>();

  constructor(catalogs: readonly EventCatalog[]) {
    const current = catalogs.at(-1);
    if (!current) throw new Error("At least one telemetry event catalog is required.");
    for (const catalog of catalogs) {
      if (this.catalogs.has(catalog.version)) {
        throw new Error("Duplicate telemetry event catalog version.");
      }
      this.catalogs.set(catalog.version, catalog);
    }
    this.current = current;
  }

  get(version: string): EventCatalog | undefined {
    return this.catalogs.get(version);
  }
}

export function loadEventCatalogRegistry(
  directoryUrl: URL = defaultCatalogDirectoryUrl,
): EventCatalogRegistry {
  const catalogFiles = readdirSync(directoryUrl)
    .map((name) => {
      const match = /^telemetry-events\.v([1-9][0-9]*)\.json$/.exec(name);
      return match ? { name, revision: Number(match[1]) } : undefined;
    })
    .filter(
      (entry): entry is { name: string; revision: number } => entry !== undefined,
    )
    .sort((left, right) => left.revision - right.revision);
  if (catalogFiles.length === 0) {
    throw new Error("No telemetry event catalogs are installed.");
  }

  const catalogs = catalogFiles.map(({ name, revision }) => {
    const catalog = loadEventCatalog(new URL(name, directoryUrl));
    if (catalog.version !== `telemetry-events-v${revision}`) {
      throw new Error("Telemetry event catalog filename/version mismatch.");
    }
    return catalog;
  });
  return new EventCatalogRegistry(catalogs);
}
