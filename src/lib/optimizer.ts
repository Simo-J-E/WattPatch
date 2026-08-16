import { calculateFixtureCurrent, planningLimitA } from "./calculations";
import type {
  Circuit,
  FixtureDefinition,
  OptimizerInput,
  OptimizerResult,
  Phase,
} from "../types";

interface Unit {
  projectFixtureId: string;
  index: number;
  currentA: number;
  inrushA: number;
  lockedCircuitId: string | null;
  groupKey: string;
}

interface Bin {
  circuit: Circuit;
  loadA: number;
  inrushA: number;
  units: Unit[];
}

function phaseTotals(bins: Bin[]): Record<Exclude<Phase, "">, number> {
  return bins.reduce(
    (totals, bin) => {
      if (bin.circuit.phase) totals[bin.circuit.phase] += bin.loadA;
      return totals;
    },
    { L1: 0, L2: 0, L3: 0 },
  );
}

function candidateScore(
  bin: Bin,
  unit: Unit,
  bins: Bin[],
  reservePercentage: number,
): number {
  const nextLoad = bin.loadA + unit.currentA;
  const breakerOverflow = Math.max(0, nextLoad - bin.circuit.breakerA);
  const planningOverflow = Math.max(
    0,
    nextLoad - planningLimitA(bin.circuit.breakerA, reservePercentage),
  );
  const loadRatio = nextLoad / Math.max(0.1, bin.circuit.breakerA);
  const sameGroup = bin.units.filter((item) => item.groupKey === unit.groupKey).length;
  const inrushScore = bin.inrushA + unit.inrushA;
  let phaseScore = 0;

  if (bin.circuit.phase) {
    const totals = phaseTotals(bins);
    totals[bin.circuit.phase] += unit.currentA;
    const average = (totals.L1 + totals.L2 + totals.L3) / 3;
    phaseScore =
      Math.abs(totals.L1 - average) +
      Math.abs(totals.L2 - average) +
      Math.abs(totals.L3 - average);
  }

  return (
    breakerOverflow * 1_000_000 +
    planningOverflow * 10_000 +
    loadRatio * 100 +
    phaseScore * 4 +
    inrushScore * 0.35 -
    Math.min(3, sameGroup) * 0.4
  );
}

function expandUnits(
  input: OptimizerInput,
  definitionById: Map<string, FixtureDefinition>,
): Unit[] {
  const units: Unit[] = [];
  for (const fixture of input.fixtures) {
    const definition = definitionById.get(fixture.definitionId);
    if (!definition) continue;
    const result = calculateFixtureCurrent(
      definition,
      input.voltageV,
      fixture.activeLampCount,
    );
    for (let index = 0; index < fixture.quantity; index += 1) {
      units.push({
        projectFixtureId: fixture.id,
        index,
        currentA: result.currentA,
        inrushA: definition.inrushCurrentA ?? 0,
        lockedCircuitId: fixture.lockedCircuitId,
        groupKey: fixture.groupName || fixture.definitionId,
      });
    }
  }
  return units;
}

export function optimizeAssignments(input: OptimizerInput): OptimizerResult {
  const enabledCircuits = input.circuits.filter(
    (circuit) => circuit.enabled && circuit.breakerA > 0,
  );
  const bins: Bin[] = enabledCircuits.map((circuit) => ({
    circuit,
    loadA: 0,
    inrushA: 0,
    units: [],
  }));
  const definitionById = new Map(
    input.definitions.map((definition) => [definition.id, definition]),
  );
  const units = expandUnits(input, definitionById);
  const assignments: OptimizerResult["assignments"] = Object.fromEntries(
    input.fixtures.map((fixture) => [fixture.id, Array(fixture.quantity).fill(null)]),
  );
  let unassignedCount = 0;

  const assign = (unit: Unit, bin: Bin) => {
    bin.units.push(unit);
    bin.loadA += unit.currentA;
    bin.inrushA += unit.inrushA;
    assignments[unit.projectFixtureId][unit.index] = bin.circuit.id;
  };

  for (const unit of units.filter((item) => item.lockedCircuitId)) {
    const bin = bins.find(
      (candidate) => candidate.circuit.id === unit.lockedCircuitId,
    );
    if (bin) assign(unit, bin);
    else unassignedCount += 1;
  }

  const unlocked = units
    .filter((item) => !item.lockedCircuitId)
    .sort(
      (a, b) =>
        b.currentA - a.currentA || b.inrushA - a.inrushA || a.index - b.index,
    );

  for (const unit of unlocked) {
    const ordered = [...bins].sort(
      (a, b) =>
        candidateScore(a, unit, bins, input.reservePercentage) -
        candidateScore(b, unit, bins, input.reservePercentage),
    );
    const safe = ordered.find(
      (bin) => bin.loadA + unit.currentA <= bin.circuit.breakerA + 0.0001,
    );
    if (safe) assign(unit, safe);
    else unassignedCount += 1;
  }

  for (let pass = 0; pass < 24; pass += 1) {
    const orderedBins = [...bins].sort(
      (a, b) =>
        b.loadA / b.circuit.breakerA - a.loadA / a.circuit.breakerA,
    );
    const heavy = orderedBins[0];
    const light = orderedBins.at(-1);
    if (!heavy || !light || heavy === light) break;
    const before = Math.max(
      heavy.loadA / heavy.circuit.breakerA,
      light.loadA / light.circuit.breakerA,
    );
    const movable = [...heavy.units]
      .filter((unit) => !unit.lockedCircuitId)
      .sort((a, b) => a.currentA - b.currentA)
      .find((unit) => {
        if (light.loadA + unit.currentA > light.circuit.breakerA + 0.0001) {
          return false;
        }
        const after = Math.max(
          (heavy.loadA - unit.currentA) / heavy.circuit.breakerA,
          (light.loadA + unit.currentA) / light.circuit.breakerA,
        );
        return after + 0.001 < before;
      });
    if (!movable) break;

    heavy.units = heavy.units.filter((unit) => unit !== movable);
    heavy.loadA -= movable.currentA;
    heavy.inrushA -= movable.inrushA;
    light.units.push(movable);
    light.loadA += movable.currentA;
    light.inrushA += movable.inrushA;
    assignments[movable.projectFixtureId][movable.index] = light.circuit.id;
  }

  return { assignments, unassignedCount };
}
