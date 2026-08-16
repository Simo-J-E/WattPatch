import { describe, expect, it } from "vitest";
import {
  calculateFixtureCurrent,
  circuitLoads,
  fixturePowerW,
  planningLimitA,
  wattsToAmperes,
} from "./calculations";
import { circuit, fixtureDefinition, projectFixture } from "../test/helpers";

describe("electrical calculations", () => {
  it("converts watts to amperes", () => {
    expect(wattsToAmperes(2300, 230)).toBeCloseTo(10);
  });

  it("includes power factor", () => {
    expect(wattsToAmperes(2300, 230, 0.8)).toBeCloseTo(12.5);
  });

  it("applies the planning reserve", () => {
    expect(planningLimitA(16, 20)).toBeCloseTo(12.8);
  });

  it("calculates a removable lamp load", () => {
    const definition = fixtureDefinition("sunstrip", 550 / 230, {
      maxPowerW: 550,
      ratedCurrentA: null,
      ratedCurrentVoltageV: null,
      lampCount: 10,
      lampWattage: 50,
      internalBasePowerW: 50,
      removableLamps: true,
    });
    expect(fixturePowerW(definition, 9)).toEqual({
      powerW: 500,
      removedPowerW: 50,
    });
  });

  it("marks missing current and power factor data as estimated", () => {
    const definition = fixtureDefinition("unknown-pf", 2, {
      ratedCurrentA: null,
      ratedCurrentVoltageV: null,
      powerFactor: null,
    });
    const result = calculateFixtureCurrent(definition, 230);
    expect(result.method).toBe("watts-estimated-pf");
    expect(result.estimated).toBe(true);
  });

  it("multiplies fixture quantities assigned to a circuit", () => {
    const definition = fixtureDefinition("two-amp", 2);
    const load = circuitLoads(
      [circuit("c1", 16)],
      [
        projectFixture("pf1", definition.id, 3, {
          assignments: ["c1", "c1", null],
        }),
      ],
      [definition],
      230,
      20,
    )[0];
    expect(load.loadA).toBeCloseTo(4);
    expect(load.fixtureCount).toBe(2);
    expect(load.powerW).toBeCloseTo(920);
  });

  it("reports planning and breaker overloads separately", () => {
    const definition = fixtureDefinition("load", 14);
    const planningOver = circuitLoads(
      [circuit("c1", 16)],
      [projectFixture("pf1", definition.id, 1, { assignments: ["c1"] })],
      [definition],
      230,
      20,
    )[0];
    expect(planningOver.status).toBe("planning-over");
    const breakerOver = circuitLoads(
      [circuit("c1", 10)],
      [projectFixture("pf1", definition.id, 1, { assignments: ["c1"] })],
      [definition],
      230,
      0,
    )[0];
    expect(breakerOver.status).toBe("breaker-over");
  });
});
