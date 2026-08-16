import { FIXTURE_TYPES, type FixtureDefinition, type FixtureType } from "../types";

export interface ChamSysCatalogMetadata {
  schemaVersion: number;
  generatedDate: string;
  libraryDate: string;
  libraryDateText: string;
  sourceUrl: string;
  manufacturerCount: number;
  fixtureCount: number;
  personalityCount: number;
  powerMatchedFixtureCount: number;
  unknownPowerFixtureCount: number;
  conflictingPowerFixtureCount: number;
  powerSourceCounts: Record<string, number>;
  openFixtureLibraryRevision: string;
  qlcPlusRevisions: string[];
  gdtfFixtureFinderUrl: string;
}

export interface ChamSysProfile {
  mode: string;
  channels: number;
  fileName: string;
}

export type CatalogPowerKind =
  | "manufacturer"
  | "gdtf-manufacturer"
  | "open-fixture-library"
  | "qlc-plus";

export interface CatalogPower {
  maxPowerW: number;
  minReportedPowerW: number;
  kind: CatalogPowerKind;
  sourceUrl: string;
  sourceCount: number;
}

export interface ChamSysFixture {
  id: string;
  manufacturer: string;
  model: string;
  category: FixtureType;
  profiles: ChamSysProfile[];
  power: CatalogPower | null;
}

interface IndexedChamSysFixture extends ChamSysFixture {
  identityText: string;
  modelText: string;
  searchText: string;
  compactSearchText: string;
}

export interface ChamSysCatalog {
  metadata: ChamSysCatalogMetadata;
  fixtures: ChamSysFixture[];
}

export interface CatalogSearchResult {
  items: ChamSysFixture[];
  total: number;
}

const POWER_KINDS = new Set<CatalogPowerKind>([
  "manufacturer",
  "gdtf-manufacturer",
  "open-fixture-library",
  "qlc-plus",
]);

export function normalizeCatalogText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/\+/g, " plus ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function compact(value: string): string {
  return normalizeCatalogText(value).replaceAll(" ", "");
}

