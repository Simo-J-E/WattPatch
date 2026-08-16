import type {
  Circuit,
  CurrentResult,
  FixtureDefinition,
  ProjectFixture,
} from "../types";

export const DEFAULT_ESTIMATED_POWER_FACTOR = 1;

export function planningLimitA(
  breakerA: number,
  reservePercentage: number,
): number {
  return breakerA * (1 - reservePercentage / 100);
}

export function wattsToAmperes(
  watts: number,
  voltageV: number,
  powerFactor = 1,
): number {
  if (watts < 0 || voltageV <= 0 || powerFactor <= 0 || powerFactor > 1) {
    throw new Error("Invalid electrical value");
  }
  return watts / (voltageV * powerFactor);
}

export function fixturePowerW(
  definition: FixtureDefinition,
  activeLampCount: number | null,
): { powerW: number; removedPowerW: number } {
  if (
    !definition.removableLamps ||
    definition.lampCount === null ||
    definition.lampWattage === null ||
    activeLampCount === null
  ) {
    return { powerW: definition.maxPowerW, removedPowerW: 0 };
  }

  const active = Math.max(0, Math.min(definition.lampCount, activeLampCount));
  const removedPowerW =
    (definition.lampCount - active) * definition.lampWattage;
  const basePowerW =
    definition.internalBasePowerW ??
    Math.max(
      0,
      definition.maxPowerW - definition.lampCount * definition.lampWattage,
    );

  return {
    powerW: basePowerW + active * definition.lampWattage,
    removedPowerW,
  };
}

export function calculateFixtureCurrent(
  definition: FixtureDefinition,
  voltageV: number,
  activeLampCount: number | null = null,
): CurrentResult {
  const { powerW, removedPowerW } = fixturePowerW(
    definition,
    activeLampCount,
  );
  const fullLampCount =
    definition.lampCount === null || activeLampCount === null
      ? true
      : activeLampCount >= definition.lampCount;

  if (
    definition.ratedCurrentA !== null &&
    definition.ratedCurrentVoltageV !== null &&
    Math.abs(definition.ratedCurrentVoltageV - voltageV) < 0.5 &&
    fullLampCount
  ) {
    return {
      currentA: definition.ratedCurrentA,
      powerW,
      method: "rated-current",
      estimated: false,
      removedPowerW,
    };
  }

  if (definition.maxVA !== null && fullLampCount) {
    return {
      currentA: definition.maxVA / voltageV,
      powerW,
      method: "rated-va",
      estimated: false,
      removedPowerW,
    };
  }

  if (definition.powerFactor !== null) {
    return {
      currentA: wattsToAmperes(powerW, voltageV, definition.powerFactor),
      powerW,
      method: "watts-pf",
      estimated:
        !fullLampCount && !definition.partialLoadVerified
          ? true
          : definition.status === "estimated",
      removedPowerW,
    };
  }

  return {
    currentA: wattsToAmperes(
      powerW,
      voltageV,
      DEFAULT_ESTIMATED_POWER_FACTOR,
    ),
    powerW,
    method: "watts-estimated-pf",
    estimated: true,
    removedPowerW,
  };
}

export interface CircuitLoad {
  circuit: Circuit;
  loadA: number;
  powerW: number;
  fixtureCount: number;
  planningLimitA: number;
  remainingPlanningA: number;
  breakerRemainingA: number;
  percentageUsed: number;
  hasEstimatedCurrent: boolean;
  hasUnknownInrush: boolean;
  status: "within" | "low" | "planning-over" | "breaker-over" | "disabled";
  message: string;
}

export function circuitLoads(
  circuits: Circuit[],
  fixtures: ProjectFixture[],
  definitions: FixtureDefinition[],
  voltageV: number,
  reservePercentage: number,
): CircuitLoad[] {
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));

  return circuits.map((circuit) => {
    let loadA = 0;
    let powerW = 0;
    let fixtureCount = 0;
    let hasEstimatedCurrent = false;
    let hasUnknownInrush = false;

    for (const projectFixture of fixtures) {
      const definition = byId.get(projectFixture.definitionId);
      if (!definition) continue;
      const unit = calculateFixtureCurrent(
        definition,
        voltageV,
        projectFixture.activeLampCount,
      );
      projectFixture.assignments.forEach((assignment) => {
        if (assignment !== circuit.id) return;
        loadA += unit.currentA;
        powerW += unit.powerW;
        fixtureCount += 1;
        hasEstimatedCurrent ||= unit.estimated;
        hasUnknownInrush ||= definition.inrushCurrentA === null;
      });
    }

    const limit = planningLimitA(circuit.breakerA, reservePercentage);
    const remainingPlanningA = limit - loadA;
    const breakerRemainingA = circuit.breakerA - loadA;
    let status: CircuitLoad["status"] = "within";
    let message = "Within the selected planning limit";

    if (!circuit.enabled) {
      status = "disabled";
      message = "Circuit disabled";
    } else if (loadA > circuit.breakerA + 0.0001) {
      status = "breaker-over";
      message = `Breaker rating exceeded by ${(loadA - circuit.breakerA).toFixed(1)} A`;
    } else if (loadA > limit + 0.0001) {
      status = "planning-over";
      message = `Planning limit exceeded by ${(loadA - limit).toFixed(1)} A`;
    } else if (remainingPlanningA <= 1.2 && fixtureCount > 0) {
      status = "low";
      message = `Only ${Math.max(0, remainingPlanningA).toFixed(1)} A of planning headroom remains`;
    }

    return {
      circuit,
      loadA,
      powerW,
      fixtureCount,
      planningLimitA: limit,
      remainingPlanningA,
      breakerRemainingA,
      percentageUsed: circuit.breakerA > 0 ? (loadA / circuit.breakerA) * 100 : 0,
      hasEstimatedCurrent,
      hasUnknownInrush,
      status,
      message,
    };
  });
}

export function projectTotals(loads: CircuitLoad[]) {
  const enabled = loads.filter((load) => load.circuit.enabled);
  const totalA = enabled.reduce((sum, load) => sum + load.loadA, 0);
  const totalW = enabled.reduce((sum, load) => sum + load.powerW, 0);
  const usedCircuits = enabled.filter((load) => load.fixtureCount > 0).length;
  const highestLoad = enabled.reduce((max, load) => Math.max(max, load.loadA), 0);
  const remainingCapacity = enabled.reduce(
    (sum, load) => sum + Math.max(0, load.remainingPlanningA),
    0,
  );
  const breakerOver = enabled.some((load) => load.status === "breaker-over");
  const planningOver = enabled.some((load) => load.status === "planning-over");
  const low = enabled.some((load) => load.status === "low");

  return {
    totalA,
    totalW,
    usedCircuits,
    highestLoad,
    remainingCapacity,
    status: breakerOver
      ? "Breaker rating exceeded"
      : planningOver
        ? "Planning limit exceeded"
        : low
          ? "Low planning headroom"
          : "Within the selected planning limit",
    tone: breakerOver || planningOver ? "danger" : low ? "warning" : "safe",
  } as const;
}
