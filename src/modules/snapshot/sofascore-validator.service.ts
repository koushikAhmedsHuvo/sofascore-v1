import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { AlertService, SchemaMismatchIssue } from "./alert.service";

const SofascoreEventSchema = z.object({
  id: z.number(),
  slug: z.string(),
  tournament: z.object({
    id: z.number(),
    name: z.string(),
  }),
  homeTeam: z.object({
    id: z.number(),
    name: z.string(),
  }),
  awayTeam: z.object({
    id: z.number(),
    name: z.string(),
  }),
  homeScore: z
    .object({
      current: z.number().nullable().optional(),
    })
    .optional(),
  awayScore: z
    .object({
      current: z.number().nullable().optional(),
    })
    .optional(),
  status: z.object({
    type: z.string(),
    description: z.string(),
  }),
});

const EXPECTED_KEY_PATHS = [
  "id",
  "slug",
  "tournament.id",
  "tournament.name",
  "homeTeam.id",
  "homeTeam.name",
  "awayTeam.id",
  "awayTeam.name",
  "status.type",
  "status.description",
];

export type ValidationSuccess = {
  valid: true;
  data: z.infer<typeof SofascoreEventSchema>;
};

export type ValidationFailure = {
  valid: false;
  issues: SchemaMismatchIssue[];
  receivedKeys: string[];
  missingKeys: string[];
};

export type ValidationResult = ValidationSuccess | ValidationFailure;

@Injectable()
export class SofaScoreValidatorService {
  constructor(private readonly alertService: AlertService) {}

  validateResponse(data: unknown, endpointUrl = "unknown"): ValidationResult {
    // Provider wraps event detail under an "event" key: { event: { id, slug, ... } }.
    // Unwrap it so the schema validates the event object directly.
    const payload =
      data !== null &&
      typeof data === "object" &&
      !Array.isArray(data) &&
      "event" in (data as Record<string, unknown>)
        ? (data as Record<string, unknown>)["event"]
        : data;

    const parsed = SofascoreEventSchema.safeParse(payload);

    if (parsed.success) {
      return { valid: true, data: parsed.data };
    }

    const issues: SchemaMismatchIssue[] = parsed.error.issues.map((issue) => ({
      field: issue.path.join(".") || "(root)",
      message: issue.message,
    }));

    const receivedKeys = this.flattenObjectKeys(payload);
    const missingKeys = EXPECTED_KEY_PATHS.filter(
      (expectedPath) => !receivedKeys.includes(expectedPath),
    );

    this.alertService.sendSchemaMismatchAlert({
      endpointUrl,
      issues,
      receivedKeys,
      missingKeys,
      timestampIso: new Date().toISOString(),
    });

    return { valid: false, issues, receivedKeys, missingKeys };
  }

  private flattenObjectKeys(value: unknown, prefix = ""): string[] {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return [];
    }

    const out: string[] = [];
    for (const [key, nested] of Object.entries(
      value as Record<string, unknown>,
    )) {
      const fullKey = prefix ? `${prefix}.${key}` : key;
      out.push(fullKey);
      out.push(...this.flattenObjectKeys(nested, fullKey));
    }
    return out;
  }
}
