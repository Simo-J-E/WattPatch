import type { Circuit, FixtureDefinition, ProjectFixture } from "../types";

export function fixtureDefinition(
  id: string,
  currentA: number,
  overrides: Partial<FixtureDefinition> = {},
): FixtureDefinition {
  return {
    id,
    manufacturer: "Test",
    model: id,
    category: "Custom electrical load",
    maxPowerW: currentA * 230,
    ratedCurrentA: currentA,
    ratedCurrentVoltageV: 230,
    maxVA: null,
    supportedVoltage: "230 V",
    powerFactor: 1,
    inrushCurrentA: null,
    lampCount: null,
    lampWattage: null,
    internalBasePowerW: null,
    removableLamps: false,
    partialLoadVerified: false,
    sourceUrl: "https://example.com/specification",
    verificationDate: "2026-08-16",
    status: "verified",
    estimationNote: null,
    ...overrides,
  };
}

export function projectFixture(
  id: string,
  definitionId: string,
  quantity: number,
  overrides: Partial<ProjectFixture> = {},
): ProjectFixture {
  return {
    id,
    definitionId,
    quantity,
    activeLampCount: null,
    assignments: Array(quantity).fill(null),
    lockedCircuitId: null,
    groupName: definitionId,
    ...overrides,
  };
}

export function circuit(
  id: string,
  breakerA: number,
  overrides: Partial<Circuit> = {},
): Circuit {
  return {
    id,
    name: id,
    breakerA,
    enabled: true,
    phase: "",
    ...overrides,
  };
}