export function catalogIdentityKey(manufacturer: string, model: string): string {
  const manufacturerKey = compact(manufacturer);
  let modelKey = compact(model)
    .replace(/markii/g, "mk2")
    .replace(/mkii/g, "mk2")
    .replace(/markiii/g, "mk3")
    .replace(/mkiii/g, "mk3");
  if (manufacturerKey === "robe" && modelKey.startsWith("robin")) {
    modelKey = modelKey.slice(5);
  }
  return `${manufacturerKey}\u0000${modelKey}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parsePower(value: unknown): CatalogPower | null {
  if (value === undefined) return null;
  if (
    !Array.isArray(value) ||
    value.length !== 5 ||
    typeof value[0] !== "number" ||
    value[0] <= 0 ||
    typeof value[1] !== "number" ||
    value[1] <= 0 ||
    typeof value[2] !== "string" ||
    !POWER_KINDS.has(value[2] as CatalogPowerKind) ||
    typeof value[3] !== "string" ||
    typeof value[4] !== "number"
  ) {
    throw new Error("ChamSys catalog contains invalid power data");
  }
  return {
    maxPowerW: value[0],
    minReportedPowerW: value[1],
    kind: value[2] as CatalogPowerKind,
    sourceUrl: value[3],
    sourceCount: value[4],
  };
}

function parseFixture(value: unknown): IndexedChamSysFixture {
  if (
    !Array.isArray(value) ||
    (value.length !== 5 && value.length !== 6) ||
    typeof value[0] !== "string" ||
    typeof value[1] !== "string" ||
    typeof value[2] !== "string" ||
    typeof value[3] !== "number" ||
    !Array.isArray(value[4])
  ) {
    throw new Error("ChamSys catalog contains an invalid fixture record");
  }
  const category = FIXTURE_TYPES[value[3]];
  if (!category) throw new Error("ChamSys catalog contains an invalid fixture category");
  const profiles = value[4].map((profile) => {
    if (
      !Array.isArray(profile) ||
      profile.length !== 3 ||
      typeof profile[0] !== "string" ||
      typeof profile[1] !== "number" ||
      profile[1] < 0 ||
      typeof profile[2] !== "string"
    ) {
      throw new Error("ChamSys catalog contains an invalid personality record");
    }
    return { mode: profile[0], channels: profile[1], fileName: profile[2] };
  });
  const identityText = normalizeCatalogText(`${value[1]} ${value[2]}`);
  const modelText = normalizeCatalogText(value[2]);
  const searchText = normalizeCatalogText(
    `${value[1]} ${value[2]} ${category} ${profiles
      .map((profile) => `${profile.mode} ${profile.channels}ch ${profile.fileName}`)
      .join(" ")}`,
  );
  return {
    id: value[0],
    manufacturer: value[1],
    model: value[2],
    category,
    profiles,
    power: parsePower(value[5]),
    identityText,
    modelText,
    searchText,
    compactSearchText: searchText.replaceAll(" ", ""),
  };
}

export function parseChamSysCatalog(value: unknown): ChamSysCatalog {
  if (!isRecord(value) || !isRecord(value.metadata) || !Array.isArray(value.fixtures)) {
    throw new Error("ChamSys catalog response is invalid");
  }
  const metadata = value.metadata as unknown as ChamSysCatalogMetadata;
  if (
    metadata.schemaVersion !== 1 ||
    typeof metadata.fixtureCount !== "number" ||
    typeof metadata.personalityCount !== "number" ||
    typeof metadata.sourceUrl !== "string"
  ) {
    throw new Error("ChamSys catalog metadata is invalid");
  }
  const fixtures = value.fixtures.map(parseFixture);
  const personalityCount = fixtures.reduce((sum, fixture) => sum + fixture.profiles.length, 0);
  if (fixtures.length !== metadata.fixtureCount || personalityCount !== metadata.personalityCount) {
    throw new Error("ChamSys catalog counts do not match its contents");
  }
  return { metadata, fixtures };
}

export async function loadChamSysCatalog(signal?: AbortSignal): Promise<ChamSysCatalog> {
  const response = await fetch(`${import.meta.env.BASE_URL}data/chamsys-fixtures.json`, { signal });
  if (!response.ok) throw new Error(`ChamSys catalog request failed (${response.status})`);
  return parseChamSysCatalog(await response.json());
}

function fixtureScore(fixture: IndexedChamSysFixture, normalizedQuery: string): number {
  if (fixture.identityText === normalizedQuery) return 0;
  if (fixture.modelText === normalizedQuery) return 1;
  if (fixture.identityText.startsWith(normalizedQuery)) return 2;
  if (fixture.modelText.startsWith(normalizedQuery)) return 3;
  if (normalizeCatalogText(fixture.manufacturer).startsWith(normalizedQuery)) return 4;
  return 5;
}

export function searchChamSysCatalog(
  fixtures: ChamSysFixture[],
  query: string,
  limit = 150,
): CatalogSearchResult {
  const normalizedQuery = normalizeCatalogText(query);
  if (!normalizedQuery) return { items: [], total: 0 };
  const terms = normalizedQuery.split(" ").filter(Boolean);
  const matches = (fixtures as IndexedChamSysFixture[]).filter((fixture) =>
    terms.every(
      (term) => fixture.searchText.includes(term) || fixture.compactSearchText.includes(term),
    ),
  );
  matches.sort((a, b) => {
    const score = fixtureScore(a, normalizedQuery) - fixtureScore(b, normalizedQuery);
    if (score) return score;
    return `${a.manufacturer} ${a.model}`.localeCompare(`${b.manufacturer} ${b.model}`);
  });
  return { items: matches.slice(0, Math.max(1, limit)), total: matches.length };
}

function powerSourceLabel(kind: CatalogPowerKind): string {
  if (kind === "manufacturer") return "the manufacturer";
  if (kind === "gdtf-manufacturer") return "a manufacturer-uploaded GDTF file";
  if (kind === "open-fixture-library") return "Open Fixture Library";
  return "QLC+ fixture data";
}

export function catalogFixtureToDefinition(
  fixture: ChamSysFixture,
  verificationDate: string,
): FixtureDefinition {
  if (!fixture.power) throw new Error("A power value is required before this fixture can be added");
  const conflict = fixture.power.minReportedPowerW !== fixture.power.maxPowerW;
  const authoritative =
    fixture.power.kind === "manufacturer" || fixture.power.kind === "gdtf-manufacturer";
  return {
    id: fixture.id,
    manufacturer: fixture.manufacturer,
    model: fixture.model,
    category: fixture.category,
    maxPowerW: fixture.power.maxPowerW,
    ratedCurrentA: null,
    ratedCurrentVoltageV: null,
    maxVA: null,
    supportedVoltage: "Verify supported voltage in the linked source",
    powerFactor: null,
    inrushCurrentA: null,
    lampCount: null,
    lampWattage: null,
    internalBasePowerW: null,
    removableLamps: false,
    partialLoadVerified: false,
    sourceUrl: fixture.power.sourceUrl,
    verificationDate,
    status: authoritative ? "verified" : "estimated",
    estimationNote: conflict
      ? `Sources report ${fixture.power.minReportedPowerW}–${fixture.power.maxPowerW} W. WattPatch uses the highest value for conservative planning; verify against manufacturer documentation.`
      : `Maximum input power from ${powerSourceLabel(fixture.power.kind)}. Current remains estimated until rated current, VA, or power factor is verified.`,
  };
}
