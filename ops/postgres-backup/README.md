# PostgreSQL Backup und Restore

## Admin-Wizard

Administratoren können unter `/admin/accounts` vollständige PostgreSQL-Backups
auflisten, erstellen, verifizieren und als isolierte Prüfdatenbank restaurieren.
Der Webprozess führt keine PostgreSQL-Werkzeuge aus. Er legt ausschließlich Jobs
in der Redis-Queue `postgres-backup-ops` ab.

Der separate Worker muss neben Anwendung und Import-Worker laufen:

```bash
NODE_ENV=development npm run backup:worker
```

In Production wird `postgres-backup-ops-worker` über `ecosystem.config.cjs` und
`deploy.sh` automatisch mit PM2 gestartet. Der Worker unterstützt nur sechs fest
definierte Operationen:

- `create`: vollständiges Backup mit dem vorhandenen `pg_dump`-S3-Verfahren
- `verify`: SHA-256, Dateigröße und `pg_restore --list` prüfen
- `prepare-restore`: neue Datenbank `<DB_NAME>_restore_<timestamp>` erstellen,
  Backup einspielen und Struktur sowie Kernzähler prüfen
- `activate-restore`: Sicherheitsbackup erstellen, den Production-Pointer atomar
  auf den geprüften Restore setzen und App sowie Import-Worker neu starten
- `rollback`: erneut sichern und den Pointer auf die vorherige Datenbank setzen
- `drop-database`: eine inaktive verwaltete DB sichern und anschließend löschen

`prepare-restore` verändert oder aktiviert niemals die laufende Datenbank. Eine
Aktivierung ist ausschließlich in Production, nach expliziter Bestätigung und
nur bei identischem Git-Commit möglich. Weicht der Commit ab, zeigt der Wizard
`Migration prüfen` an und blockiert den Switch.

Dieses Runbook beschreibt das vollständige, aktuell unterstützte Backup- und
Restore-Verfahren für CWA24. Die Werkzeuge liegen bewusst unter
`ops/postgres-backup` und importieren keinen Anwendungscode. Ein Syntaxfehler
in der Anwendung soll weder das Erstellen noch das Prüfen eines Backups
verhindern.

## Sicherheitsprinzipien

- Ein Backup besteht aus einem PostgreSQL-Dump und einem Manifest in S3.
- `manifest.json` wird zuletzt hochgeladen. Erst dann gilt ein Backup als
  vollständig.
- Ein Restore wird zunächst immer in eine neue, isolierte Datenbank gespielt.
- Ein Restore überschreibt keine bestehende Datenbank und führt keinen
  Key-by-Key-Abgleich durch.
- Die bisherige Datenbank wird weder bei Production-Aktivierung noch Rollback
  gelöscht. Der Pointer merkt sich beide physischen Namen.
- Development verwendet weiterhin die bestehende CLI-Promotion per DB-Rename;
  der Runtime-Pointer wird dort bewusst ignoriert.

## Voraussetzungen

Benötigt werden:

- eine zum PostgreSQL-Server passende Version von `pg_dump`, `pg_restore`,
  `psql`, `createdb` und `dropdb`,
- die AWS CLI mit Zugriff auf den konfigurierten S3-Bucket,
- eine Env-Datei mit Datenbank- und AWS-Konfiguration,
- für das Anlegen einer Restore-DB eine lokal verwendbare PostgreSQL-Rolle mit
  `CREATEDB`- oder Superuser-Berechtigung.

Die normalen DB-Zugangsdaten kommen aus `.env.development`,
`.env.production`, `BACKUP_ENV_FILE` oder einer explizit mit `--env-file`
übergebenen Datei. Shell-Variablen haben Vorrang vor den Werten einer Env-Datei.

Wichtige optionale Variablen:

```env
BACKUP_S3_BUCKET=
BACKUP_S3_PREFIX=backups/postgres
BACKUP_DATABASE_ID=cwa24_prod
BACKUP_ACTIVE_DATABASE_FILE=/etc/cwa24/active-database.env
BACKUP_PG_DUMP_PATH=
BACKUP_PG_RESTORE_PATH=
BACKUP_PSQL_PATH=
BACKUP_CREATEDB_PATH=
BACKUP_DROPDB_PATH=
BACKUP_AWS_CLI_PATH=
BACKUP_DB_ADMIN_USER=
BACKUP_DB_ADMIN_PASSWORD=
BACKUP_DB_ADMIN_USE_SUDO=1
BACKUP_DB_ADMIN_SUDO_USER=postgres
```

