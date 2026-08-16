# WattPatch

WattPatch is an offline stage-lighting power planner. It calculates fixture current, checks breaker and planning limits, distributes fixtures across mixed circuits, and exports a production-ready circuit list.

## Included

- 230 V, 50 Hz and 16 A defaults with configurable voltage and planning reserve
- Mixed breaker sizes, custom circuit names, phase labels, disabled circuits and locked assignments
- Full local ChamSys search across 21,968 fixture models and 68,757 personalities, plus favourites, recent fixtures and custom loads
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

`public/data/chamsys-fixtures.json` is the complete offline ChamSys catalog snapshot from 15 August 2026. It preserves all 949 manufacturer labels, 21,968 unique manufacturer/model combinations and every one of the 68,757 DMX personality rows. Search covers manufacturer, model, category, mode, channel count and ChamSys file name. Results are capped only for display; the search evaluates the whole catalog.

ChamSys publishes DMX personality information but not fixture power. WattPatch joins electrical data only on conservative, normalized manufacturer-and-model matches. The current snapshot has sourced maximum-input power for 1,293 exact fixture models:

- 11 existing records linked to manufacturer product pages
- 278 records from manufacturer-uploaded GDTF data
- 237 records from Open Fixture Library
- 767 records from QLC+ fixture data

Manufacturer and manufacturer-uploaded GDTF values take precedence. Community-library values remain visibly estimated. When sources disagree, WattPatch plans with the highest reported value and shows the reported range. The remaining 20,675 models stay searchable but require a documented maximum-input wattage before they can be added to a power plan. Lamp output, DMX channel count and product-name wattage are never converted into invented input power.

`src/data/fixtures.json` remains the small verified electrical library. Each record includes its source URL and verification date. Missing rated current, VA or power factor stays missing, so any derived current is labeled estimated.

The JSON Schema is at `src/data/fixtures.schema.json`. New fixture proposals should use the issue template and cite an official manufacturer source.

To rebuild the catalog from current sources, clone Open Fixture Library and QLC+, then run:

```bash
python3 scripts/update_chamsys_catalog.py \
  --builtin src/data/fixtures.json \
  --gdtf scripts/data/gdtf-manufacturer-power.json \
  --ofl /path/to/open-fixture-library \
  --qlc /path/to/qlcplus \
  --qlc /path/to/qlcplus-extras \
  --output public/data/chamsys-fixtures.json
```

Without `--chamsys`, the updater downloads the current official ChamSys table. The GDTF power snapshot is included because the public Fixture Finder exposes its power records separately from the ChamSys identities.

## Project data and privacy

Projects remain in the browser using LocalStorage. WattPatch has no backend, account, API key, analytics or paid service. Export project JSON before clearing browser data or changing devices.
