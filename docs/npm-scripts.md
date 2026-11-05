# npm-Skripte

Zentrale Übersicht der Skripte aus [`package.json`](../package.json).
Bei Änderungen an Skripten, Parametern, Voraussetzungen oder Nebenwirkungen diese
Datei und betroffene Detailanleitungen im selben Auftrag aktualisieren.

## Aufruf und Umgebung

Im Repository-Verzeichnis ausführen. `npm start` und `npm test` sind Kurzformen;
alle anderen Skripte werden mit `npm run <name>` gestartet. Argumente für das
Skript folgen hinter `--`, zum Beispiel:

```bash
npm run accounts:export -- --output /tmp/accounts.json
NODE_ENV=development npm run analyze:intensity -- --user 123 --output /tmp/intensity.json
```

Abhängigkeiten müssen installiert sein. Datenbankzugriffe benötigen eine passend
konfigurierte PostgreSQL-Verbindung. Die Anwendung lädt normalerweise
`.env.${NODE_ENV}`, ohne gesetztes `NODE_ENV` also `.env.development`.
Einige Analyse-/Benchmarkskripte verwenden ersatzweise `.env`;
Backup-Werkzeuge unterstützen zusätzlich `--env-file`. Die Zielumgebung bewusst
wählen; `NODE_ENV=production` adressiert die Produktionskonfiguration.
Keine Zugangsdaten in Aufrufen oder Dokumentation hinterlegen.

**Repository-Regel:** Migrations-SQL führt ausschließlich der Benutzer aus, auch
nicht indirekt durch Agenten über Runner oder Deployments. Die folgenden Einträge
dokumentieren die Werkzeuge; sie sind keine Ausführungsfreigabe.

## Anwendung und Betrieb

