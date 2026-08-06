# Logischer Datentransfer

Der Admin-Bereich unter `/admin/accounts` unterstützt drei voneinander getrennte,
portable Exporte. Sie ergänzen das vollständige PostgreSQL-Backup, ersetzen es aber
nicht.

## Empfohlene Reihenfolge

1. Konten als JSON exportieren und im Zielsystem importieren.
2. GPS-Segmente als Segment-ZIP exportieren, prüfen und importieren.
3. Workouts als Workout-ZIP exportieren, prüfen und importieren.

Die Reihenfolge ist wichtig, weil Segmente und Workouts ihre Besitzer zuerst über
`auth_sub` und ersatzweise über die normalisierte E-Mail-Adresse zuordnen. Alte
numerische Benutzer- und Workout-IDs sind nur Archivschlüssel und werden niemals
als stabile IDs im Zielsystem verwendet.

## Workout-Archiv

Das Format `cwa24-admin-workouts`, Version 1, enthält:

- alle persistierten Workout-Metadaten,
- den kompakten Workout-Stream bytegenau mit Codec-Angabe,
- den kompakten GPS-Track bytegenau mit Codec-Angabe,
- persistierte Workout-Segmente,
- Workout-Favoriten, deren Benutzer im Archiv enthalten sind,
- Besitzeranker aus `auth_sub` und E-Mail-Adresse.

Nicht enthalten sind abgeleitete oder operative Daten wie Thumbnails, Similarity
Edges, GPS Best Efforts und Import-Jobs. Workout-Gruppenfreigaben und
Trainingsplan-Zuordnungen sind ebenfalls nicht Bestandteil der ersten Version,
weil dafür zusätzliche stabile Gruppen- und Plananker notwendig sind.

## Sicherer Import

Ein Workout-Archiv wird immer zuerst geprüft. Die Vorschau zeigt pro Besitzer:

- Art der Benutzerzuordnung,
- Anzahl der Workouts,
- neu importierbare Workouts,
- bereits vorhandene Duplikate,
- nicht zuordenbare oder widersprüchliche Besitzer.

Widersprüchliche Besitzer blockieren den Import. Bereits vorhandene Workouts mit
dem gleichen Tupel aus Zielbenutzer und `start_time` werden übersprungen. Der
bestätigte Import läuft in einer Datenbanktransaktion und löscht keine vorhandenen
Daten.

Die Vorschau lädt das große ZIP nicht hoch. Der Browser liest lokal nur Manifest
und Workout-Metadaten und sendet eine kompakte Liste aus Besitzerindex und
Startzeit an das Backend. Nur für seltene Workouts ohne Startzeit wird lokal ein
SHA-256-Fingerprint des Streams gebildet. Erst nach der Bestätigung wird das
vollständige Archiv genau einmal übertragen und serverseitig erneut validiert.

## Formatentwicklung

Die Archivversion und die Codec-Angaben der eingebetteten Streams sind getrennt.
Neue Reader sollen ältere Archivversionen zuerst in das kanonische Workout-Modell
dekodieren und anschließend im jeweils aktuellen Speicherformat persistieren. Ein
altes Archiv wird nicht nachträglich verändert.

Für einen vollständigen Disaster-Recovery-Restore einschließlich Schema, Views,
Sequenzen und sämtlicher Tabellen bleibt der PostgreSQL-Backup-Wizard maßgeblich.
