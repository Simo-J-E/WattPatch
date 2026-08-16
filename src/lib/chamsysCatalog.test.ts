import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  catalogFixtureToDefinition,
  parseChamSysCatalog,
  searchChamSysCatalog,
} from "./chamsysCatalog";

function loadFullCatalog() {
  const path = resolve(process.cwd(), "public/data/chamsys-fixtures.json");
  return parseChamSysCatalog(JSON.parse(readFileSync(path, "utf-8")) as unknown);
}

describe("ChamSys catalog", () => {
  it("contains every model and personality in the source snapshot", () => {
    const catalog = loadFullCatalog();
    const profiles = catalog.fixtures.flatMap((fixture) => fixture.profiles);
    expect(catalog.metadata.libraryDate).toBe("2026-08-15");
    expect(catalog.fixtures).toHaveLength(21_968);
    expect(profiles).toHaveLength(68_757);
    expect(new Set(catalog.fixtures.map((fixture) => fixture.id)).size).toBe(21_968);
    expect(new Set(profiles.map((profile) => profile.fileName)).size).toBe(68_757);
    expect(catalog.fixtures.filter((fixture) => fixture.power !== null)).toHaveLength(
      catalog.metadata.powerMatchedFixtureCount,
    );
  });

  it("searches manufacturer, model, mode, channel count and ChamSys file name", () => {
    const catalog = loadFullCatalog();
    expect(searchChamSysCatalog(catalog.fixtures, "5Star Helix255M 16bit").items[0]?.model).toBe(
      "Helix255M",
    );
    expect(searchChamSysCatalog(catalog.fixtures, "5Star_Helix255M_8bit").items[0]?.model).toBe(
      "Helix255M",
    );
    expect(searchChamSysCatalog(catalog.fixtures, "ZZSPARMOVE 5ch").items[0]?.manufacturer).toBe(
      "Zzipp",
    );
    const broad = searchChamSysCatalog(catalog.fixtures, "24ch", 12);
    expect(broad.total).toBeGreaterThan(12);
    expect(broad.items).toHaveLength(12);
  });

  it("does not return the giant catalog until a search is entered", () => {
    const catalog = loadFullCatalog();
    expect(searchChamSysCatalog(catalog.fixtures, "   ")).toEqual({ items: [], total: 0 });
  });

  it("turns sourced catalog power into a planning definition without inventing current", () => {
    const catalog = loadFullCatalog();
    const fixture = catalog.fixtures.find(
      (item) => item.manufacturer === "5Star" && item.model === "Spica 250M",
    );
    expect(fixture?.power?.maxPowerW).toBe(500);
    const definition = catalogFixtureToDefinition(fixture!, catalog.metadata.generatedDate);
    expect(definition.maxPowerW).toBe(500);
    expect(definition.ratedCurrentA).toBeNull();
    expect(definition.powerFactor).toBeNull();
    expect(definition.status).toBe("estimated");
    expect(definition.sourceUrl).toContain("open-fixture-library");
  });
});
