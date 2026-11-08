# Adopting ideas from World Monitor

[World Monitor](https://github.com/koala73/worldmonitor) is an AGPL-3.0
real-time intelligence dashboard. Sector 9 already covers most of the same
domains (flights, maritime, CCTV, seismic, fires, weather, cyber, conflict,
markets, OSINT toolkit), so a wholesale port would mostly duplicate. This
change takes the handful of capabilities that Sector 9 verifiably lacked and
implements them in this codebase's own terms.

## What was added

| Feature | Where | What it does |
|---|---|---|
| **Flashpoints** (cross-source convergence) | `src/lib/convergence.ts`, `src/components/ConvergencePanel.tsx`, `src/components/OsirisMap.tsx` | Bins the feeds already loaded (earthquakes, fires, weather, GDELT, alert pins, botnet C2) into 1° cells; a cell is a flashpoint when three or more event types co-occur inside 24 h. Client-side: no extra request, no new source. |
| **Instability Index v0.1** | `src/lib/cii.ts`, `src/components/CiiPanel.tsx` | Keeps `country-risk.ts`'s editorial baseline as 40 % and adds 60 % live event pressure (conflict from GDELT, unrest from alert pins, information volume, seismic hazards, hosted C2). Reports per-component coverage; an unavailable feed is `null`, never `0`. 24 h movement comes from a browser snapshot with its age attached. |
| **Disease outbreaks** | `src/app/api/disease-outbreaks/route.ts`, `src/lib/disease-outbreaks.ts`, `src/components/DiseaseOutbreaksPanel.tsx`, `src/components/OsirisMap.tsx` | WHO Disease Outbreak News (keyless OData feed). Bulletins are normalised, HTML-stripped, country-attributed, and placed at the named country's centroid — explicitly not an outbreak location. |
| **Data-freshness strip** | `src/lib/freshness.ts`, `src/components/FreshnessStrip.tsx`, `src/app/page.tsx` | Every `fetchEndpoint` call stamps its feed; the HUD strip shows LIVE / STALE / DOWN / IDLE from the last success. Makes a degraded route visible instead of console-only. |
| **Weather balloons** | `src/app/api/balloons/route.ts`, `src/lib/balloons.ts` | Repairs a layer that was fully wired in `page.tsx` and `OsirisMap.tsx` (state, sources, layers, popups, polling) but had no API route, so it 404'd if ever enabled. Now backed by SondeHub radiosonde telemetry; also exposed in the layer panel. |

One new rail button ("ANALYSIS", keyboard `a`) hosts Flashpoints, Instability
and Outbreaks as three tabs; the OI assist catalog can open it and switch the
new layers.

## What was deliberately not adopted

- **Radiation Watch** — the dangling `radiation` layer remains dangling. The
  only keyless global source found (Safecast's public API) returns at most 25
  observations regardless of the window, which is not enough to be a useful
  layer. Better to leave it off than to ship a misleading one.
- **Full CII v14** — its inputs (ACLED, UCDP, travel-advisory feeds, OREF
  relays) are credentialed, licensed, or relay-backed. Sector 9's v0.1 uses
  only feeds the browser already holds and says so in the panel.
- **Trade/tariff tracker, consumer prices, airline intel, X/Twitter intel,
  Hormuz tracker, energy-crisis tracker** — each depends on a paid API or
  fragile scraping infrastructure that Sector 9 does not have.
- **Tauri desktop, four SDKs, full TUI, site variants, i18n/RTL, accounts and
  billing** — real projects, but distribution-surface work rather than
  intelligence capability, and out of scope for this change.

## Licensing

World Monitor's source is **AGPL-3.0-only**. No World Monitor code, data table,
or copy was copied or machine-translated into this repository. Each feature was
implemented independently from its published documentation and methodology; the
weights and thresholds that are described there are re-stated as this project's
own, with their own comments and tests. Sector 9 remains MIT-licensed.
