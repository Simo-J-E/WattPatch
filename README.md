# WattPatch

WattPatch is an offline stage-lighting power planner. It calculates fixture current, checks breaker and planning limits, distributes fixtures across mixed circuits, and exports a production-ready circuit list.

## Included

- 230 V, 50 Hz and 16 A defaults with configurable voltage and planning reserve
- Mixed breaker sizes, custom circuit names, phase labels, disabled circuits and locked assignments
- Local fixture search with sourced records, favourites, recent fixtures and custom loads
- Maximum-load current calculations with explicit estimated-current warnings
- Removable-lamp calculations for supported fixtures
- Web Worker circuit optimizer with breaker, reserve, group, inrush and phase handling
- Manual move controls and drag-and-drop on desktop
- Automatic project saving in browser storage
- Project and fixture-library JSON import/export
- CSV, print and plain-text exports
- Installable PWA that works offline after the first visit
- Mobile layout from 320 px with a fixed load summary and bottom navigation

WattPatch is a planning tool. It is not an electrical installation certificate.

## Run locally

Install Node.js 22 or newer.

```bash
npm install
npm run dev
```

Open the local address printed by Vite.

## Quality checks

```bash
npm run typecheck
npm test
npm run build
```

The production files are written to `dist`.

## Deploy to GitHub Pages

1. Create an empty GitHub repository.
2. Put the contents of this folder at the repository root.
3. Push the files to the `main` branch.
4. In GitHub, open **Settings → Pages**.
5. Set **Source** to **GitHub Actions**.
6. Open **Actions** and wait for **Deploy WattPatch to Pages** to finish.

The workflow reads `GITHUB_REPOSITORY` and builds with the correct repository base path. The site will work at:

```text
https://USERNAME.github.io/REPOSITORY/
```

No custom base-path edit is needed. The application uses one client-side entry point, so refreshing does not create a GitHub Pages route error.

## Fixture data

`src/data/fixtures.json` is the built-in offline database. Each record includes its source URL and verification date. Missing current or power-factor data stays missing. WattPatch labels any derived current as estimated.

The JSON Schema is at `src/data/fixtures.schema.json`. New fixture proposals should use the issue template and cite an official manufacturer source.

WattPatch does not claim to include every fixture. Use **Add custom** for any unlisted load.

## Project data and privacy

Projects remain in the browser using LocalStorage. WattPatch has no backend, account, API key, analytics or paid service. Export project JSON before clearing browser data or changing devices.
