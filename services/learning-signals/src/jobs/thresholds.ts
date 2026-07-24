import { readFileSync } from "node:fs";

import { parseDocument } from "yaml";
import { z } from "zod";

// Runtime-loaded KPI alert thresholds. Strict parsing (no YAML merges/aliases,
// unique keys, closed object shapes) mirrors the field-policy loader so a
// malformed thresholds file fails fast rather than silently disabling alerts.
const thresholdsDocumentSchema = z
  .object({
    version: z.string().regex(/^thresholds-v[1-9][0-9]*$/),
    completion_rate: z
      .object({
        warn_below: z.number().gt(0).lte(1),
      })
      .strict(),
    reliability: z
      .object({
        connection_success_warn_below: z.number().gt(0).lte(1),
        drop_rate_warn_above: z.number().gte(0).lte(1),
      })
      .strict(),
    unit_economics: z
      .object({
        cost_per_session_warn_ratio: z.number().gt(1),
        baseline_days: z.number().int().min(1).max(365),
        baseline_min_days: z.number().int().min(1).max(365),
      })
      .strict()
      .superRefine((economics, context) => {
        if (economics.baseline_min_days > economics.baseline_days) {
          context.addIssue({
            code: "custom",
            message: "baseline_min_days cannot exceed baseline_days",
          });
        }
      }),
    reconciliation: z
      .object({
        divergence_warn_above: z.number().gte(0).lte(1),
      })
      .strict(),
  })
  .strict();

export type Thresholds = z.infer<typeof thresholdsDocumentSchema>;

export function parseThresholds(raw: string): Thresholds {
  if (Buffer.byteLength(raw, "utf8") > 64 * 1024) {
    throw new Error("Invalid thresholds config.");
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
    const parsed = thresholdsDocumentSchema.safeParse(value);
    if (!parsed.success) throw new Error("invalid thresholds shape");
    return parsed.data;
  } catch {
    throw new Error("Invalid thresholds config.");
  }
}

const defaultThresholdsUrl = new URL("../../config/thresholds.yaml", import.meta.url);

export function loadThresholds(url: URL = defaultThresholdsUrl): Thresholds {
  return parseThresholds(readFileSync(url, "utf8"));
}
