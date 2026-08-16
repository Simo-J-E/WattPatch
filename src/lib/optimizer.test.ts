import { describe, expect, it } from "vitest";
import { optimizeAssignments } from "./optimizer";
import { circuit, fixtureDefinition, projectFixture } from "../test/helpers";

describe("circuit optimizer", () => {
  it("uses mixed breaker sizes without exceeding a breaker", () => {
    const definition = fixtureDefinition("seven-amp", 7);
    const result = optimizeAssignments({
      voltageV: 230,
      reservePercentage: 20,
      circuits: [circuit("10A", 10), circuit("16A", 16)],
      fixtures: [projectFixture("fixtures", definition.id, 2)],
      definitions: [definition],
    });
    expect(new Set(result.assignments.fixtures)).toEqual(new Set(["10A", "16A"]));
    expect(result.unassignedCount).toBe(0);
  });

  it("respects locked assignments", () => {
    const definition = fixtureDefinition("locked", 4);
    const result = optimizeAssignments({
      voltageV: 230,
      reservePercentage: 20,
      circuits: [circuit("c1", 16), circuit("c2", 16)],
      fixtures: [
        projectFixture("fixtures", definition.id, 2, {
          lockedCircuitId: "c2",
        }),
      ],
      definitions: [definition],
    });
    expect(result.assignments.fixtures).toEqual(["c2", "c2"]);
  });

  it("balances equal loads across circuits", () => {
    const definition = fixtureDefinition("two-amp", 2);
    const result = optimizeAssignments({
      voltageV: 230,
      reservePercentage: 20,
      circuits: [circuit("c1", 16), circuit("c2", 16), circuit("c3", 16)],
      fixtures: [projectFixture("fixtures", definition.id, 6)],
      definitions: [definition],
    });
    const counts = ["c1", "c2", "c3"].map(
      (id) => result.assignments.fixtures.filter((assignment) => assignment === id).length,
    );
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
  });

  it("balances selected L1, L2 and L3 phases", () => {
    const definition = fixtureDefinition("phase-load", 3);
    const result = optimizeAssignments({
      voltageV: 230,
      reservePercentage: 20,
      circuits: [
        circuit("l1", 16, { phase: "L1" }),
        circuit("l2", 16, { phase: "L2" }),
        circuit("l3", 16, { phase: "L3" }),
      ],
      fixtures: [projectFixture("fixtures", definition.id, 6)],
      definitions: [definition],
    });
    const counts = ["l1", "l2", "l3"].map(
      (id) => result.assignments.fixtures.filter((assignment) => assignment === id).length,
    );
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
  });

  it("reports insufficient capacity and never exceeds the breaker", () => {
    const definition = fixtureDefinition("ten-amp", 10);
    const result = optimizeAssignments({
      voltageV: 230,
      reservePercentage: 20,
      circuits: [circuit("c1", 16)],
      fixtures: [projectFixture("fixtures", definition.id, 3)],
      definitions: [definition],
    });
    expect(result.assignments.fixtures.filter(Boolean)).toHaveLength(1);
    expect(result.unassignedCount).toBe(2);
  });

  it("ignores disabled circuits", () => {
    const definition = fixtureDefinition("load", 3);
    const result = optimizeAssignments({
      voltageV: 230,
      reservePercentage: 20,
      circuits: [circuit("off", 32, { enabled: false }), circuit("on", 16)],
      fixtures: [projectFixture("fixtures", definition.id, 1)],
      definitions: [definition],
    });
    expect(result.assignments.fixtures).toEqual(["on"]);
  });
});