| Skript | Zweck und Aufruf | Auswirkungen / Voraussetzungen |
| --- | --- | --- |
| `start` | `npm start`: Express-Anwendung starten. | Port aus `PORT`, sonst 3000; startet auch Kontolöschungs- und Importbereinigungs-Scheduler. |
| `start:all` | `npm run start:all`: start the app, import worker, and backup worker together. | Same prerequisites and data changes as the individual services. Logs use `[app]`, `[worker]`, and `[backup]`. In development, sets child-process app/Cognito URLs to localhost using `PORT` (default 3000). Other environment values are inherited. `Ctrl+C`/SIGTERM stops all services; after ten seconds remaining processes are forcibly stopped. Core service failures stop the other processes with an error status. |
| `start:tunnel` | `npm run start:tunnel`: start the app, both workers, and ngrok using the fixed public URL. | Same service prerequisites and data changes as `start:all`, plus public access to the local app. Requires an installed, authenticated ngrok agent. Uses the app's `PORT` (default 3000); waits for local HTTP readiness. Tunnel failures leave local services running. `Ctrl+C` stops all processes. [Setup and details](#local-development-with-ngrok). |
| `worker` | `npm run worker`: Import-Worker starten. | Verarbeitet Import-Jobs und den dauerhaften Wahoo-Webhook-Eingang; schreibt Trainings und Folgeaufträge. Benötigt die konfigurierte Datenbank und Queue-Infrastruktur, für Wahoo zusätzlich Migration 092 und die [Wahoo-Konfiguration](WAHOO_CONNECT.md#webhooks-und-automatischer-import). |
| `backup:worker` | `npm run backup:worker`: Backup-/Restore-Worker für den Admin-Wizard. | Führt eingereihte Betriebsaufträge aus. [Betriebsanleitung](../ops/postgres-backup/README.md). |
| `deploy:prod` | `npm run deploy:prod -- "Commit-Nachricht"` | Führt `npm test` und `npm run check` aus, nimmt **alle Repository-Änderungen** mit `git add --all` auf, erstellt Commit und Push und ruft per SSH `./deploy.sh code-only` auf. Erwartet den Release-Branch, standardmäßig `main`. |
| `env:prod` | `npm run env:prod`: open `~/woa/.env.production` on `cwa24-ec2` directly in Nano over SSH. | Requires a local interactive terminal, working SSH access to the `cwa24-ec2` alias, and Nano plus file access on the server. Saving changes the production environment file; no automatic restart or deployment. [Editing details](#edit-the-production-environment). |
| `maps:plan` | `npm run maps:plan -- --env-file .env.production [--json]`: inventory required Shortbread regions from stored workout GPS boxes. | Explicit environment file, database read access, Node with `node:sqlite`, outbound Geofabrik metadata/HEAD access. Read-only transaction; reads existing map files, creates none, downloads no archives. Exit 2 for incomplete plans. [Production workflow](workout-map.md#production-planning-and-preparation-over-ssh). |
| `maps:prepare` | `npm run maps:prepare -- --env-file .env.production [--json]`: recompute the plan, download missing/invalid archives and verify actual viewport tiles. | Same read-only database access; writes only to configured `WOA_MAP_DATA_DIR` with an exclusive lock, checked `.part` downloads and atomic replacement. Needs download space plus 5%/256 MiB margin. Reuses valid archives; no DB writes, migrations, rasterization, service restart or env changes. Exit 2 for incomplete coverage; 1 for operational errors. [Production workflow](workout-map.md#production-planning-and-preparation-over-ssh). |
| `account-deletion:sweep` | `npm run account-deletion:sweep` | Führt einen Batch fälliger endgültiger Kontolöschungen aus; kein Vorschau-Modus. |

The map commands resolve the active production database through the same pointer
resolver as PM2. `.env.production` implies production mode unless its `NODE_ENV`
explicitly overrides it; custom production filenames need `NODE_ENV=production`.
Failures include a safe `stage`/allowlisted `code`, not raw connection details.
Internal `node --` argument separation prevents Node from consuming `--env-file`;
the documented npm command remains unchanged. See the production workflow above.

`deploy:prod` unterstützt `GIT_REMOTE`, `RELEASE_BRANCH`, `DEPLOY_SSH_TARGET`
und `DEPLOY_APP_DIR`. `SKIP_RELEASE_CHECKS=1` überspringt Tests und Checks.
Die Typprüfung gehört nicht zum Release-Check. Implementierung: [`release-prod.sh`](../release-prod.sh).

Production deployment installs dependencies with `npm ci --omit=dev`. Whenever
dependencies change, update and commit both `package.json` and `package-lock.json`;
otherwise installation fails even after the code has already been pulled.
For a lockfile-only repair, run `npm install --package-lock-only --ignore-scripts`,
review the diff, then check `npm ci --dry-run --ignore-scripts --omit=dev` locally.
A dry-run checks dependency resolution, not native binaries or runtime behavior.

## Local Thumbnail Map Development

For `npm run start:all` with the local BW/Hessen thumbnail renderer, use the
environment settings and data prerequisites in
[Local On-Demand Route Thumbnails](workout-map.md#local-on-demand-route-thumbnails).
Keep `PORT=3000` for the currently registered local Cognito callback and stop any
existing Dev start first. App and workers inherit these settings; no automatic
archive download, migration or production configuration change is performed.

## Edit the Production Environment

Run from the local repository in an interactive terminal:

```bash
npm run env:prod
```

This runs `ssh -t cwa24-ec2 'nano ~/woa/.env.production'`. SSH allocates an
interactive terminal and opens the file directly on the server; no local copy is
created. The target and path are fixed and do not use the deployment overrides.
Existing SSH authentication and host-key checks still apply.

In Nano, press `Ctrl+O`, then `Enter` to save, and `Ctrl+X` to exit. To discard
unsaved changes, press `Ctrl+X`, then `N` when prompted. Closing Nano ends the SSH
session automatically. Environment changes require a separate restart of the
affected running application or workers to take effect; this command does not
restart services, deploy code, or run migrations. Never paste environment values
into logs, documentation, Git, or chat.

## Translation Changes During Development

When `NODE_ENV` is unset or `development`, the app checks locale JSON file
metadata in `src/public/i18n/` on each request. Unchanged bundles are not read or
parsed again. After editing translations, refresh the browser page; no backend
restart is needed. Added and removed locales are discovered as well.

Changed bundles are loaded as one snapshot. If reading or parsing fails, the
last valid snapshot remains active and a sanitized warning is logged once until
recovery. Fix the file and refresh to retry. Invalid files at startup still fail
because no valid snapshot exists yet. Open pages do not update automatically.

Production and other explicitly named environments keep their startup cache
without per-request filesystem checks. This behavior applies to `npm start`,
`start:all`, and `start:tunnel`; no new script, dependency, or watcher is required.
Restart the backend once to activate this code change. Later translation edits
only require a page refresh in development; backend JavaScript changes still
require a restart. No running service is restarted automatically by this feature.

## Local Development With ngrok

Use `npm run start:tunnel` instead of `npm run start:all` when the local app needs
to receive external requests, for example development webhooks. This publishes
the app at https://scenic-riverbed-unloader.ngrok-free.dev. In development it
automatically selects this origin for `APP_BASE_URL` and `COGNITO_REDIRECT_URI`.
It does not add access restrictions or change Wahoo configuration, webhook
registrations, or identity-provider settings.

- Install the ngrok agent once per computer (`brew install ngrok` on macOS).
- Authenticate it yourself using `ngrok config add-authtoken <TOKEN>`. Obtain the
	token from the ngrok dashboard; never put it in Git, documentation, or chat.
- Stop any separately running app/workers before using this combined command.
	Stop an existing tunnel using the same domain, including one on another
	computer. Only one non-pooled endpoint can use this URL at a time.
- Both starters load `.env.${NODE_ENV}` (development by default), preserving
	already exported variables except for the development URL overrides below.
	The tunnel uses the same `PORT` as the app, defaulting to 3000. No environment
	file is modified.
- When `NODE_ENV` is unset or `development`, `start:all` passes
	`APP_BASE_URL=http://localhost:<PORT>` and
	`COGNITO_REDIRECT_URI=http://localhost:<PORT>/auth/callback` to the child
	processes. `start:tunnel` uses the ngrok origin for those two values instead.
	This overrides old URL values from the environment file or shell for this run
	only. Other environments, including production, retain their configured URLs.
- Allow both callback URLs on the Cognito app client: the localhost callback
	for local mode and `https://scenic-riverbed-unloader.ngrok-free.dev/auth/callback`
	for tunnel mode. Google federates through Cognito; its redirect normally stays
	on the Cognito domain at `/oauth2/idpresponse`.
- Begin browser login on the origin selected by the starter and stay there.
	localhost and ngrok have separate browser sessions. Wahoo variables remain
	unchanged in both modes; with the configured ngrok Wahoo callback, start Wahoo
	connection flows through the ngrok origin, not localhost. See
	[Wahoo development login](WAHOO_CONNECT.md#local-development-with-ngrok).
- ngrok starts after the local app responds with HTTP status below 500. The
	readiness check retries for up to 30 seconds; redirects count as ready.
	Readiness failure skips ngrok, while local services continue running.
- Logs use `[ngrok]`. Missing installation, authentication errors, or URL conflicts
	do not stop the local services. Fix the issue and restart the combined command.
- `Ctrl+C` or SIGTERM stops the services, any pending readiness check, and ngrok;
	processes still running after ten seconds are forcibly stopped. Core service
	failures stop the other processes as with `start:all`.
- Inspect requests at http://127.0.0.1:4040 while the tunnel is running. The app
	and ngrok must both stay running for the public URL to work.

`npm run start:all` does not start a public tunnel. Switching modes requires
stopping the current combined starter and running the other command. `npm start`
and the individual worker commands continue to use their configured environment
without these automatic URL overrides.

## Konten übertragen und Admin einrichten

| Skript | Parameter und Beispiel | Auswirkungen |
| --- | --- | --- |
| `accounts:export` | `npm run accounts:export -- --output /tmp/accounts.json`; `--output` optional, sonst zeitbasierter Dateiname. | Liest Kontendaten und schreibt JSON mit Dateimodus `0600`; vorhandene Zieldatei kann überschrieben werden. Enthält personenbezogene Daten. |
| `accounts:import` | `npm run accounts:import -- --file /tmp/accounts.json`; `--file` erforderlich. | Validiert und importiert in einer Transaktion. Legt Konten an und aktualisiert bestehende Konten anhand `auth_sub` sowie zugehörige Profile, Ansichten, Zahlungen, Mitgliedschaften und Rollen. Benötigte Tarifcodes müssen bereits existieren. **Kein Dry-Run und keine zusätzliche Bestätigung.** |
| `admin:bootstrap` | `npm run admin:bootstrap -- --email <email> --confirm <email>` oder `--auth-sub <sub> --confirm <sub>`; `--help` vorhanden. | Vergibt Admin-Rechte für ein vorhandenes Konto. Ohne Argumente wird das im Skript festgelegte Standardkonto verwendet. [Details](../ops/postgres-backup/README.md#ersten-admin-anlegen). |

Konten-JSON ersetzt kein vollständiges Datenbankbackup. Siehe auch
[logischer Datentransfer](logical-data-transfer.md).

## PostgreSQL-Backup und Restore

Für Voraussetzungen (PostgreSQL-Tools, AWS CLI, S3-/DB-Rechte), Konfiguration und
den vollständigen Ablauf gilt die [Backup-/Restore-Anleitung](../ops/postgres-backup/README.md).

| Skript | Parameter / Aufruf | Auswirkungen |
| --- | --- | --- |
| `backup:create` | `npm run backup:create -- --label before-change`; optional `--env-file`, `--source-db`, `--result-file`, `--help`. | Erstellt Dump und Manifest und lädt sie nach S3. `--source-db` ist für interne verwaltete Datenbanken gedacht. |
| `backup:prod` | `npm run backup:prod`; `--help` vorhanden. | Startet per SSH auf dem Produktionsserver `NODE_ENV=production npm run backup:create`. Ziel über `BACKUP_SSH_TARGET` und `BACKUP_APP_DIR` konfigurierbar. |
| `backup:verify` | `npm run backup:verify -- --backup-prefix <S3-Prefix>`; optional `--env-file`, `--result-file`, `--help`. | Lädt das Backup temporär herunter und prüft Manifest, SHA-256, Größe und Archivverzeichnis. Kein Restore und kein Nachweis der fachlichen Vollständigkeit. |
| `backup:restore:dev` | `NODE_ENV=development npm run backup:restore:dev`; optional `--backup-prefix`, `--env-file`, `--admin-user`, `--help`. | Restauriert das neueste passende Dev-Backup oder das gewählte Backup in eine neue isolierte Datenbank. Ändert die bisherige Dev-DB und ihre Env-Datei nicht. |
| `backup:promote:dev` | `npm run backup:promote:dev -- --restore-db <DB_restore_YYYYMMDD_HHMMSS> --confirm <aktive-Dev-DB>` | Erzwingt Development-Modus, benennt Datenbanken um und beendet verbleibende Sessions. Anwendung und Worker vorher stoppen. Bisherige DB bleibt unter Sicherungsnamen erhalten. [Details](../ops/postgres-backup/README.md#getestete-dev-db-promoten). |

## Schema und Daten neu aufbauen

| Skript | Parameter / Aufruf | Auswirkungen |
| --- | --- | --- |
| `migrate` | `npm run migrate` | Führt den SQL-Migrationsrunner aus und verändert das Schema bzw. Daten. Ausschließlich vom Benutzer ausführen. |
| `db:rebuild` | `npm run db:rebuild -- --confirm <DB_NAME>`; alternativ `DB_REBUILD_CONFIRM`. | **Löscht das komplette `public`-Schema und PostGIS-Erweiterungen mit `CASCADE`**, baut das Schema über Migrationen neu auf. Kein Dry-Run. [Anleitung](STANDARD_POSTGRES_DATABASE_REBUILD.md). |
| `migrate:workout-streams:absolute` | `npm run migrate:workout-streams:absolute -- --limit 10`; optional `--user <id>`, `--batch-size <n>` (Standard 200). | Standard Dry-Run. **`--commit` schreibt** die neu kodierten Workout-Streams. Ohne Filter/Limit werden alle passenden Workouts verarbeitet. |
| `migrate:gps-segment-best-efforts` | `npm run migrate:gps-segment-best-efforts -- --batch-size 100` | Standard Dry-Run; `--apply --confirm-db <DB>` ersetzt Ergebnisse batchweise und speichert Checkpoints. `--limit`, `--rerun-completed`, `--help`; `--verify` vergleicht vollständig lesend und darf nicht mit `--apply` oder `--limit` kombiniert werden. [Anleitung](gps-segment-best-efforts-rebuild.md). |
| `migrate:gps-segment-elevation-profiles` | `npm run migrate:gps-segment-elevation-profiles -- --limit 10` | Standard lesender Dry-Run; `--apply --confirm-db <DB>` persistiert Höhenprofile und Checkpoints. Weitere Optionen: `--batch-size`, `--rerun-completed`, `--help`. |

Bei den GPS-Rebuilds muss `--confirm-db` exakt `current_database()` entsprechen.
`--rerun-completed` ist nur zusammen mit `--apply` für eine bewusste Wiederholung
zulässig. Begrenzte Apply-Läufe bleiben fortsetzbar.

## Analyse, Benchmarks und Archive

Die lesenden DB-Benchmarks benötigen vorhandene Workouts bzw. GPS-Segmente.
Sie können CPU, Speicher und Datenbank erheblich beanspruchen.

| Skript | Parameter / Beispiel | Ergebnis und Nebenwirkungen |
| --- | --- | --- |
| `bench:persistence` | `npm run bench:persistence -- --limit 10`; optional `--user <id>`. | Vergleicht Kodierung/Kompression absoluter und kumulativer Workout-Daten; liest DB, berechnet im Speicher. |
| `bench:woa-harmonized-persistence` | `npm run bench:woa-harmonized-persistence -- --workout <id>`; optional `--gzip-level <0–9>`. | Vergleicht aktuelle Speichergrößen mit hypothetischen harmonisierten Workout-/GPS-Blöcken; keine Persistierung. |
| `bench:segment-recompute` | `npm run bench:segment-recompute -- --limit 10`; optional `--user <id>`, `--workout <id>`. | Misst Lesen, Dekompression und lokale CP-Segmenterkennung, ohne Ergebnisse zu speichern. |
| `bench:segment-match-only` | `npm run bench:segment-match-only -- --segments 74,81`; optional `--repeats <n>` (3), `--limit <n>` (100), `--metrics`. | Misst Matching für vorhandene GPS-Segmente; keine Speicherung der Matching-Ergebnisse. |
| `analyze:intensity` | `npm run analyze:intensity -- --user <id>`; optional `--output <report.json>`, `--window-days <n>` (365, mindestens 30). | Analysiert Workout-Intensität; liest DB, schreibt bei `--output` eine JSON-Datei. |
| `bench:fflate-zip` | `npm run bench:fflate-zip -- --file <archive.zip>`; weitere Optionen unten. | Vergleicht Archiv-/Kompressionsverarbeitung lokal; `--write-output <path>` schreibt ein Ergebnisarchiv. |
| `db:explain-workout-insert` | `npm run db:explain-workout-insert -- --workout <id>`; optional `--user <id>`, `--limit <n>` (1), `--variant <full\|no-geom\|tiny-stream>`, `--repetitions <n>` (1). | Führt echte Inserts mit `EXPLAIN ANALYZE` in zurückgerollten Transaktionen aus. **Kein rein lesender Vorgang**; Sequenzen können trotz Rollback fortschreiten. |
| `fit:deduplicate` | `npm run fit:deduplicate -- --dry-run <a.zip> <b.zip>`; `--output <path>` optional. | Erstellt ohne `--dry-run` ein dedupliziertes FIT-ZIP. Ohne Eingabepfade verwendet es die im Skript hinterlegten Archive unter `import/`; Standardziel `import/AllFitFiles-deduplicated.zip`. Keine DB-Änderung. |

`bench:fflate-zip` unterstützt außerdem `--repeats`, `--gzip-level` (0–9),
`--brotli-quality` (0–11), `--inner-compression`, `--outer-compression`,
`--distance-block-size`, `--gps-block-size` und `--gps-sample-rate`.
`--variant` wird nur noch aus Kompatibilitätsgründen eingelesen und ignoriert.
Implementierung und Standardwerte: [`benchmark-fflate-zip.js`](../src/scripts/benchmark-fflate-zip.js).

## Entwicklung und Prüfungen

| Skript | Zweck / Auswirkungen |
| --- | --- |
| `hooks:install` | Setzt lokal `core.hooksPath` auf `.githooks` und macht den Pre-Push-Hook ausführbar. Ändert die lokale Git-Konfiguration. |
| `check:syntax` | `node --check` für alle `.js`-Dateien unter `src`; benötigt `rg` und `xargs`. |
| `check:lint` | ESLint für `src`, ohne automatische Korrekturen. |
| `check:types` | TypeScript-Prüfung mit `tsconfig.checkjs.json`, ohne Ausgabedateien. |
| `check` | Führt `check:syntax` und anschließend `check:lint` aus; enthält weder Tests noch Typprüfung. |
| `test` | `npm test`: Node-Test-Runner für `tests/*.test.js`. |

Für die Entwicklungsprüfungen müssen auch die Dev-Abhängigkeiten installiert sein.
Die Existenz eines Prüfbefehls sagt nichts über seinen aktuellen Erfolgsstatus aus.
