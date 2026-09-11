# GPS-Best-Efforts auf Produktion neu berechnen

Das Skript verwendet vorhandene GPS- und Workout-Blobs. Ein erneuter Upload ist
nicht nötig. Es ersetzt nur GPS-Best-Efforts und führt ein Fortschrittsprotokoll.

Nach Push/Pull auf dem Produktionsserver im Projektverzeichnis:

```sh
cd /home/ec2-user/woa
```

## 1. Lesender Probelauf

```sh
NODE_ENV=production npm run migrate:gps-segment-best-efforts -- --confirm-db cwa24_prod_restore_20260805_144216
```

Die Ausgabe muss `database: 'cwa24_prod_restore_20260805_144216'` zeigen.
Das Skript liest `/etc/cwa24/active-database.env` (oder
`BACKUP_ACTIVE_DATABASE_FILE`), bevor der Datenbankpool entsteht. Ein fehlender
Produktionszeiger oder eine abweichende Bestätigung führt zum Abbruch.
`DB_NAME=cwa24_prod` aus `.env.production` überschreibt den aktiven Zeiger nicht.

## 2. Neu berechnen und speichern

```sh
NODE_ENV=production npm run migrate:gps-segment-best-efforts -- --apply --confirm-db cwa24_prod_restore_20260805_144216
```

Standardmäßig werden bis zu 100 Workouts pro Batch verarbeitet. Jeder Batch
ersetzt alte Treffer in einer Transaktion und speichert den Fortschritt.
Nach einer Unterbrechung setzt derselbe Befehl nach dem letzten abgeschlossenen
Batch fort. Ändert sich der aktive Datenbankzeiger, bricht das Skript ab.
Ein bereits abgeschlossener Lauf wird nicht automatisch wiederholt;
`--rerun-completed` startet bei Bedarf ausdrücklich einen vollständigen Neulauf.

## 3. Vollständig nachprüfen

```sh
NODE_ENV=production npm run migrate:gps-segment-best-efforts -- --verify --confirm-db cwa24_prod_restore_20260805_144216
```

Die Prüfung berechnet alle geeigneten Workouts erneut, ohne Ergebnisse zu
schreiben. Erwartet werden `complete: true`, `addedMatchKeys: 0`,
`removedMatchKeys: 0`, `changedRows: 0` und abschließend `verification passed`.
Bei Abweichungen endet der Prozess mit Exitcode 1. Verglichen werden Segment,
Workout, Start-/Endoffset sowie Dauer und Durchschnittswerte. Fünf-Sekunden-
Raster sind kein eigenständiges Prüfkriterium.

Während Migration und Prüfung möglichst keine parallelen Imports oder Änderungen
an Segmenten/Freigaben ausführen, damit beide Läufe denselben Datenbestand sehen.
Die Datenbankbestätigung ist absichtlich konkret: Nach einem späteren Restore
muss der Befehl mit dem dann aktiven Datenbanknamen aktualisiert werden.
