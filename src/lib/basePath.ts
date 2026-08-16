export function githubPagesBase(repository?: string): string {
  if (!repository) return "/";
  const repoName = repository.split("/").filter(Boolean).at(-1);
  return repoName ? `/${repoName}/` : "/";
}