Auf dem Dev-Mac werden für PostgreSQL 16 typischerweise diese Pfade verwendet:

```env
BACKUP_PG_DUMP_PATH=/opt/homebrew/opt/postgresql@16/bin/pg_dump
BACKUP_PG_RESTORE_PATH=/opt/homebrew/opt/postgresql@16/bin/pg_restore
BACKUP_PSQL_PATH=/opt/homebrew/opt/postgresql@16/bin/psql
BACKUP_CREATEDB_PATH=/opt/homebrew/opt/postgresql@16/bin/createdb
BACKUP_DROPDB_PATH=/opt/homebrew/opt/postgresql@16/bin/dropdb
```

`pg_dump` darf nicht älter als der PostgreSQL-Server sein. Ein Versionskonflikt
führt beispielsweise zu `server version mismatch` und bricht das Backup ab.

## Inhalt und S3-Struktur

`pg_dump` erzeugt ein PostgreSQL-Custom-Format mit Schema und Daten. Enthalten
sind unter anderem Tabellen, Spalten, Sequenzen, Constraints, Indizes, Views,
Funktionen und Tabelleninhalte. Rollen, Passwörter und die systemweite
PostgreSQL-Konfiguration gehören nicht zum Dump.

Die Objekte werden nach diesem Schema abgelegt:

```text
backups/postgres/<environment>/<logical-database>/YYYY/MM/DD/
  <UTC timestamp>-<backup UUID>/
    database.dump
    manifest.json
```

Das Manifest enthält unter anderem Backup-ID, Zeitpunkt, logische und physische Quell-DB,
PostgreSQL-Version, Dateigröße und SHA-256-Prüfsumme. Der Dump wird mit
`--no-owner --no-privileges` erstellt. Beim Restore gehören die Objekte dem
Restore-User.

## Production-Pointer und Aktivierung

Production trennt den stabilen Backup-Namen vom aktuell verwendeten physischen
Datenbanknamen:

```env
BACKUP_DATABASE_ID=cwa24_prod
BACKUP_ACTIVE_DATABASE_FILE=/etc/cwa24/active-database.env
```

`BACKUP_DATABASE_ID` bleibt dauerhaft `cwa24_prod`. Dadurch landen Backups auch
nach einer Restore-Aktivierung weiterhin im gleichen S3-Katalog. Die Pointer-Datei
wird von `deploy.sh` beim ersten Deployment mit dem konfigurierten `DB_NAME`
angelegt und sieht beispielsweise so aus:

```env
DB_NAME=cwa24_prod_restore_20260805_084512
PREVIOUS_DB_NAME=cwa24_prod
ACTIVATED_AT=2026-08-05T09:00:00.000Z
ACTIVATED_BACKUP_ID=<backup UUID>
```

Das `ecosystem.config.cjs` liest diesen Pointer nur für Production. In Dev bleiben
`.env.development`, ein explizites `DB_NAME` und die vorhandene CLI-Promotion
maßgeblich.

Der Production-Ablauf im Admin-Wizard ist:

1. Backup auswählen und vollständig verifizieren.
2. Restore in eine neue Prüfdatenbank einspielen.
3. Prüfdatenbank funktional bewerten und nur bei `Gleicher Code-Stand` aktivieren.
4. Der Worker prüft, dass der angemeldete Admin auch in der Ziel-DB Admin ist.
5. Der Worker erstellt ein vollständiges Sicherheitsbackup der aktiven DB.
6. Der Pointer wird atomar geschrieben.
7. Import-Worker und Webanwendung werden über PM2 mit dem neuen Pointer gestartet.

Beim Neustart kann die Browser-Session auf den Stand des Backups zurückspringen.
Falls die Admin-Seite nicht automatisch wieder erreichbar ist, neu anmelden und
den dort angezeigten aktiven DB-Namen prüfen. Der Rollback-Bereich verwendet nur
`PREVIOUS_DB_NAME`; ein frei eingegebener Datenbankname wird nicht akzeptiert.

## Dev-Backup erstellen

