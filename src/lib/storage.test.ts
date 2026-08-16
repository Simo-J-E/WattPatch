import { describe, expect, it } from "vitest";
import { loadProjects, saveProjects, uniqueProjectName, type StorageLike } from "./storage";
import type { Project } from "../types";

class MemoryStorage implements StorageLike {
  private values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function project(name: string): Project {
  return {
    id: name,
    name,
    voltageV: 230,
    frequencyHz: 50,
    reservePercentage: 20,
    circuits: [],
    fixtures: [],
    customFixtures: [],
    favourites: [],
    recentFixtureIds: [],
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-16T00:00:00.000Z",
  };
}

describe("project storage", () => {
  it("saves and restores projects", () => {
    const storage = new MemoryStorage();
    const source = [project("Tour")];
    saveProjects(storage, source);
    expect(loadProjects(storage)).toEqual(source);
  });

  it("returns no projects for corrupt JSON", () => {
    const storage = new MemoryStorage();
    storage.setItem("wattpatch.projects.v1", "not-json");
    expect(loadProjects(storage)).toEqual([]);
  });

  it("does not overwrite a project name", () => {
    expect(uniqueProjectName([project("Tour"), project("Tour 2")], "Tour")).toBe("Tour 3");
  });
});
