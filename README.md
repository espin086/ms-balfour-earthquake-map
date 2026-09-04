# California Earthquake + Tsunami Explorer

A single-page React app that plots recent California earthquakes on a map and lets a class
filter, inspect, and export them. It pulls live data from the USGS earthquake catalog, draws
each event as a colored circle sized by magnitude, and shows a bar chart of how many quakes
fall into each magnitude group. It was built for a 3rd grade classroom demo, so the wording in
the popups and side panel is written for kids ("How strong was it?", "Could it make a tsunami?").

## Features

- Map of California earthquakes at magnitude 2.0 and above, from the USGS FDSN event API.
- Three views: all quakes, stronger quakes (M4+), and quakes USGS flagged for tsunami.
- Three time windows: last 24 hours, last 30 days, last 5 years.
- Click a circle to see place, magnitude, local time, and the tsunami flag.
- Summary stats for whatever is on screen: count, biggest magnitude, average magnitude, tsunami-flagged count.
- Bar chart of counts per magnitude bucket (2.0-2.4 through 6.0+).
- Export the current filtered set to an `.xlsx` file.
- View and range are stored in the URL query string (`?view=m4&range=30d`), so a filtered view can be shared or bookmarked.
- Data is cached in `localStorage` for a week; on later loads the app only fetches events newer than what it already has.

## Requirements

- Node.js 20 (the GitHub Pages workflow builds on Node 20).
- npm.
- A network connection for the first load, since the data comes from USGS and the basemap tiles come from CARTO.

## Installation

```bash
npm install
```

## Usage

Run the dev server:

```bash
npm run dev
```

Build to `dist/`:

```bash
npm run build
```

Serve the production build locally:

```bash
npm run preview
```

Pushing to `main` triggers `.github/workflows/pages.yml`, which builds and deploys `dist/` to
GitHub Pages. `vite.config.js` sets `base: "./"` so the build works from a project subpath.

Two buttons in the app change data state:

- **Refresh Latest Data** clears the `localStorage` cache and reloads the page, forcing a full 5-year refetch.
- **Download Excel File** writes `california-earthquakes-YYYY-MM-DD.xlsx` containing the rows currently shown.

## Project structure

```
index.html                  Page shell, mounts #root and loads src/main.jsx
package.json                Dependencies and the dev/build/preview scripts
vite.config.js              Vite config, base set to "./" for Pages
src/main.jsx                React entry point, imports Leaflet CSS and styles.css
src/App.jsx                 The whole app: fetching, caching, map, chart, filters, export
src/styles.css              Dark theme layout for the cards, chips, map, and chart
.github/workflows/pages.yml Build on push to main and deploy to GitHub Pages
```

## How it works

Data comes from `https://earthquake.usgs.gov/fdsnws/event/1/query` in GeoJSON format. The app
requests a bounding box of lat 32 to 42 and lon -125 to -114 with `minmagnitude=2.0`. Because
the USGS API limits how much a single query returns, the 5-year window is split into 180-day
chunks and fetched in sequence. Results are then filtered a second time in the browser: an event
is kept only if its `place` string matches ", CA" or contains "california", and Baja California
events are dropped.

Fetched events are merged by USGS event id into whatever is already cached, sorted newest first,
and written back to `localStorage` under `caQuakesReactCacheV1`. If the cache is less than a week
old the app skips the network entirely. Otherwise it fetches only from one second after the newest
cached event, so refreshes stay small. A timer re-runs the same load every 5 minutes.

Rendering uses Leaflet with a CARTO dark basemap and canvas-rendered `circleMarker`s, colored and
sized by magnitude. The histogram is a Chart.js bar chart that recomputes its buckets whenever the
view or time window changes. The Excel export uses SheetJS (`xlsx`) in the browser; no server is
involved anywhere in the app.

`playwright` is listed as a dev dependency but there are no test files in the repo, so there is no
test command to run.

## License

No LICENSE file is present in this repo.