```bash
NODE_ENV=development npm run backup:create
```

Das Kommando verwendet `.env.development`, erzeugt den Dump zunächst in einem
temporären lokalen Verzeichnis, validiert ihn und lädt anschließend
`database.dump` und `manifest.json` nach S3.

Ein optionales Label kann im Manifest gespeichert werden:

```bash
NODE_ENV=development npm run backup:create -- --label before-local-test
```

## Production-Backup erstellen

Vom lokalen Mac aus:

```bash
npm run backup:prod
```

Der Wrapper verbindet sich per SSH mit `cwa24-ec2`, wechselt nach
`/home/ec2-user/woa` und führt dort aus:

```bash
NODE_ENV=production npm run backup:create
```

Es findet kein Deployment, Git Pull, Neustart oder Datenbankumbau statt. Ein
erfolgreicher Lauf endet lokal mit:

```text
[backup-prod] Production backup completed successfully
```

Direkt auf dem Production-Server kann das Backup ebenfalls gestartet werden:

```bash
cd /home/ec2-user/woa
NODE_ENV=production npm run backup:create
```

## Backup unabhängig verifizieren

Der beim Backup ausgegebene Root-Key wird als `--backup-prefix` verwendet:

```bash
NODE_ENV=development npm run backup:verify -- \
  --backup-prefix backups/postgres/development/cwa24_dev/2026/08/05/<backup-id>
```

Für Production mit einer unabhängigen Recovery-Konfiguration:

```bash
node ops/postgres-backup/verify-backup.mjs \
  --env-file /etc/cwa24/backup.env \
  --backup-prefix backups/postgres/production/cwa24_prod/2026/08/05/<backup-id>
```

Die Prüfung lädt Manifest und Dump herunter, vergleicht Dateigröße und
SHA-256-Prüfsumme und validiert den Archivkatalog mit `pg_restore --list`.
Dabei wird keine Datenbank geschrieben oder angelegt.

## Dev-Restore erstellen

Das neueste vollständige Dev-Backup wird automatisch unter
`backups/postgres/development/<DB_NAME>/` gesucht:

```bash
NODE_ENV=development npm run backup:restore:dev
```

Das Skript führt folgende Schritte aus:

1. Es sucht das neueste `manifest.json` anhand von S3 `LastModified`.
2. Es akzeptiert ausschließlich ein vollständiges Development-Manifest für
   die konfigurierte Dev-Datenbank.
3. Es lädt Dump und Manifest herunter und prüft Größe, SHA-256 und Archivformat.
4. Es ermittelt automatisch eine verwendbare Rolle mit `CREATEDB`- oder
   Superuser-Recht.
5. Es legt eine neue DB nach dem Muster
   `cwa24_dev_restore_YYYYMMDD_HHMMSS` an.
6. Eigentümer der DB bleibt der App-User aus `DB_USER`.
7. Es restauriert atomar mit `--single-transaction --exit-on-error`.
8. Es prüft anschließend zentrale Schema- und Tabellenwerte.

Die vorhandene `cwa24_dev` und `.env.development` werden dabei nicht verändert.

Ein bestimmtes Backup kann explizit ausgewählt werden:

```bash
NODE_ENV=development npm run backup:restore:dev -- \
  --backup-prefix backups/postgres/development/cwa24_dev/2026/08/05/<backup-id>
```

Die Creator-Rolle kann bei Bedarf vorgegeben werden:

```bash
NODE_ENV=development npm run backup:restore:dev -- \
  --admin-user D025449
```

Ohne Vorgabe prüft das Skript nacheinander einen konfigurierten
`BACKUP_DB_ADMIN_USER`, den aktuellen Betriebssystem-User und den App-DB-User.
Die Creator-Rolle wird ausschließlich für `CREATE DATABASE` verwendet. Der
eigentliche Restore läuft mit `DB_USER`.

## Restaurierte Dev-DB testen

Die normale Dev-Anwendung und ihr Worker sollten für einen vollständigen Test
zunächst gestoppt werden. Hauptprozess und Worker müssen mit demselben
Restore-DB-Namen gestartet werden.

Hauptprozess auf Port 3001:

```bash
DB_NAME=cwa24_dev_restore_20260805_072702 \
PORT=3001 \
COGNITO_REDIRECT_URI=http://localhost:3001/auth/callback \
APP_BASE_URL=http://localhost:3001 \
NODE_ENV=development \
npm start
```

