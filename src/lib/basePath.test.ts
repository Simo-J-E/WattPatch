import { describe, expect, it } from "vitest";
import { githubPagesBase } from "./basePath";

describe("GitHub Pages base path", () => {
  it("uses the repository directory on GitHub", () => {
    expect(githubPagesBase("Simo-J-E/WattPatch")).toBe("/WattPatch/");
  });

  it("uses root during local development", () => {
    expect(githubPagesBase(undefined)).toBe("/");
  });

  it("handles a repository name without an owner", () => {
    expect(githubPagesBase("WattPatch")).toBe("/WattPatch/");
  });
});
