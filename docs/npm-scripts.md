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
| `start:all` | `npm run start:all`: Anwendung, Import-Worker und Backup-Worker gemeinsam starten. | Drei eigene Node-Prozesse, Logs mit `[app]`, `[worker]`, `[backup]` in einer Konsole. Umgebung wird vererbt. `Strg+C`/SIGTERM beendet alle; nach zehn Sekunden werden verbleibende Prozesse erzwungen beendet. Endet ein Prozess unerwartet, werden die übrigen gestoppt und der Gesamtaufruf meldet einen Fehler. Gleiche Voraussetzungen und Datenänderungen wie bei den drei Einzelbefehlen. |
| `worker` | `npm run worker`: Import-Worker starten. | Verarbeitet Import-Jobs und schreibt Daten; benötigt die konfigurierte Datenbank und Queue-Infrastruktur. |
| `backup:worker` | `npm run backup:worker`: Backup-/Restore-Worker für den Admin-Wizard. | Führt eingereihte Betriebsaufträge aus. [Betriebsanleitung](../ops/postgres-backup/README.md). |
| `deploy:prod` | `npm run deploy:prod -- "Commit-Nachricht"` | Führt `npm test` und `npm run check` aus, nimmt **alle Repository-Änderungen** mit `git add --all` auf, erstellt Commit und Push und ruft per SSH `./deploy.sh code-only` auf. Erwartet den Release-Branch, standardmäßig `main`. |
| `account-deletion:sweep` | `npm run account-deletion:sweep` | Führt einen Batch fälliger endgültiger Kontolöschungen aus; kein Vorschau-Modus. |

`deploy:prod` unterstützt `GIT_REMOTE`, `RELEASE_BRANCH`, `DEPLOY_SSH_TARGET`
und `DEPLOY_APP_DIR`. `SKIP_RELEASE_CHECKS=1` überspringt Tests und Checks.
Die Typprüfung gehört nicht zum Release-Check. Implementierung: [`release-prod.sh`](../release-prod.sh).

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