Import-Worker in einem zweiten Terminal:

```bash
DB_NAME=cwa24_dev_restore_20260805_072702 \
NODE_ENV=development \
npm run worker
```

Die Callback-URL `http://localhost:3001/auth/callback` muss im Cognito App
Client freigeschaltet sein. Andernfalls leitet Cognito weiterhin zum
konfigurierten Port 3000 um oder lehnt den Callback ab.

Der normale Dev-Worker und der Restore-Worker sollten nicht gleichzeitig
laufen, weil beide dieselben Redis-Queues verwenden können.

Beim Test sollten mindestens geprüft werden:

- Login und Session-Aufbau,
- Workout-Liste, Workout-Details und Diagramme,
- Segmente und Best Efforts,
- Favorites und View Preferences,
- Upload nur dann, wenn bewusst in die Restore-DB geschrieben werden soll,
- zentrale Counts im Vergleich zur Quell- beziehungsweise Backup-Erwartung.

## Getestete Dev-DB promoten

Vor der Promotion müssen Hauptprozess und Worker vollständig gestoppt sein.
Anschließend:

```bash
npm run backup:promote:dev -- \
  --restore-db cwa24_dev_restore_20260805_072702 \
  --confirm cwa24_dev
```

Das Skript akzeptiert nur einen Namen nach dem Muster
`cwa24_dev_restore_YYYYMMDD_HHMMSS`. `--confirm` muss exakt dem `DB_NAME` aus
`.env.development` entsprechen.

Die Promotion führt aus:

```text
cwa24_dev
  -> cwa24_dev_before_restore_<UTC timestamp>

cwa24_dev_restore_<UTC timestamp>
  -> cwa24_dev
```

Verbleibende Sessions werden beendet und neue Verbindungen während des
Namenswechsels kurz blockiert. Es wird keine Datenbank gelöscht. Nach dem Swap
zeigt die unveränderte `.env.development` automatisch auf die restaurierte DB.
Server und Worker können anschließend wieder normal über VS Code gestartet
werden.

## Dev-Rollback

Die Promotion gibt den Namen der vorherigen Datenbank aus. Vor einem Rollback
müssen Server und Worker erneut gestoppt werden. Danach verbindet man sich mit
der Wartungsdatenbank `postgres`:

```bash
/opt/homebrew/opt/postgresql@16/bin/psql \
  --host localhost \
  --port 5432 \
  --username D025449 \
  --dbname postgres
```

Beispiel für den manuellen Rollback:

```sql
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname IN (
  'cwa24_dev',
  'cwa24_dev_before_restore_20260805_073500'
)
AND pid <> pg_backend_pid();

ALTER DATABASE cwa24_dev
  RENAME TO cwa24_dev_failed_restore;

ALTER DATABASE cwa24_dev_before_restore_20260805_073500
  RENAME TO cwa24_dev;
```

Danach `psql` mit `\q` verlassen und die normalen Dev-Prozesse neu starten.
Die konkreten Datenbanknamen müssen durch die Namen aus der Promotion-Ausgabe
ersetzt werden.

## Alte Testdatenbanken aufräumen

Restore-, Rollback- und fehlgeschlagene Testdatenbanken werden bewusst nicht
automatisch gelöscht. Der Admin-Wizard zeigt ausschließlich die logische
Production-Datenbank und die daraus erzeugten `_restore_<timestamp>`-Datenbanken.
Die aktive DB und `PREVIOUS_DB_NAME` sind grundsätzlich geschützt.

Eine inaktive DB kann erst nach Eingabe ihres exakten Namens gelöscht werden.
Der Ops-Worker prüft den Runtime-Pointer unmittelbar vor und nach einem
vollständigen S3-Sicherheitsbackup erneut und führt erst danach `dropdb --force`
aus. Ein frei eingegebener Name außerhalb des verwalteten Namespace wird
serverseitig abgewiesen. In Development bleibt das manuelle Aufräumen bestehen.

## Fehlerfälle

### `server version mismatch`

`pg_dump` ist älter als der PostgreSQL-Server. Die passenden
`BACKUP_PG_*_PATH`-Variablen setzen und den Vorgang erneut starten.

### `permission denied to create database`

