"use client";

import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  type ReactNode,
} from "react";
import fixtureData from "./data/fixtures.json";
import {
  catalogFixtureToDefinition,
  catalogIdentityKey,
  loadChamSysCatalog,
  searchChamSysCatalog,
  type ChamSysCatalog,
  type ChamSysCatalogMetadata,
  type ChamSysFixture,
} from "./lib/chamsysCatalog";
import {
  calculateFixtureCurrent,
  circuitLoads,
  planningLimitA,
  projectTotals,
  type CircuitLoad,
} from "./lib/calculations";
import { optimizeAssignments } from "./lib/optimizer";
import { validateFixtureLibrary } from "./lib/schema";
import {
  loadProjects,
  saveProjects,
  uniqueProjectName,
} from "./lib/storage";
import {
  COMMON_MANUFACTURERS,
  FIXTURE_TYPES,
  type Circuit,
  type FixtureDefinition,
  type OptimizerResult,
  type Phase,
  type Project,
  type ProjectFixture,
} from "./types";

type View = "circuits" | "fixtures" | "power-plan";
type Dialog = "projects" | "custom" | "export" | "library" | null;
type FixtureFilter = "all" | "favourites" | "recent";

const VERIFIED_FIXTURES = fixtureData as FixtureDefinition[];
const BREAKER_OPTIONS = [6, 10, 13, 16, 20, 32];

