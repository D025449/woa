# simple-nodejs-app

Simple-nodejs-app is a simple web application created using [Node.js](https://github.com/nodejs/node). It uses [MediaWiki - Wikipedia's Search API](https://www.mediawiki.org/wiki/API:Opensearch) to search for anything entered by the user and parses the result in a JSON format. The infobox of the Wikipedia page is parsed using [wiki-infobox-parser](https://github.com/0x333333/wiki-infobox-parser).

## Download and Installation

- Clone the repo ```https://github.com/rat9615/simple-nodejs-app```
- [Fork, Clone or Download on Github](https://github.com/rat9615/simple-nodejs-app)

## Usage

- Die zentrale Übersicht aller npm-Skripte mit Parametern, Voraussetzungen und Auswirkungen steht in [docs/npm-scripts.md](docs/npm-scripts.md).
- After installation, run ```npm install``` to download and install all the required dependencies.
- Run ```npm start``` to run the web application.
- Run `npm run start:all` to start the app and both workers together. In development, app/Cognito URLs automatically use localhost and the configured port (default 3000); `Ctrl+C` stops all three processes.
- Run `npm run start:tunnel` to start the same services with a public ngrok tunnel at https://scenic-riverbed-unloader.ngrok-free.dev. In development, app/Cognito URLs automatically use that origin; Wahoo settings remain unchanged. Requires ngrok installed and authenticated on this computer; `Ctrl+C` stops all services and the tunnel. See [tunnel setup and behavior](docs/npm-scripts.md#local-development-with-ngrok).

### Workout, Analytics and segment map views

Workout, Analytics and segment maps support an in-place Leaflet 2D / MapLibre 3D terrain
switch with independent server-side renderer preferences per user and view.
See [Workout, Analytics and Segment Map Views](docs/workout-map.md) for data sources, public-service
usage conditions, interaction and verification limits. The flyover modal is unchanged.

### One-time GPS segment best-effort rebuild

The versioned GPS segment best-effort rebuild uses the shared compact matcher and defaults to a
non-destructive dry-run. Apply mode replaces each bounded workout batch transactionally and stores
its checkpoint only after the replacement succeeds. Re-running an interrupted apply resumes from
the last checkpoint. A completed version refuses to run again unless `--rerun-completed` is supplied
deliberately.

```sh
# Development dry-run
npm run migrate:gps-segment-best-efforts -- --batch-size 100

# Development apply
npm run migrate:gps-segment-best-efforts -- --apply --confirm-db cwa24_dev

# Production apply
NODE_ENV=production npm run migrate:gps-segment-best-efforts -- --apply --confirm-db cwa24_prod
```

Use `--limit <count>` for a bounded trial; an applied limited run remains resumable and is not marked
complete. The `--confirm-db` value must exactly match PostgreSQL's `current_database()`. Do not use
`--rerun-completed` unless the completed version is intentionally being repeated from workout ID 0.

## Live Preview

To view a live preview of this application, click [here](https://desolate-coast-53201.herokuapp.com/)

### Body weight history

After migration `088_user_weight_history.sql`, the profile page supports dated body
weight entries, editing and deletion. The profile weight remains an independent
fallback; saving it does not create history entries or recalculate workouts.

The history has its own [Body weight settings facet](docs/user-settings.md) at
`/profile#weight-history`. Saving profile data or preferences through
`PUT /api/profile` now requires a valid `weightKg` greater than 0 and at most
500 kg. Existing NULL profile weights remain readable and are not backfilled;
no database constraint or additional migration is introduced for this requirement.

All endpoints require authentication and operate on the current user's data:

| Method | Endpoint | Description |
| --- | --- | --- |
| GET | `/api/profile/weight-history` | Entries ordered by date, newest first |
| POST | `/api/profile/weight-history` | Create `{ "validFrom": "2026-10-29", "weightKg": 75.5 }` |
| PUT | `/api/profile/weight-history/:id` | Replace an entry's date and weight using the same body |
| DELETE | `/api/profile/weight-history/:id` | Delete an entry (204) |
| GET | `/api/profile/weight?date=2026-10-29` | Resolve weight for a required calendar date |

Responses use `{ "data": ... }`. History entries contain `id` (string),
`validFrom` and `weightKg`. Resolution returns `date`, `weightKg`, `validFrom`,
and `source` (`history`, `profile`, or null). It selects the latest entry whose
date is on or before the requested date, then falls back to the profile weight;
without either, weight and source are null. Dates have no timezone or time of day.
Weights must be greater than 0 and at most 500 kg with at most two decimal places.
Duplicate dates return 409; invalid input returns 400; missing entries return 404.
Accounts pending deletion cannot modify history.

Analytics CP/FTP period metrics additionally show W/kg, using the UTC calendar
date of each CP source workout or underlying FTP estimate (`startTime`). Each
metric resolves its own historical weight, with the profile weight as fallback.
Missing weight produces an empty relative value. The hint exposes weight,
reference date and source; chart axes remain in watts. JSON CP metrics include
`weightKg`, `weightSource`, `weightDate`, and `wattsPerKg`. Relative power uses
the displayed rounded watts. The binary overview uses codec version 5 (three
additional bytes per CP/FTP record); the decoder also accepts version 4.
