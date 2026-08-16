import { FIXTURE_TYPES, type FixtureDefinition } from "../types";

const nullableNumberFields = [
  "ratedCurrentA",
  "ratedCurrentVoltageV",
  "maxVA",
  "powerFactor",
  "inrushCurrentA",
  "lampCount",
  "lampWattage",
  "internalBasePowerW",
] as const;

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  fixtures: FixtureDefinition[];
}

export function validateFixtureLibrary(value: unknown): ValidationResult {
  const errors: string[] = [];
  if (!Array.isArray(value)) {
    return { valid: false, errors: ["Fixture library must be an array"], fixtures: [] };
  }

  const ids = new Set<string>();
  value.forEach((item, index) => {
    if (!item || typeof item !== "object") {
      errors.push(`Item ${index + 1} must be an object`);
      return;
    }
    const fixture = item as Record<string, unknown>;
    const prefix = `Item ${index + 1}`;
    for (const field of ["id", "manufacturer", "model", "supportedVoltage", "verificationDate"]) {
      if (typeof fixture[field] !== "string" || !fixture[field]) {
        errors.push(`${prefix}: ${field} is required`);
      }
    }
    if (typeof fixture.id === "string") {
      if (ids.has(fixture.id)) errors.push(`${prefix}: duplicate id ${fixture.id}`);
      ids.add(fixture.id);
    }
    if (typeof fixture.sourceUrl !== "string") {
      errors.push(`${prefix}: sourceUrl must be a string`);
    }
    if (!FIXTURE_TYPES.includes(fixture.category as never)) {
      errors.push(`${prefix}: unsupported category`);
    }
    if (typeof fixture.maxPowerW !== "number" || fixture.maxPowerW <= 0) {
      errors.push(`${prefix}: maxPowerW must be greater than zero`);
    }
    for (const field of nullableNumberFields) {
      if (fixture[field] !== null && typeof fixture[field] !== "number") {
        errors.push(`${prefix}: ${field} must be a number or null`);
      }
    }
    if (
      typeof fixture.powerFactor === "number" &&
      (fixture.powerFactor <= 0 || fixture.powerFactor > 1)
    ) {
      errors.push(`${prefix}: powerFactor must be above 0 and at most 1`);
    }
    for (const field of ["removableLamps", "partialLoadVerified"]) {
      if (typeof fixture[field] !== "boolean") {
        errors.push(`${prefix}: ${field} must be boolean`);
      }
    }
    if (fixture.status !== "verified" && fixture.status !== "estimated") {
      errors.push(`${prefix}: status must be verified or estimated`);
    }
    if (fixture.estimationNote !== null && typeof fixture.estimationNote !== "string") {
      errors.push(`${prefix}: estimationNote must be a string or null`);
    }
    if (typeof fixture.sourceUrl === "string" && fixture.sourceUrl) {
      try {
        new URL(fixture.sourceUrl);
      } catch {
        errors.push(`${prefix}: sourceUrl is invalid`);
      }
    }
  });

  return {
    valid: errors.length === 0,
    errors,
    fixtures: errors.length === 0 ? (value as FixtureDefinition[]) : [],
  };
}