function makeId(prefix: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function now(): string {
  return new Date().toISOString();
}

function defaultProject(): Project {
  const timestamp = "2026-08-16T00:00:00.000Z";
  return {
    id: "default-project",
    name: "Untitled power plan",
    voltageV: 230,
    frequencyHz: 50,
    reservePercentage: 20,
    circuits: [
      { id: "circuit-1", name: "Circuit 1", breakerA: 16, enabled: true, phase: "L1" },
      { id: "circuit-2", name: "Circuit 2", breakerA: 16, enabled: true, phase: "L2" },
      { id: "circuit-3", name: "Circuit 3", breakerA: 16, enabled: true, phase: "L3" },
    ],
    fixtures: [],
    customFixtures: [],
    favourites: [],
    recentFixtureIds: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function newProject(name: string): Project {
  const project = defaultProject();
  const timestamp = now();
  return {
    ...project,
    id: makeId("project"),
    name,
    circuits: project.circuits.map((circuit, index) => ({
      ...circuit,
      id: makeId(`circuit-${index + 1}`),
    })),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function statusMark(status: CircuitLoad["status"]): string {
  if (status === "within") return "✓";
  if (status === "disabled") return "–";
  return "!";
}

function compactNumber(value: number, digits = 1): string {
  return Number.isFinite(value) ? value.toFixed(digits) : "0.0";
}

function download(name: string, content: string, type: string): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

function sanitizeFilename(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "wattpatch";
}

function fitAssignments(fixture: ProjectFixture, quantity: number): Array<string | null> {
  if (quantity <= fixture.assignments.length) return fixture.assignments.slice(0, quantity);
  return [...fixture.assignments, ...Array(quantity - fixture.assignments.length).fill(null)];
}

function definitionFor(
  id: string,
  definitions: FixtureDefinition[],
): FixtureDefinition | undefined {
  return definitions.find((definition) => definition.id === id);
}

function makeTextPlan(
  project: Project,
  loads: CircuitLoad[],
  definitions: FixtureDefinition[],
): string {
  const lines = [
    `${project.name} | ${project.voltageV} V ${project.frequencyHz} Hz | ${project.reservePercentage}% reserve`,
    "",
  ];
  for (const load of loads.filter((item) => item.circuit.enabled)) {
    lines.push(
      `${load.circuit.name}${load.circuit.phase ? ` ${load.circuit.phase}` : ""}: ${load.loadA.toFixed(2)} A / ${load.circuit.breakerA} A, ${Math.round(load.powerW)} W`,
    );
    for (const fixture of project.fixtures) {
      const count = fixture.assignments.filter((id) => id === load.circuit.id).length;
      if (!count) continue;
      const definition = definitionFor(fixture.definitionId, definitions);
      if (definition) lines.push(`  ${count} × ${definition.manufacturer} ${definition.model}`);
    }
    lines.push(`  ${load.message}`, "");
  }
  const unassigned = project.fixtures.reduce(
    (sum, fixture) => sum + fixture.assignments.filter((id) => id === null).length,
    0,
  );
  if (unassigned) lines.push(`Unassigned fixtures: ${unassigned}`, "");
  lines.push(
    "WattPatch is a load-planning tool. Verify breakers, cables, connectors, distribution, RCD protection, inrush current and venue requirements before connecting equipment.",
  );
  return lines.join("\n");
}

interface Solution {
  score: number;
  title: string;
  detail: string;
}

function overloadSolutions(
  project: Project,
  loads: CircuitLoad[],
  definitions: FixtureDefinition[],
): { missingA: number; missingW: number; extraCircuits: number; solutions: Solution[] } {
  const unassigned = project.fixtures.reduce((totals, fixture) => {
    const definition = definitionFor(fixture.definitionId, definitions);
    if (!definition) return totals;
    const electrical = calculateFixtureCurrent(definition, project.voltageV, fixture.activeLampCount);
    const count = fixture.assignments.filter((id) => id === null).length;
    return {
      currentA: totals.currentA + count * electrical.currentA,
      powerW: totals.powerW + count * electrical.powerW,
    };
  }, { currentA: 0, powerW: 0 });
  const overloadedA = loads.reduce(
    (sum, load) => sum + Math.max(0, load.loadA - load.planningLimitA),
    0,
  );
  const overloadedW = loads.reduce((sum, load) => {
    const overA = Math.max(0, load.loadA - load.planningLimitA);
    return sum + (load.loadA > 0 ? (overA / load.loadA) * load.powerW : 0);
  }, 0);
  const missingA = unassigned.currentA + overloadedA;
  const missingW = unassigned.powerW + overloadedW;
  if (missingA <= 0.001) return { missingA: 0, missingW: 0, extraCircuits: 0, solutions: [] };

  const standardCapacity = planningLimitA(16, project.reservePercentage);
  const extraCircuits = Math.max(1, Math.ceil(missingA / standardCapacity));
  const solutions: Solution[] = [
    {
      score: 2,
      title: "Rebalance the existing circuits",
      detail: "Run Optimize again after checking locked assignments.",
    },
    {
      score: 5 + extraCircuits,
      title: `Add ${extraCircuits} × 16 A circuit${extraCircuits === 1 ? "" : "s"}`,
      detail: `Adds ${compactNumber(extraCircuits * standardCapacity)} A of selected planning capacity.`,
    },
  ];

  const movable = loads
    .filter((load) => load.loadA > load.planningLimitA)
    .flatMap((heavy) =>
      project.fixtures.flatMap((fixture) => {
        const definition = definitionFor(fixture.definitionId, definitions);
        if (!definition || !fixture.assignments.includes(heavy.circuit.id)) return [];
        const current = calculateFixtureCurrent(definition, project.voltageV, fixture.activeLampCount).currentA;
        const target = loads.find(
          (load) =>
            load.circuit.enabled &&
            load.circuit.id !== heavy.circuit.id &&
            load.loadA + current <= load.planningLimitA,
        );
        return target
          ? [{ heavy, target, definition, current }]
          : [];
      }),
    )
    .sort((a, b) => a.current - b.current)[0];
  if (movable) {
    solutions.push({
      score: 1,
      title: `Move one ${movable.definition.model}`,
      detail: `${movable.heavy.circuit.name} → ${movable.target.circuit.name}, ${compactNumber(movable.current)} A.`,
    });
  }

  const removable = project.fixtures
    .map((fixture) => ({
      fixture,
      definition: definitionFor(fixture.definitionId, definitions),
    }))
    .find(
      ({ fixture, definition }) =>
        definition?.removableLamps &&
        definition.lampWattage !== null &&
        fixture.activeLampCount !== null &&
        fixture.activeLampCount > 0,
    );
  if (
    removable?.definition &&
    removable.definition.lampWattage !== null
  ) {
    const reducedW = removable.definition.lampWattage * removable.fixture.quantity;
    solutions.push({
      score: 3,
      title: `Reduce active lamps in ${removable.definition.model}`,
      detail: `One permitted lamp per fixture removes an estimated ${reducedW} W. Confirm the manufacturer procedure first.`,
    });
  }

  const smallest = project.fixtures
    .filter((fixture) => fixture.quantity > 0)
    .map((fixture) => {
      const definition = definitionFor(fixture.definitionId, definitions);
      return definition
        ? {
            definition,
            current: calculateFixtureCurrent(definition, project.voltageV, fixture.activeLampCount).currentA,
          }
        : null;
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((a, b) => a.current - b.current)[0];
  if (smallest) {
    solutions.push({
      score: 8,
      title: `Remove one ${smallest.definition.model}`,
      detail: `Reduces the planned load by ${compactNumber(smallest.current)} A.`,
    });
  }

  return {
    missingA,
    missingW,
    extraCircuits,
    solutions: solutions.sort((a, b) => a.score - b.score),
  };
}

function DialogShell({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className={`dialog ${wide ? "dialog-wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="dialog-header">
          <h2 id="dialog-title">{title}</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close dialog">×</button>
        </header>
        <div className="dialog-body">{children}</div>
      </section>
    </div>
  );
}

export function WattPatchApp() {
  const [projects, setProjects] = useState<Project[]>([defaultProject()]);
  const [activeProjectId, setActiveProjectId] = useState("default-project");
  const [activeView, setActiveView] = useState<View>("fixtures");
  const [dialog, setDialog] = useState<Dialog>(null);
  const [fixtureFilter, setFixtureFilter] = useState<FixtureFilter>("all");
  const [search, setSearch] = useState("");
  const [online, setOnline] = useState(true);
  const [optimizing, setOptimizing] = useState(false);
  const [toast, setToast] = useState("");
  const [projectName, setProjectName] = useState("");
  const [catalog, setCatalog] = useState<ChamSysCatalog | null>(null);
  const [catalogError, setCatalogError] = useState("");
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [customPreset, setCustomPreset] = useState<ChamSysFixture | null>(null);
  const hydrated = useRef(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const stored = loadProjects(window.localStorage);
    if (stored.length) {
      setProjects(stored);
      setActiveProjectId(stored[0].id);
    }
    hydrated.current = true;
  }, []);

  useEffect(() => {
    if (hydrated.current) saveProjects(window.localStorage, projects);
  }, [projects]);

  useEffect(() => {
    const updateOnline = () => setOnline(navigator.onLine);
    updateOnline();
    window.addEventListener("online", updateOnline);
    window.addEventListener("offline", updateOnline);
    return () => {
      window.removeEventListener("online", updateOnline);
      window.removeEventListener("offline", updateOnline);
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setCatalogLoading(true);
    loadChamSysCatalog(controller.signal)
      .then((loaded) => {
        setCatalog(loaded);
        setCatalogError("");
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setCatalogError("The full ChamSys catalog could not be loaded.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setCatalogLoading(false);
      });
    return () => controller.abort();
  }, []);

  const project = projects.find((item) => item.id === activeProjectId) ?? projects[0];
  const definitions = useMemo(
    () => [...VERIFIED_FIXTURES, ...project.customFixtures],
    [project.customFixtures],
  );
  const deferredSearch = useDeferredValue(search);
  const definitionsByIdentity = useMemo(
    () =>
      new Map(
        definitions.map((definition) => [
          catalogIdentityKey(definition.manufacturer, definition.model),
          definition,
        ]),
      ),
    [definitions],
  );
  const loads = useMemo(
    () =>
      circuitLoads(
        project.circuits,
        project.fixtures,
        definitions,
        project.voltageV,
        project.reservePercentage,
      ),
    [project, definitions],
  );
  const totals = useMemo(() => projectTotals(loads), [loads]);
  const overload = useMemo(
    () => overloadSolutions(project, loads, definitions),
    [project, loads, definitions],
  );

  const notify = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 3200);
  }, []);

  const updateProject = useCallback(
    (updater: (current: Project) => Project) => {
      setProjects((currentProjects) =>
        currentProjects.map((item) =>
          item.id === activeProjectId
            ? { ...updater(item), updatedAt: now() }
            : item,
        ),
      );
    },
    [activeProjectId],
  );

  const visibleDefinitions = useMemo(() => {
    const terms = deferredSearch.toLowerCase().trim().split(/\s+/).filter(Boolean);
    const ordered = [...definitions].sort((a, b) => {
      const favouriteDelta =
        Number(project.favourites.includes(b.id)) - Number(project.favourites.includes(a.id));
      if (favouriteDelta) return favouriteDelta;
      const aRecent = project.recentFixtureIds.indexOf(a.id);
      const bRecent = project.recentFixtureIds.indexOf(b.id);
      if (aRecent !== bRecent) {
        if (aRecent === -1) return 1;
        if (bRecent === -1) return -1;
        return aRecent - bRecent;
      }
      return `${a.manufacturer} ${a.model}`.localeCompare(`${b.manufacturer} ${b.model}`);
    });

    return ordered.filter((definition) => {
      if (fixtureFilter === "favourites" && !project.favourites.includes(definition.id)) return false;
      if (fixtureFilter === "recent" && !project.recentFixtureIds.includes(definition.id)) return false;
      if (!terms.length) return true;
      const current = calculateFixtureCurrent(definition, project.voltageV);
      const haystack = [
        definition.manufacturer,
        definition.model,
        definition.category,
        `${definition.maxPowerW}`,
        `${compactNumber(current.currentA, 2)}a`,
      ].join(" ").toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
  }, [definitions, deferredSearch, fixtureFilter, project.favourites, project.recentFixtureIds, project.voltageV]);

  const catalogSearch = useMemo(
    () =>
      fixtureFilter === "all" && catalog
        ? searchChamSysCatalog(catalog.fixtures, deferredSearch)
        : { items: [], total: 0 },
    [catalog, deferredSearch, fixtureFilter],
  );

  const addFixture = (definition: FixtureDefinition, quantity = 1) => {
    updateProject((current) => {
      const customFixtures =
        VERIFIED_FIXTURES.some((item) => item.id === definition.id) ||
        current.customFixtures.some((item) => item.id === definition.id)
          ? current.customFixtures
          : [...current.customFixtures, definition];
      const existing = current.fixtures.find(
        (fixture) => fixture.definitionId === definition.id && fixture.lockedCircuitId === null,
      );
      const recent = [definition.id, ...current.recentFixtureIds.filter((id) => id !== definition.id)].slice(0, 8);
      if (existing) {
        return {
          ...current,
          customFixtures,
          recentFixtureIds: recent,
          fixtures: current.fixtures.map((fixture) =>
            fixture.id === existing.id
              ? {
                  ...fixture,
                  quantity: fixture.quantity + quantity,
                  assignments: [...fixture.assignments, ...Array(quantity).fill(null)],
                }
              : fixture,
          ),
        };
      }
      const lampCount = definition.removableLamps ? definition.lampCount : null;
      return {
        ...current,
        customFixtures,
        recentFixtureIds: recent,
        fixtures: [
          ...current.fixtures,
          {
            id: makeId("fixture"),
            definitionId: definition.id,
            quantity,
            activeLampCount: lampCount,
            assignments: Array(quantity).fill(null),
            lockedCircuitId: null,
            groupName: definition.model,
          },
        ],
      };
    });
    notify(`${definition.model} added`);
  };

  const addCatalogFixture = (fixture: ChamSysFixture) => {
    const existing = definitionsByIdentity.get(
      catalogIdentityKey(fixture.manufacturer, fixture.model),
    );
    if (existing) {
      addFixture(existing);
      return;
    }
    if (!fixture.power || !catalog) {
      setCustomPreset(fixture);
      setDialog("custom");
      return;
    }
    addFixture(catalogFixtureToDefinition(fixture, catalog.metadata.generatedDate));
  };

  const setFixtureQuantity = (fixtureId: string, quantity: number) => {
    updateProject((current) => ({
      ...current,
      fixtures:
        quantity <= 0
          ? current.fixtures.filter((fixture) => fixture.id !== fixtureId)
          : current.fixtures.map((fixture) =>
              fixture.id === fixtureId
                ? { ...fixture, quantity, assignments: fitAssignments(fixture, quantity) }
                : fixture,
            ),
    }));
  };

  const patchFixture = (fixtureId: string, patch: Partial<ProjectFixture>) => {
    updateProject((current) => ({
      ...current,
      fixtures: current.fixtures.map((fixture) =>
        fixture.id === fixtureId ? { ...fixture, ...patch } : fixture,
      ),
    }));
  };

  const addCircuit = (breakerA = 16) => {
    updateProject((current) => ({
      ...current,
      circuits: [
        ...current.circuits,
        {
          id: makeId("circuit"),
          name: `Circuit ${current.circuits.length + 1}`,
          breakerA,
          enabled: true,
          phase: "",
        },
      ],
    }));
  };

  const patchCircuit = (circuitId: string, patch: Partial<Circuit>) => {
    updateProject((current) => ({
      ...current,
      circuits: current.circuits.map((circuit) =>
        circuit.id === circuitId ? { ...circuit, ...patch } : circuit,
      ),
    }));
  };

  const duplicateCircuit = (circuitId: string) => {
    updateProject((current) => {
      const source = current.circuits.find((circuit) => circuit.id === circuitId);
      if (!source) return current;
      return {
        ...current,
        circuits: [
          ...current.circuits,
          { ...source, id: makeId("circuit"), name: `${source.name} copy` },
        ],
      };
    });
  };

  const deleteCircuit = (circuitId: string) => {
    updateProject((current) => ({
      ...current,
      circuits: current.circuits.filter((circuit) => circuit.id !== circuitId),
      fixtures: current.fixtures.map((fixture) => ({
        ...fixture,
        lockedCircuitId:
          fixture.lockedCircuitId === circuitId ? null : fixture.lockedCircuitId,
        assignments: fixture.assignments.map((id) => (id === circuitId ? null : id)),
      })),
    }));
  };

  const moveOne = (fixtureId: string, fromCircuitId: string | null, toCircuitId: string | null) => {
    updateProject((current) => ({
      ...current,
      fixtures: current.fixtures.map((fixture) => {
        if (fixture.id !== fixtureId) return fixture;
        const index = fixture.assignments.findIndex((id) => id === fromCircuitId);
        if (index === -1) return fixture;
        const assignments = [...fixture.assignments];
        assignments[index] = toCircuitId;
        return { ...fixture, assignments };
      }),
    }));
  };

  const reorderFixture = (fixtureId: string, direction: -1 | 1) => {
    updateProject((current) => {
      const index = current.fixtures.findIndex((fixture) => fixture.id === fixtureId);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= current.fixtures.length) return current;
      const fixtures = [...current.fixtures];
      [fixtures[index], fixtures[target]] = [fixtures[target], fixtures[index]];
      return { ...current, fixtures };
    });
  };

  const optimize = () => {
    const payload = {
      voltageV: project.voltageV,
      reservePercentage: project.reservePercentage,
      circuits: project.circuits,
      fixtures: project.fixtures,
      definitions,
    };
    setOptimizing(true);
    const applyResult = (result: OptimizerResult) => {
      updateProject((current) => ({
        ...current,
        fixtures: current.fixtures.map((fixture) => ({
          ...fixture,
          assignments: result.assignments[fixture.id] ?? fixture.assignments,
        })),
      }));
      setOptimizing(false);
      notify(
        result.unassignedCount
          ? `${result.unassignedCount} fixture${result.unassignedCount === 1 ? "" : "s"} could not be assigned`
          : "Circuit plan updated",
      );
    };

    try {
      const worker = new Worker(new URL("./workers/optimizer.worker.ts", import.meta.url), {
        type: "module",
      });
      worker.onmessage = (event: MessageEvent<OptimizerResult>) => {
        applyResult(event.data);
        worker.terminate();
      };
      worker.onerror = () => {
        worker.terminate();
        applyResult(optimizeAssignments(payload));
      };
      worker.postMessage(payload);
    } catch {
      applyResult(optimizeAssignments(payload));
    }
  };

  const toggleFavourite = (definitionId: string) => {
    updateProject((current) => ({
      ...current,
      favourites: current.favourites.includes(definitionId)
        ? current.favourites.filter((id) => id !== definitionId)
        : [...current.favourites, definitionId],
    }));
  };

  const createProject = () => {
    const preferred = projectName.trim() || "Untitled power plan";
    const created = newProject(uniqueProjectName(projects, preferred));
    setProjects((current) => [...current, created]);
    setActiveProjectId(created.id);
    setProjectName("");
    setDialog(null);
  };

  const duplicateProject = (projectId: string) => {
    const source = projects.find((item) => item.id === projectId);
    if (!source) return;
    const timestamp = now();
    const copy: Project = {
      ...structuredClone(source),
      id: makeId("project"),
      name: uniqueProjectName(projects, `${source.name} copy`),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    setProjects((current) => [...current, copy]);
    setActiveProjectId(copy.id);
  };

  const deleteProject = (projectId: string) => {
    if (projects.length === 1) {
      notify("At least one project is required");
      return;
    }
    const remaining = projects.filter((item) => item.id !== projectId);
    setProjects(remaining);
    if (activeProjectId === projectId) setActiveProjectId(remaining[0].id);
  };

  const importProject = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text()) as Partial<Project>;
      if (!parsed.name || !Array.isArray(parsed.circuits) || !Array.isArray(parsed.fixtures)) {
        throw new Error("Invalid project file");
      }
      const timestamp = now();
      const imported: Project = {
        ...defaultProject(),
        ...parsed,
        id: makeId("project"),
        name: uniqueProjectName(projects, parsed.name),
        createdAt: timestamp,
        updatedAt: timestamp,
      } as Project;
      setProjects((current) => [...current, imported]);
      setActiveProjectId(imported.id);
      setDialog(null);
      notify("Project imported");
    } catch {
      notify("Project JSON is invalid");
    }
  };

  const importLibrary = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const parsed: unknown = JSON.parse(await file.text());
      const validation = validateFixtureLibrary(parsed);
      if (!validation.valid) {
        notify(validation.errors[0] ?? "Fixture library is invalid");
        return;
      }
      updateProject((current) => {
        const existingIds = new Set([...VERIFIED_FIXTURES, ...current.customFixtures].map((item) => item.id));
        const additions = validation.fixtures.filter((item) => !existingIds.has(item.id));
        return { ...current, customFixtures: [...current.customFixtures, ...additions] };
      });
      notify("Fixture library imported");
    } catch {
      notify("Fixture library JSON is invalid");
    }
  };

  const submitCustomFixture = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const manufacturer = String(form.get("manufacturer") || "Custom").trim();
    const model = String(form.get("model") || "Custom load").trim();
    const maxPowerW = Number(form.get("maxPowerW"));
    const ratedCurrent = Number(form.get("ratedCurrentA"));
    const voltage = Number(form.get("voltageV"));
    const powerFactor = Number(form.get("powerFactor"));
    const inrush = Number(form.get("inrushCurrentA"));
    const quantity = Math.max(1, Math.floor(Number(form.get("quantity")) || 1));
    if (!(maxPowerW > 0) || !(voltage > 0)) {
      notify("Enter valid watts and voltage");
      return;
    }
    const definition: FixtureDefinition = {
      id: customPreset?.id ?? makeId("custom"),
      manufacturer,
      model,
      category: String(form.get("category")) as FixtureDefinition["category"],
      maxPowerW,
      ratedCurrentA: ratedCurrent > 0 ? ratedCurrent : null,
      ratedCurrentVoltageV: ratedCurrent > 0 ? voltage : null,
      maxVA: null,
      supportedVoltage: `${voltage} V`,
      powerFactor: powerFactor > 0 && powerFactor <= 1 ? powerFactor : null,
      inrushCurrentA: inrush > 0 ? inrush : null,
      lampCount: null,
      lampWattage: null,
      internalBasePowerW: null,
      removableLamps: false,
      partialLoadVerified: false,
      sourceUrl: String(form.get("sourceUrl") || "").trim(),
      verificationDate: new Date().toISOString().slice(0, 10),
      status: "estimated",
      estimationNote: customPreset
        ? "User-entered power for a ChamSys catalog fixture. Verify against manufacturer documentation."
        : "User-entered value. Verify against manufacturer documentation.",
    };
    updateProject((current) => ({
      ...current,
      customFixtures: [...current.customFixtures, definition],
      recentFixtureIds: [definition.id, ...current.recentFixtureIds].slice(0, 8),
      fixtures: [
        ...current.fixtures,
        {
          id: makeId("fixture"),
          definitionId: definition.id,
          quantity,
          activeLampCount: null,
          assignments: Array(quantity).fill(null),
          lockedCircuitId: null,
          groupName: model,
        },
      ],
    }));
    setDialog(null);
    setCustomPreset(null);
    notify(`${model} added`);
  };

  const exportCsv = () => {
    const rows = [
      ["Circuit", "Phase", "Breaker A", "Planning limit A", "Load A", "Power W", "Fixture", "Quantity", "Status"],
    ];
    for (const load of loads) {
      let found = false;
      for (const fixture of project.fixtures) {
        const quantity = fixture.assignments.filter((id) => id === load.circuit.id).length;
        if (!quantity) continue;
        const definition = definitionFor(fixture.definitionId, definitions);
        if (!definition) continue;
        found = true;
        rows.push([
          load.circuit.name,
          load.circuit.phase,
          `${load.circuit.breakerA}`,
          load.planningLimitA.toFixed(2),
          load.loadA.toFixed(2),
          `${Math.round(load.powerW)}`,
          `${definition.manufacturer} ${definition.model}`,
          `${quantity}`,
          load.message,
        ]);
      }
      if (!found) {
        rows.push([
          load.circuit.name,
          load.circuit.phase,
          `${load.circuit.breakerA}`,
          load.planningLimitA.toFixed(2),
          load.loadA.toFixed(2),
          `${Math.round(load.powerW)}`,
          "",
          "0",
          load.message,
        ]);
      }
    }
    const csv = rows.map((row) => row.map((cell) => `"${cell.replaceAll('"', '""')}"`).join(",")).join("\n");
    download(`${sanitizeFilename(project.name)}.csv`, csv, "text/csv;charset=utf-8");
  };

  const copyTextPlan = async () => {
    const text = makeTextPlan(project, loads, definitions);
    try {
      await navigator.clipboard.writeText(text);
      notify("Text plan copied");
    } catch {
      download(`${sanitizeFilename(project.name)}.txt`, text, "text/plain;charset=utf-8");
      notify("Text plan downloaded");
    }
  };

  const onCircuitDrop = (event: DragEvent<HTMLElement>, targetCircuitId: string) => {
    event.preventDefault();
    try {
      const payload = JSON.parse(event.dataTransfer.getData("application/json")) as {
        fixtureId: string;
        fromCircuitId: string;
      };
      moveOne(payload.fixtureId, payload.fromCircuitId, targetCircuitId);
    } catch {
      return;
    }
  };

  return (
    <div className="wattpatch-shell">
      <header className="app-header">
        <div className="brand" aria-label="WattPatch">
          <span className="brand-mark">WP</span>
          <span>WattPatch</span>
        </div>
        <button type="button" className="project-button" onClick={() => setDialog("projects")}> 
          <span className="project-name">{project.name}</span>
          <span aria-hidden="true">▾</span>
        </button>
        <div className="header-meta technical">
          {project.voltageV} V · {project.frequencyHz} Hz
        </div>
        <div className={`offline-state ${online ? "online" : "offline"}`}>
          <span aria-hidden="true">{online ? "✓" : "!"}</span>
          {online ? "Online" : "Offline"}
        </div>
        <button type="button" className="button secondary header-export" onClick={() => setDialog("export")}>Export</button>
      </header>

      <nav className="desktop-tabs" aria-label="Main views">
        <ViewButton view="circuits" active={activeView} onSelect={setActiveView}>Circuits</ViewButton>
        <ViewButton view="fixtures" active={activeView} onSelect={setActiveView}>Fixtures</ViewButton>
        <ViewButton view="power-plan" active={activeView} onSelect={setActiveView}>Power plan</ViewButton>
        <div className={`desktop-status ${totals.tone}`}>
          <span>{totals.tone === "safe" ? "✓" : "!"}</span>
          {totals.status}
        </div>
      </nav>

      <main className="app-content">
        {activeView === "circuits" && (
          <CircuitsView
            project={project}
            loads={loads}
            onProjectChange={(patch) => updateProject((current) => ({ ...current, ...patch }))}
            onAddCircuit={addCircuit}
            onPatchCircuit={patchCircuit}
            onDuplicateCircuit={duplicateCircuit}
            onDeleteCircuit={deleteCircuit}
          />
        )}
        {activeView === "fixtures" && (
          <div className="desktop-split">
            <FixtureLibrary
              project={project}
              definitions={visibleDefinitions}
              allCount={definitions.length}
              catalogMetadata={catalog?.metadata ?? null}
              catalogDefinitions={catalogSearch.items}
              catalogTotal={catalogSearch.total}
              catalogLoading={catalogLoading}
              catalogError={catalogError}
              search={search}
              filter={fixtureFilter}
              onSearch={setSearch}
              onFilter={setFixtureFilter}
              onAdd={addFixture}
              onCatalogAdd={addCatalogFixture}
              onFavourite={toggleFavourite}
              onCustom={() => { setCustomPreset(null); setDialog("custom"); }}
              onLibrary={() => setDialog("library")}
            />
            <SelectedFixtures
              project={project}
              definitions={definitions}
              onQuantity={setFixtureQuantity}
              onPatch={patchFixture}
              onOptimize={optimize}
              optimizing={optimizing}
            />
          </div>
        )}
        {activeView === "power-plan" && (
          <PowerPlan
            project={project}
            definitions={definitions}
            loads={loads}
            overload={overload}
            optimizing={optimizing}
            onOptimize={optimize}
            onAddCircuit={() => addCircuit(16)}
            onMove={moveOne}
            onReorder={reorderFixture}
            onDrop={onCircuitDrop}
          />
        )}
      </main>

      <MobileSummary totals={totals} circuitCount={project.circuits.filter((item) => item.enabled).length} />

      <nav className="mobile-nav" aria-label="Main views">
        <ViewButton view="circuits" active={activeView} onSelect={setActiveView}>Circuits</ViewButton>
        <ViewButton view="fixtures" active={activeView} onSelect={setActiveView}>Fixtures</ViewButton>
        <ViewButton view="power-plan" active={activeView} onSelect={setActiveView}>Power plan</ViewButton>
      </nav>

      {dialog === "projects" && (
        <DialogShell title="Projects" onClose={() => setDialog(null)} wide>
          <div className="project-create">
            <label>
              <span>Project name</span>
              <input value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder="Venue or production" />
            </label>
            <button type="button" className="button primary" onClick={createProject}>Create project</button>
            <label className="button secondary file-button">
              Import JSON
              <input type="file" accept="application/json,.json" onChange={importProject} />
            </label>
          </div>
          <div className="project-list">
            {projects.map((item) => (
              <div key={item.id} className={`project-row ${item.id === activeProjectId ? "selected" : ""}`}>
                <button type="button" className="project-select" onClick={() => { setActiveProjectId(item.id); setDialog(null); }}>
                  <strong>{item.name}</strong>
                  <span>{item.fixtures.reduce((sum, fixture) => sum + fixture.quantity, 0)} fixtures · {item.circuits.length} circuits</span>
                </button>
                <button type="button" className="button secondary" onClick={() => duplicateProject(item.id)}>Duplicate</button>
                <button type="button" className="button danger" onClick={() => deleteProject(item.id)}>Delete</button>
              </div>
            ))}
          </div>
        </DialogShell>
      )}

      {dialog === "custom" && (
        <DialogShell title={customPreset ? "Enter fixture power" : "Add custom fixture"} onClose={() => setDialog(null)} wide>
          <form className="custom-form" onSubmit={submitCustomFixture} key={customPreset?.id ?? "custom"}>
            {customPreset && (
              <p className="catalog-preset-note field-wide">
                <strong>ChamSys catalog match</strong>
                <span>{customPreset.profiles.length} DMX profile{customPreset.profiles.length === 1 ? "" : "s"}. ChamSys does not publish electrical power in its personality table, so enter a documented maximum input value.</span>
              </p>
            )}
            <label><span>Manufacturer</span><input name="manufacturer" list="manufacturers" defaultValue={customPreset?.manufacturer ?? "Custom"} required /></label>
            <datalist id="manufacturers">{COMMON_MANUFACTURERS.map((item) => <option key={item} value={item} />)}</datalist>
            <label><span>Model</span><input name="model" placeholder="Model or load name" defaultValue={customPreset?.model ?? ""} required autoFocus={!customPreset} /></label>
            <label><span>Fixture type</span><select name="category" defaultValue={customPreset?.category ?? "Custom electrical load"}>{FIXTURE_TYPES.map((type) => <option key={type}>{type}</option>)}</select></label>
            <label><span>Maximum input watts</span><input name="maxPowerW" type="number" min="0.1" step="0.1" inputMode="decimal" required autoFocus={Boolean(customPreset)} /></label>
            <label><span>Rated amperes</span><input name="ratedCurrentA" type="number" min="0" step="0.01" inputMode="decimal" placeholder="Optional" /></label>
            <label><span>Voltage</span><input name="voltageV" type="number" min="1" step="1" inputMode="numeric" defaultValue={project.voltageV} required /></label>
            <label><span>Power factor</span><input name="powerFactor" type="number" min="0.01" max="1" step="0.01" inputMode="decimal" placeholder="Optional" /></label>
            <label><span>Quantity</span><input name="quantity" type="number" min="1" step="1" inputMode="numeric" defaultValue="1" required /></label>
            <label><span>Inrush current</span><input name="inrushCurrentA" type="number" min="0" step="0.1" inputMode="decimal" placeholder="Optional" /></label>
            <label className="field-wide"><span>Power source link</span><input name="sourceUrl" type="url" placeholder="Optional manufacturer page or manual" /></label>
            <p className="form-note field-wide">User-entered power is marked estimated until verified. Do not use lamp output wattage unless it is also the documented total input consumption.</p>
            <div className="dialog-actions field-wide">
              <button type="button" className="button secondary" onClick={() => setDialog(null)}>Cancel</button>
              <button type="submit" className="button primary">Add fixture</button>
            </div>
          </form>
        </DialogShell>
      )}

      {dialog === "export" && (
        <DialogShell title="Export power plan" onClose={() => setDialog(null)}>
          <div className="export-list">
            <button type="button" className="export-row" onClick={() => download(`${sanitizeFilename(project.name)}.json`, JSON.stringify(project, null, 2), "application/json")}>Export project JSON <span>Full editable project</span></button>
            <button type="button" className="export-row" onClick={exportCsv}>Export CSV <span>Circuit and fixture list</span></button>
            <button type="button" className="export-row" onClick={copyTextPlan}>Copy text plan <span>Production notes or WhatsApp</span></button>
            <button type="button" className="export-row" onClick={() => { setActiveView("power-plan"); setDialog(null); window.setTimeout(() => window.print(), 50); }}>Print <span>Clean circuit plan</span></button>
          </div>
        </DialogShell>
      )}

      {dialog === "library" && (
        <DialogShell title="Fixture library" onClose={() => setDialog(null)}>
          <p className="dialog-copy">
            WattPatch includes every fixture in the ChamSys table: {catalog?.metadata.fixtureCount.toLocaleString() ?? "21,968"} models and {catalog?.metadata.personalityCount.toLocaleString() ?? "68,757"} profiles. {catalog?.metadata.powerMatchedFixtureCount.toLocaleString() ?? "1,293"} exact models have sourced maximum-input power; all others require a documented value before power planning.
          </p>
          <div className="export-list">
            <button type="button" className="export-row" onClick={() => download("wattpatch-powered-fixtures.json", JSON.stringify(definitions, null, 2), "application/json")}>Export powered library JSON <span>{definitions.length} verified, sourced or custom power records</span></button>
            <label className="export-row file-export">Import library JSON <span>Validated before import</span><input type="file" accept="application/json,.json" onChange={importLibrary} /></label>
          </div>
        </DialogShell>
      )}

      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

function ViewButton({
  view,
  active,
  onSelect,
  children,
}: {
  view: View;
  active: View;
  onSelect: (view: View) => void;
  children: ReactNode;
}) {
  return (
    <button type="button" className={active === view ? "active" : ""} aria-current={active === view ? "page" : undefined} onClick={() => onSelect(view)}>
      {children}
    </button>
  );
}

function CircuitsView({
  project,
  loads,
  onProjectChange,
  onAddCircuit,
  onPatchCircuit,
  onDuplicateCircuit,
  onDeleteCircuit,
}: {
  project: Project;
  loads: CircuitLoad[];
  onProjectChange: (patch: Partial<Project>) => void;
  onAddCircuit: (breakerA?: number) => void;
  onPatchCircuit: (id: string, patch: Partial<Circuit>) => void;
  onDuplicateCircuit: (id: string) => void;
  onDeleteCircuit: (id: string) => void;
}) {
  return (
    <section className="circuits-view">
      <div className="section-heading">
        <div><h1>Circuits</h1><p>Supply settings and available breakers.</p></div>
        <button type="button" className="button primary" onClick={() => onAddCircuit(16)}>Add circuit</button>
      </div>
      <div className="supply-settings">
        <label><span>Voltage</span><div className="input-unit"><input type="number" min="1" value={project.voltageV} onChange={(event) => onProjectChange({ voltageV: Math.max(1, Number(event.target.value)) })} /><b>V</b></div></label>
        <label><span>Frequency</span><div className="input-unit"><input type="number" min="1" value={project.frequencyHz} onChange={(event) => onProjectChange({ frequencyHz: Math.max(1, Number(event.target.value)) })} /><b>Hz</b></div></label>
        <label><span>Planning reserve</span><div className="input-unit"><input type="number" min="0" max="90" value={project.reservePercentage} onChange={(event) => onProjectChange({ reservePercentage: Math.min(90, Math.max(0, Number(event.target.value))) })} /><b>%</b></div></label>
        <p className="reserve-note"><span>i</span> The reserve is a planning preference, not a legal limit.</p>
      </div>
      <div className="circuit-config-list">
        {loads.map((load) => (
          <article key={load.circuit.id} className={`circuit-config-row status-${load.status}`}>
            <div className="circuit-row-main">
              <label className="circuit-name-field"><span className="sr-only">Circuit name</span><input value={load.circuit.name} onChange={(event) => onPatchCircuit(load.circuit.id, { name: event.target.value })} /></label>
              <label><span>Breaker</span><div className="input-unit compact"><input type="number" min="0.1" step="0.1" list="breaker-sizes" value={load.circuit.breakerA} onChange={(event) => onPatchCircuit(load.circuit.id, { breakerA: Math.max(0.1, Number(event.target.value)) })} /><b>A</b></div></label>
              <datalist id="breaker-sizes">{BREAKER_OPTIONS.map((value) => <option key={value} value={value} />)}</datalist>
              <label><span>Phase</span><select value={load.circuit.phase} onChange={(event) => onPatchCircuit(load.circuit.id, { phase: event.target.value as Phase })}><option value="">None</option><option>L1</option><option>L2</option><option>L3</option></select></label>
              <label className="toggle-field"><input type="checkbox" checked={load.circuit.enabled} onChange={(event) => onPatchCircuit(load.circuit.id, { enabled: event.target.checked })} /><span>{load.circuit.enabled ? "Enabled" : "Disabled"}</span></label>
            </div>
            <div className="circuit-metrics">
              <Metric label="Planning limit" value={`${compactNumber(load.planningLimitA)} A`} />
              <Metric label="Current load" value={`${compactNumber(load.loadA)} A`} />
              <Metric label="Power" value={`${Math.round(load.powerW)} W`} />
              <Metric label="Used" value={`${Math.round(load.percentageUsed)}%`} />
              <Metric label="Remaining" value={`${compactNumber(load.remainingPlanningA)} A`} />
              <Metric label="Fixtures" value={`${load.fixtureCount}`} />
            </div>
            <CapacityBar load={load} />
            <div className="circuit-row-footer">
              <div className={`status-message ${load.status}`}><span>{statusMark(load.status)}</span>{load.message}</div>
              <div className="row-actions">
                <button type="button" className="button secondary" onClick={() => onDuplicateCircuit(load.circuit.id)}>Duplicate</button>
                <button type="button" className="button danger" onClick={() => onDeleteCircuit(load.circuit.id)}>Delete</button>
              </div>
            </div>
            {(load.hasEstimatedCurrent || load.hasUnknownInrush) && load.fixtureCount > 0 && (
              <div className="warning-line">
                {load.hasEstimatedCurrent && <span>! Fixture current is estimated</span>}
                {load.hasUnknownInrush && <span>! Inrush current is unknown</span>}
              </div>
            )}
          </article>
        ))}
      </div>
      <SafetyNotice />
    </section>
  );
}

function FixtureLibrary({
  project,
  definitions,
  allCount,
  catalogMetadata,
  catalogDefinitions,
  catalogTotal,
  catalogLoading,
  catalogError,
  search,
  filter,
  onSearch,
  onFilter,
  onAdd,
  onCatalogAdd,
  onFavourite,
  onCustom,
  onLibrary,
}: {
  project: Project;
  definitions: FixtureDefinition[];
  allCount: number;
  catalogMetadata: ChamSysCatalogMetadata | null;
  catalogDefinitions: ChamSysFixture[];
  catalogTotal: number;
  catalogLoading: boolean;
  catalogError: string;
  search: string;
  filter: FixtureFilter;
  onSearch: (value: string) => void;
  onFilter: (value: FixtureFilter) => void;
  onAdd: (definition: FixtureDefinition) => void;
  onCatalogAdd: (fixture: ChamSysFixture) => void;
  onFavourite: (id: string) => void;
  onCustom: () => void;
  onLibrary: () => void;
}) {
  const hasSearch = search.trim().length > 0;
  const noResults =
    hasSearch && definitions.length === 0 && catalogDefinitions.length === 0 && !catalogLoading;
  return (
    <section className="fixture-library">
      <div className="section-heading compact-heading">
        <div>
          <h1>Fixtures</h1>
          <p>
            {catalogMetadata
              ? `${catalogMetadata.fixtureCount.toLocaleString()} ChamSys models · ${catalogMetadata.personalityCount.toLocaleString()} profiles · ${allCount} powered/project records.`
              : catalogLoading
                ? `Loading full ChamSys catalog · ${allCount} powered/project records.`
                : `${allCount} powered/project records.`}
          </p>
        </div>
        <button type="button" className="button primary" onClick={onCustom}>Add custom</button>
      </div>
      <div className="fixture-search-block">
        <label className="search-label"><span className="sr-only">Search fixtures</span><input type="search" value={search} onChange={(event) => onSearch(event.target.value)} placeholder="Search brand, model, DMX mode, channels, file or watts" autoComplete="off" /></label>
        <div className="filter-tabs" aria-label="Fixture filters">
          {(["all", "favourites", "recent"] as const).map((item) => (
            <button type="button" key={item} className={filter === item ? "active" : ""} onClick={() => onFilter(item)}>{item[0].toUpperCase() + item.slice(1)}</button>
          ))}
          <button type="button" onClick={onLibrary}>Library JSON</button>
        </div>
      </div>
      <div className="fixture-results" role="list" aria-label="Fixture search results">
        {noResults && <div className="empty-state">No matching fixture. Try fewer words or search the ChamSys file name.</div>}
        {filter !== "all" && !hasSearch && definitions.length === 0 && (
          <div className="empty-state">No {filter} fixtures yet.</div>
        )}
        {definitions.map((definition) => {
          const current = calculateFixtureCurrent(definition, project.voltageV);
          const favourite = project.favourites.includes(definition.id);
          const verifiedCurrent = definition.status === "verified" && !current.estimated;
          return (
            <div key={definition.id} className="fixture-result-row" role="listitem">
              <button type="button" className={`favourite-button ${favourite ? "selected" : ""}`} aria-label={favourite ? `Remove ${definition.model} from favourites` : `Add ${definition.model} to favourites`} onClick={() => onFavourite(definition.id)}>★</button>
              <div className="fixture-identity">
                <strong>{definition.manufacturer} <span>{definition.model}</span></strong>
                <small>{definition.category}</small>
              </div>
              <div className="fixture-electrical technical">
                <strong>{definition.maxPowerW} W</strong>
                <small>{compactNumber(current.currentA, 2)} A</small>
              </div>
              <div className={`verification ${verifiedCurrent ? "verified" : "estimated"}`}><span>{verifiedCurrent ? "✓" : "!"}</span>{verifiedCurrent ? "Verified" : "Estimated"}</div>
              {definition.sourceUrl ? <a className="source-link" href={definition.sourceUrl} target="_blank" rel="noreferrer">Source</a> : <span className="source-link">No source</span>}
              <button type="button" className="button primary add-button" onClick={() => onAdd(definition)}>Add</button>
            </div>
          );
        })}
        {filter === "all" && !hasSearch && (
          <div className="catalog-search-prompt">
            <strong>Search the complete ChamSys library</strong>
            <span>Every one of its {catalogMetadata?.fixtureCount.toLocaleString() ?? "21,968"} fixture models and {catalogMetadata?.personalityCount.toLocaleString() ?? "68,757"} DMX profiles is indexed. Start typing a brand, model, mode, channel count or ChamSys file name.</span>
          </div>
        )}
        {filter === "all" && hasSearch && catalogLoading && (
          <div className="catalog-status">Loading complete ChamSys results…</div>
        )}
        {filter === "all" && catalogError && (
          <div className="catalog-status error">{catalogError}</div>
        )}
        {catalogDefinitions.length > 0 && (
          <div className="catalog-result-heading">
            <strong>ChamSys catalog</strong>
            <span>{catalogTotal.toLocaleString()} match{catalogTotal === 1 ? "" : "es"}</span>
          </div>
        )}
        {catalogDefinitions.map((fixture) => (
          <CatalogFixtureRow
            key={`catalog-${fixture.id}`}
            fixture={fixture}
            sourceUrl={catalogMetadata?.sourceUrl ?? "https://secure.chamsys.co.uk/bugtracker/personality_list.php"}
            onAdd={onCatalogAdd}
          />
        ))}
        {catalogTotal > catalogDefinitions.length && (
          <div className="catalog-status">
            Showing the first {catalogDefinitions.length.toLocaleString()} of {catalogTotal.toLocaleString()} matches. Add more of the model name, mode or channel count to narrow the results.
          </div>
        )}
      </div>
    </section>
  );
}

function CatalogFixtureRow({
  fixture,
  sourceUrl,
  onAdd,
}: {
  fixture: ChamSysFixture;
  sourceUrl: string;
  onAdd: (fixture: ChamSysFixture) => void;
}) {
  const channelValues = fixture.profiles.map((profile) => profile.channels);
  const minChannels = Math.min(...channelValues);
  const maxChannels = Math.max(...channelValues);
  const channelLabel = minChannels === maxChannels ? `${minChannels} ch` : `${minChannels}–${maxChannels} ch`;
  const authoritative =
    fixture.power?.kind === "manufacturer" || fixture.power?.kind === "gdtf-manufacturer";
  const verificationLabel = fixture.power
    ? authoritative
      ? "Mfr power"
      : "Sourced"
    : "Need watts";
  const profileTitle = fixture.profiles
    .map((profile) => `${profile.fileName} · ${profile.mode || "default"} · ${profile.channels} ch`)
    .join("\n");
  return (
    <div className="fixture-result-row catalog-result-row" role="listitem">
      <span className="catalog-mark" aria-label="ChamSys catalog fixture">CS</span>
      <div className="fixture-identity" title={profileTitle}>
        <strong>{fixture.manufacturer} <span>{fixture.model}</span></strong>
        <small>{fixture.category} · {fixture.profiles.length} profile{fixture.profiles.length === 1 ? "" : "s"} · {channelLabel}</small>
      </div>
      <div className="fixture-electrical technical">
        <strong>{fixture.power ? `${fixture.power.maxPowerW} W` : "— W"}</strong>
        <small>
          {fixture.power
            ? fixture.power.minReportedPowerW !== fixture.power.maxPowerW
              ? `${fixture.power.minReportedPowerW}–${fixture.power.maxPowerW} reported`
              : "max input"
            : "not published"}
        </small>
      </div>
      <div className={`verification ${fixture.power ? authoritative ? "verified" : "estimated" : "missing-power"}`}>
        <span>{fixture.power ? authoritative ? "✓" : "!" : "?"}</span>{verificationLabel}
      </div>
      <a className="source-link" href={fixture.power?.sourceUrl ?? sourceUrl} target="_blank" rel="noreferrer">
        {fixture.power ? "Power" : "ChamSys"}
      </a>
      <button type="button" className="button primary add-button" onClick={() => onAdd(fixture)}>
        {fixture.power ? "Add" : "Power"}
      </button>
    </div>
  );
}

function SelectedFixtures({
  project,
  definitions,
  onQuantity,
  onPatch,
  onOptimize,
  optimizing,
}: {
  project: Project;
  definitions: FixtureDefinition[];
  onQuantity: (id: string, quantity: number) => void;
  onPatch: (id: string, patch: Partial<ProjectFixture>) => void;
  onOptimize: () => void;
  optimizing: boolean;
}) {
  const totalQuantity = project.fixtures.reduce((sum, fixture) => sum + fixture.quantity, 0);
  const totalW = project.fixtures.reduce((sum, fixture) => {
    const definition = definitionFor(fixture.definitionId, definitions);
    return definition ? sum + calculateFixtureCurrent(definition, project.voltageV, fixture.activeLampCount).powerW * fixture.quantity : sum;
  }, 0);
  return (
    <section className="selected-fixtures">
      <div className="section-heading compact-heading">
        <div><h2>Selected fixtures</h2><p>{totalQuantity} units · {Math.round(totalW)} W maximum</p></div>
        <button type="button" className="button primary" disabled={!project.fixtures.length || optimizing} onClick={onOptimize}>{optimizing ? "Optimizing…" : "Optimize"}</button>
      </div>
      {!project.fixtures.length && <div className="empty-state">Search and add fixtures. Quantities and totals update immediately.</div>}
      <div className="selected-list">
        {project.fixtures.map((fixture) => {
          const definition = definitionFor(fixture.definitionId, definitions);
          if (!definition) return null;
          const electrical = calculateFixtureCurrent(definition, project.voltageV, fixture.activeLampCount);
          const assigned = fixture.assignments.filter(Boolean).length;
          return (
            <article key={fixture.id} className="selected-row">
              <div className="selected-title"><strong>{definition.manufacturer} {definition.model}</strong><span className={electrical.estimated ? "estimated-text" : "verified-text"}>{electrical.estimated ? "! Fixture current is estimated" : electrical.method === "rated-current" ? "✓ Rated current used" : electrical.method === "rated-va" ? "✓ Manufacturer VA used" : "✓ Verified watts and power factor used"}</span></div>
              <div className="quantity-control" aria-label={`Quantity of ${definition.model}`}>
                <button type="button" onClick={() => onQuantity(fixture.id, fixture.quantity - 1)} aria-label="Decrease quantity">−</button>
                <input type="number" min="0" value={fixture.quantity} onChange={(event) => onQuantity(fixture.id, Math.max(0, Math.floor(Number(event.target.value))))} aria-label="Quantity" />
                <button type="button" onClick={() => onQuantity(fixture.id, fixture.quantity + 1)} aria-label="Increase quantity">+</button>
              </div>
              <div className="selected-values technical"><span>{compactNumber(electrical.currentA * fixture.quantity, 2)} A</span><span>{Math.round(electrical.powerW * fixture.quantity)} W</span></div>
              <label className="lock-select"><span>Lock to</span><select value={fixture.lockedCircuitId ?? ""} onChange={(event) => onPatch(fixture.id, { lockedCircuitId: event.target.value || null, assignments: event.target.value ? Array(fixture.quantity).fill(event.target.value) : fixture.assignments })}><option value="">Automatic</option>{project.circuits.filter((circuit) => circuit.enabled).map((circuit) => <option key={circuit.id} value={circuit.id}>{circuit.name}</option>)}</select></label>
              <div className="assignment-count technical">{assigned}/{fixture.quantity} assigned</div>
              {definition.removableLamps && definition.lampCount !== null && (
                <div className="lamp-control">
                  <label><span>Active lamps</span><div className="input-unit compact"><input type="number" min="0" max={definition.lampCount} value={fixture.activeLampCount ?? definition.lampCount} onChange={(event) => onPatch(fixture.id, { activeLampCount: Math.max(0, Math.min(definition.lampCount!, Number(event.target.value))) })} /><b>/ {definition.lampCount}</b></div></label>
                  {electrical.removedPowerW > 0 && <p>! Removing lamps reduces the estimated load by {electrical.removedPowerW * fixture.quantity} W. Partial-load calculation is {definition.partialLoadVerified ? "verified" : "estimated"}.</p>}
                </div>
              )}
              <button type="button" className="delete-link" onClick={() => onQuantity(fixture.id, 0)}>Delete</button>
            </article>
          );
        })}
      </div>
      <SafetyNotice />
    </section>
  );
}

function PowerPlan({
  project,
  definitions,
  loads,
  overload,
  optimizing,
  onOptimize,
  onAddCircuit,
  onMove,
  onReorder,
  onDrop,
}: {
  project: Project;
  definitions: FixtureDefinition[];
  loads: CircuitLoad[];
  overload: ReturnType<typeof overloadSolutions>;
  optimizing: boolean;
  onOptimize: () => void;
  onAddCircuit: () => void;
  onMove: (fixtureId: string, from: string | null, to: string | null) => void;
  onReorder: (fixtureId: string, direction: -1 | 1) => void;
  onDrop: (event: DragEvent<HTMLElement>, targetCircuitId: string) => void;
}) {
  const unassigned = project.fixtures.reduce((sum, fixture) => sum + fixture.assignments.filter((id) => id === null).length, 0);
  return (
    <section className="power-plan-view">
      <div className="section-heading">
        <div><h1>Power plan</h1><p>{unassigned ? `${unassigned} unassigned fixtures` : "All selected fixtures assigned"}</p></div>
        <div className="heading-actions"><button type="button" className="button secondary" onClick={onAddCircuit}>Add circuit</button><button type="button" className="button primary" disabled={!project.fixtures.length || optimizing} onClick={onOptimize}>{optimizing ? "Optimizing…" : "Optimize"}</button></div>
      </div>
      {unassigned > 0 && (
        <article className="unassigned-panel">
          <div className="status-message planning-over"><span>!</span>{unassigned} unassigned fixture{unassigned === 1 ? "" : "s"}</div>
          <div className="assigned-items">
            {project.fixtures.map((fixture) => {
              const count = fixture.assignments.filter((id) => id === null).length;
              const definition = definitionFor(fixture.definitionId, definitions);
              if (!count || !definition) return null;
              return <AssignedFixtureRow key={fixture.id} fixture={fixture} definition={definition} count={count} fromCircuitId={null} circuits={project.circuits} onMove={onMove} onReorder={onReorder} />;
            })}
          </div>
        </article>
      )}
      <div className="plan-circuit-list">
        {loads.map((load) => (
          <article key={load.circuit.id} className={`plan-circuit status-${load.status}`} onDragOver={(event) => event.preventDefault()} onDrop={(event) => onDrop(event, load.circuit.id)}>
            <div className="plan-circuit-header">
              <div><h2>{load.circuit.name}</h2><span>{load.circuit.phase || "No phase"} · {load.circuit.breakerA} A breaker · {compactNumber(load.planningLimitA)} A planning limit</span></div>
              <div className="plan-load technical"><strong>{compactNumber(load.loadA, 2)} A</strong><span>{Math.round(load.powerW)} W · {Math.round(load.percentageUsed)}%</span></div>
            </div>
            <CapacityBar load={load} />
            <div className={`status-message ${load.status}`}><span>{statusMark(load.status)}</span>{load.message}</div>
            {(load.hasEstimatedCurrent || load.hasUnknownInrush) && load.fixtureCount > 0 && (
              <div className="warning-line">{load.hasEstimatedCurrent && <span>! Fixture current is estimated</span>}{load.hasUnknownInrush && <span>! Inrush current is unknown</span>}</div>
            )}
            <div className="assigned-items">
              {project.fixtures.map((fixture) => {
                const count = fixture.assignments.filter((id) => id === load.circuit.id).length;
                const definition = definitionFor(fixture.definitionId, definitions);
                if (!count || !definition) return null;
                return <AssignedFixtureRow key={fixture.id} fixture={fixture} definition={definition} count={count} fromCircuitId={load.circuit.id} circuits={project.circuits} onMove={onMove} onReorder={onReorder} />;
              })}
              {!load.fixtureCount && <div className="empty-circuit">No fixtures assigned. Drop or move fixtures here.</div>}
            </div>
          </article>
        ))}
      </div>
      {overload.missingA > 0 && (
        <section className="solutions-panel">
          <div className="solutions-heading"><div><h2>Load does not fit</h2><p><span className="technical">{compactNumber(overload.missingA)} A · {Math.round(overload.missingW)} W</span> missing planning capacity. {overload.extraCircuits === 1 ? "One additional 16 A circuit is required." : `${overload.extraCircuits} additional 16 A circuits are required.`}</p>{loads.filter((load) => load.loadA > load.planningLimitA).map((load) => { const overA = load.loadA - load.planningLimitA; const overW = load.loadA > 0 ? (overA / load.loadA) * load.powerW : 0; return <p key={load.circuit.id}>{load.circuit.name}: <span className="technical">{compactNumber(overA)} A · {Math.round(overW)} W</span> over the selected planning limit.</p>; })}</div></div>
          <ol>{overload.solutions.map((solution) => <li key={solution.title}><strong>{solution.title}</strong><span>{solution.detail}</span></li>)}</ol>
        </section>
      )}
      <SafetyNotice />
    </section>
  );
}

function AssignedFixtureRow({
  fixture,
  definition,
  count,
  fromCircuitId,
  circuits,
  onMove,
  onReorder,
}: {
  fixture: ProjectFixture;
  definition: FixtureDefinition;
  count: number;
  fromCircuitId: string | null;
  circuits: Circuit[];
  onMove: (fixtureId: string, from: string | null, to: string | null) => void;
  onReorder: (fixtureId: string, direction: -1 | 1) => void;
}) {
  return (
    <div className="assigned-row" draggable={fromCircuitId !== null} onDragStart={(event) => event.dataTransfer.setData("application/json", JSON.stringify({ fixtureId: fixture.id, fromCircuitId }))}>
      <span className="drag-handle" aria-hidden="true">⋮⋮</span>
      <div><strong>{count} × {definition.manufacturer} {definition.model}</strong><small>{fixture.lockedCircuitId ? "Locked assignment" : definition.category}</small></div>
      <div className="assigned-actions">
        <button type="button" onClick={() => onReorder(fixture.id, -1)}>Move up</button>
        <button type="button" onClick={() => onReorder(fixture.id, 1)}>Move down</button>
        <label><span className="sr-only">Move to circuit</span><select aria-label="Move to circuit" value="" onChange={(event) => { if (event.target.value !== "") onMove(fixture.id, fromCircuitId, event.target.value === "unassigned" ? null : event.target.value); }}><option value="">Move</option><option value="unassigned">Unassigned</option>{circuits.filter((circuit) => circuit.enabled && circuit.id !== fromCircuitId).map((circuit) => <option key={circuit.id} value={circuit.id}>{circuit.name}</option>)}</select></label>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="metric"><span>{label}</span><strong className="technical">{value}</strong></div>;
}

function CapacityBar({ load }: { load: CircuitLoad }) {
  const planningPercentage = Math.min(100, (load.planningLimitA / load.circuit.breakerA) * 100);
  const loadPercentage = Math.min(100, Math.max(0, load.percentageUsed));
  return (
    <div className="capacity-wrap" aria-label={`${load.message}. ${compactNumber(load.loadA)} of ${load.circuit.breakerA} amperes.`}>
      <div className="capacity-track">
        <div className={`capacity-fill ${load.status}`} style={{ width: `${loadPercentage}%` }} />
        <span className="planning-marker" style={{ left: `${planningPercentage}%` }} aria-hidden="true" />
      </div>
      <div className="capacity-labels technical"><span>0 A</span><span>Plan {compactNumber(load.planningLimitA)} A</span><span>{load.circuit.breakerA} A</span></div>
    </div>
  );
}

function MobileSummary({
  totals,
  circuitCount,
}: {
  totals: ReturnType<typeof projectTotals>;
  circuitCount: number;
}) {
  return (
    <aside className={`mobile-summary ${totals.tone}`} aria-label="Current load summary">
      <Metric label="Total" value={`${compactNumber(totals.totalA)} A`} />
      <Metric label="Power" value={`${Math.round(totals.totalW)} W`} />
      <Metric label="Circuits" value={`${totals.usedCircuits}/${circuitCount}`} />
      <Metric label="Highest" value={`${compactNumber(totals.highestLoad)} A`} />
      <Metric label="Remaining" value={`${compactNumber(totals.remainingCapacity)} A`} />
      <div className="summary-status"><span>{totals.tone === "safe" ? "✓" : "!"}</span><strong>{totals.status}</strong></div>
    </aside>
  );
}

function SafetyNotice() {
  return (
    <p className="safety-notice"><span>!</span> WattPatch is a load-planning tool. Verify breakers, cables, connectors, distribution, RCD protection, inrush current and venue requirements before connecting equipment.</p>
  );
}
