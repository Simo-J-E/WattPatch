import type { Project } from "../types";

export const PROJECT_STORAGE_KEY = "wattpatch.projects.v1";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function loadProjects(storage: StorageLike): Project[] {
  try {
    const raw = storage.getItem(PROJECT_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (project): project is Project =>
        Boolean(project) &&
        typeof project === "object" &&
        typeof (project as Project).id === "string" &&
        Array.isArray((project as Project).circuits) &&
        Array.isArray((project as Project).fixtures),
    );
  } catch {
    return [];
  }
}

export function saveProjects(storage: StorageLike, projects: Project[]): void {
  storage.setItem(PROJECT_STORAGE_KEY, JSON.stringify(projects));
}

export function uniqueProjectName(existing: Project[], preferred: string): string {
  const names = new Set(existing.map((project) => project.name.toLowerCase()));
  if (!names.has(preferred.toLowerCase())) return preferred;
  let suffix = 2;
  while (names.has(`${preferred} ${suffix}`.toLowerCase())) suffix += 1;
  return `${preferred} ${suffix}`;
}