Der App-User besitzt bewusst kein `CREATEDB`. Das Restore-Skript versucht
automatisch eine geeignete lokale Rolle zu finden. Falls nötig:

```bash
BACKUP_DB_ADMIN_USER=D025449 \
NODE_ENV=development \
npm run backup:restore:dev
```

Dem App-User sollte nicht dauerhaft `CREATEDB` erteilt werden.
Auf der Production-EC2 verwendet der Ops-Worker stattdessen den explizit
aktivierten lokalen Fallback `sudo -n -u postgres`. Dieser wird nur zum Prüfen
der Creator-Rolle und für `createdb` verwendet; `pg_restore` läuft weiterhin
mit dem eingeschränkten `DB_USER`.

### Kein vollständiges Backup gefunden

Nur Backups mit einem vollständigen und gültigen `manifest.json` werden
berücksichtigt. Bucket, Prefix, Umgebung und Datenbankname prüfen oder einen
konkreten `--backup-prefix` angeben.

### Restore schlägt nach dem Anlegen der DB fehl

Die isolierte Restore-DB bleibt zur Diagnose bestehen. Die aktive Dev-DB wird
nicht verändert. Erst nach Klärung sollte die fehlgeschlagene Test-DB manuell
entfernt werden.

### Promotion schlägt fehl

Das Skript versucht Namen und Verbindungsstatus automatisch zurückzusetzen.
Server und Worker ausgeschaltet lassen und die tatsächlich vorhandenen
Datenbanknamen über eine Verbindung zur `postgres`-DB prüfen, bevor weitere
DDL-Befehle ausgeführt werden.

## Production-Recovery

Production-Restore, Aktivierung und Rollback laufen ausschließlich über den
Admin-Wizard und den dedizierten Ops-Worker. Das Dev-Promotion-Skript darf nie
gegen Production verwendet werden. Die Production-Datenbanken werden nicht
umbenannt; stattdessen schaltet der atomare Runtime-Pointer zwischen den
physischen Namen um.

Bei einem abweichenden Git-Commit bleibt die Aktivierung bewusst gesperrt. Das
Projekt besitzt noch keinen ausreichend sicheren automatischen Forward-Migration-
Pfad für restaurierte ältere Schemata. In diesem Fall muss die Schema-Differenz
vor einem Switch separat beurteilt werden.

## Ersten Admin anlegen

Nachdem sich der vorgesehene Admin mindestens einmal angemeldet hat, kann die
erste Admin-Rolle mit der konfigurierten Standard-E-Mail angelegt werden:

```bash
NODE_ENV=development npm run admin:bootstrap
```

Der Default ist `rainersoltek@cwa24.de` und kann über
`BOOTSTRAP_ADMIN_EMAIL` überschrieben werden. Alternativ kann der stabile
Cognito-Identifier explizit angegeben werden:

```bash
NODE_ENV=development npm run admin:bootstrap -- \
  --auth-sub '<Cognito auth_sub>' \
  --confirm '<Cognito auth_sub>'
```

Alternativ kann eine eindeutige E-Mail-Adresse verwendet werden:

```bash
NODE_ENV=development npm run admin:bootstrap -- \
  --email 'admin@example.com' \
  --confirm 'admin@example.com'
```

Das Kommando sperrt die Rollentabelle während der Prüfung, legt ausschließlich
den ersten Admin an und setzt `granted_by_uid` auf diesen Benutzer selbst. Für
denselben Benutzer ist es idempotent. Sobald ein anderer Admin existiert,
verweigert das Bootstrap-Kommando jede weitere Vergabe. Weitere Admins sollen
später ausschließlich durch einen bestehenden Admin über das Admin-UI
berechtigt werden.

## Unabhängige Production-Installation

Für ein Recovery unabhängig vom jeweils deployten App-Release kann der Ordner
nach `/opt/cwa24-recovery` kopiert werden. Die Konfiguration liegt dann in
`/etc/cwa24/backup.env` mit Dateimodus `0600`.

Direkter, von der Anwendung unabhängiger Aufruf:

```bash
NODE_ENV=production node /opt/cwa24-recovery/create-backup.mjs \
  --env-file /etc/cwa24/backup.env
```

Die Recovery-Tools benötigen weder PM2 noch Redis oder einen laufenden
Webserver.
