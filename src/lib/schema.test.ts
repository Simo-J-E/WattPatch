import { describe, expect, it } from "vitest";
import { validateFixtureLibrary } from "./schema";
import { fixtureDefinition } from "../test/helpers";

describe("fixture library validation", () => {
  it("accepts a complete fixture record", () => {
    const result = validateFixtureLibrary([fixtureDefinition("valid", 2)]);
    expect(result.valid).toBe(true);
    expect(result.fixtures).toHaveLength(1);
  });

  it("rejects duplicate ids", () => {
    const fixture = fixtureDefinition("duplicate", 2);
    const result = validateFixtureLibrary([fixture, fixture]);
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("duplicate id");
  });

  it("rejects missing electrical data", () => {
    const fixture = { ...fixtureDefinition("bad", 2), maxPowerW: 0 };
    const result = validateFixtureLibrary([fixture]);
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("maxPowerW");
  });
});
