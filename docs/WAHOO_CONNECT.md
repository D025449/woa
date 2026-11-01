# Wahoo verbinden

Stand: 2026-11-01. Implementiert sind OAuth-Verbindung mit verschlüsselter
Token-Verwaltung, lokales Trennen im Profil und manueller Workout-Import..

## Einrichtung

1. In [Wahoos Developer Portal](https://developers.wahooligan.com/applications)
   eine **Confidential**-Anwendung für den serverseitigen OAuth-Code-Flow einrichten.
   Sandbox und Produktion sind getrennte Anwendungen - Freigaben bei Wahoo beachten.
2. Als Redirect URI exakt `https://<WOA-Domain>/auth/wahoo/callback` registrieren.
   Der Browser muss WOA unter derselben Origin benutzen. Für lokale Entwicklung
   ist außerhalb von Produktion auch HTTP auf `localhost`/`127.0.0.1` zulässig,
   sofern die entsprechende URI bei Wahoo registriert werden kann.
3. Serverseitig setzen (keine Werte ins Repository eintragen):
   - `WAHOO_CLIENT_ID`
   - `WAHOO_CLIENT_SECRET`
   - `WAHOO_REDIRECT_URI` (vollständige registrierte URI)
   - `WAHOO_TOKEN_ENCRYPTION_KEY` (eigener zufälliger 32-Byte-Schlüssel als 64 Hexzeichen)
4. **Migration `src/migrations/090_user_wahoo_connections.sql` manuell ausführen.**
   Der Agent hat die Migration nur vorbereitet und nicht ausgeführt.
5. App mit diesen Variablen neu starten. Im Profil „Mit Wahoo verbinden“ auswählen,
   bei Wahoo anmelden und den Zugriff bestätigen. Danach zeigt WOA den Status an.

Client-Secret und Verschlüsselungsschlüssel gehören ausschließlich auf den Server.
Den Verschlüsselungsschlüssel getrennt von der Datenbank für Wiederherstellungen
sichern. Austausch ohne Umschlüsselung macht bestehende Tokens unlesbar.
Keine zusätzlichen npm-Skripte oder Abhängigkeiten erforderlich.

## Ablauf und Schnittstellen

### Wahoo-Benutzer-ID als Vorbereitung für Webhooks

Migration `src/migrations/092_wahoo_webhook_import.sql` ergänzt die zunächst
abgeschaltete Importoption, das Kennzeichen für die Offline-Freigabe und den
dauerhaften Auftragseingang. Der Benutzer bestätigt die manuelle Ausführung;
vom Agenten weder ausgeführt noch gegen die Datenbank geprüft.

`src/migrations/091_wahoo_user_id.sql` nach Migration 090 manuell ausführen.
Sie ergänzt die nullable Spalte `wahoo_user_id` (positive BIGINT, eindeutig über
alle Verbindungen). Der Benutzer hat die manuelle Ausführung am 2026-11-01
bestätigt; vom Agenten weder ausgeführt noch gegen die Datenbank geprüft.

Beim Verbinden wird nach dem Token-Austausch `/v1/user` abgerufen und dessen ID
zusammen mit den Tokens gespeichert. Bei bestehenden Verbindungen mit `NULL`
wird das Profil beim nächsten Wahoo-API-Abruf (z. B. Laden der Trainingsliste)
einmal zusätzlich abgerufen und die ID nachgetragen. Erneutes Verbinden ist
allein dafür nicht erforderlich; das bloße Öffnen des WOA-Profils genügt nicht.
Es werden keine weiteren Wahoo-Profildaten gespeichert. Ungültige IDs,
Profilabruf-Fehler und bereits einem anderen WOA-Konto zugeordnete IDs führen
zu einer bereinigten Fehlermeldung. Bestehende Verbindungen werden beim
fehlgeschlagenen Neuverbinden nicht überschrieben. Beim Nachtragen verhindert
ein Vergleich der verschlüsselten Tokens das Überschreiben einer inzwischen
geänderten Verbindung; gegebenenfalls den Abruf wiederholen. Bereits rotierte
Tokens bleiben auch bei anschließendem Fehler gespeichert.
Automatischer Import und Einrichtung sind im Abschnitt „Webhooks“ beschrieben.

- `GET /auth/wahoo/status`: angemeldet, liefert nur `configured`, `available` und
  `updatedAt`, `autoImportEnabled`, `offlineDataGranted`, `webhookAvailable` in `data`. `configured` bedeutet gespeicherte Verbindung, keine
  Live-Prüfung der Wahoo-Freigabe. `available` prüft die Server-Konfiguration.
- `POST /auth/wahoo/start`: aktives Konto und passende explizite `Origin` erforderlich.
  Erzeugt zufälligen State, bindet ihn an Sitzung/Benutzer (zehn Minuten gültig),
  speichert die Sitzung vor Antwort und liefert die feste Wahoo-Autorisierungs-URL.
- `GET /auth/wahoo/callback`: angemeldetes aktives Konto und passender State nötig.
  State wird vor dem Token-Austausch aus der Sitzung entfernt und gespeichert.
  Code-Austausch erfolgt ausschließlich serverseitig per JSON-POST an Wahoo.
  Danach feste Weiterleitung auf `/profile?wahoo=connected|denied|error#wahoo-settings`.
  Codes, Tokens und Wahoo-Fehlertexte werden nicht weitergereicht oder protokolliert.
- `DELETE /auth/wahoo/connection`: aktives Konto und passende `Origin` erforderlich;
  löscht lokal die Tokens und einen laufenden Verbindungsversuch dieser Sitzung.
  HTTP 204 bei Erfolg. **Die Wahoo-Freigabe wird dadurch nicht remote widerrufen.**
  Diese kann zusätzlich in den Wahoo-Kontoeinstellungen widerrufen werden.

Alle Endpunkte setzen `Cache-Control: no-store` und `Referrer-Policy: no-referrer`.
Es werden `user_read workouts_read offline_data` angefordert. Bereits verbundene Konten mit
reinem Profilzugriff müssen im Profil getrennt und erneut verbunden werden.
Falls nötig, auch die erlaubten Scopes im Wahoo Developer Portal erweitern.
Manuelle Importe bleiben verfügbar; automatische Importe benötigen die unten beschriebene Einrichtung.
Reverse-Proxy-/Access-Logs sollten OAuth-Queryparameter grundsätzlich ausblenden.

## Token-Verwaltung

Access- und Refresh-Token samt Ablaufzeit liegen gemeinsam als versionierte
AES-256-GCM-Hülle in `user_wahoo_connections`, mit frischer IV und Benutzer-ID
als authentifizierten Zusatzdaten. Statusantworten enthalten keine Tokens.
Bei endgültiger Kontolöschung wird die Verbindung entfernt. Profil- und
Account-Exporte enthalten keine Wahoo-Tokens.

Der interne Service `readUser(userId)` liest `/v1/user`. Nur unmittelbar davor
werden bald ablaufende Tokens erneuert; Datenbank-Zeilensperren serialisieren
Erneuerungen über mehrere Prozesse. Rotierte Tokens werden vor dem API-Aufruf
persistiert, damit ein temporärer API-Fehler sie nicht verwirft. Kein Timer und
keine Erneuerung beim bloßen Laden des Profils. Der Service ist derzeit noch
kein eigener öffentlicher API-Endpunkt. Bei widerrufenen/ungültigen Tokens ist
Trennen und erneutes Verbinden erforderlich; kein automatischer 401-Retry.

Feste Wahoo-Endpunkte, keine HTTP-Redirects und 15 Sekunden Zeitlimit je API-Anfrage.
Antwortlimits: 64 KiB beim Token-Austausch, 1 MiB bei authentifizierten API-Abrufen. Fehlerantworten werden verworfen. Nach Wahoos Vorgabe löst
erst ein erfolgreicher API-Aufruf mit erneuertem Token die Ablösung vorheriger
Tokens aus; deshalb keine vorsorglichen Erneuerungen ohne API-Bedarf.

Grundlage: [offizielle Wahoo-API-Referenz](https://cloud-api.wahooligan.com/),
am 2026-11-01 erneut geprüft (OAuth, Scopes, Token-Limits und Deauthorization).

## Workouts importieren

Unter „Training hinzufügen“ → „Von Wahoo importieren“ öffnet sich
`/files/wahooImport`. Ohne gespeicherte Verbindung führt ein Link zum Profil.
Nach dem Laden können Workouts ausgewählt und ältere mit „Weitere 20 laden“
nachgeladen werden. Auswahl und Einzelstatus bleiben beim Nachladen erhalten.
Die Seite während des Imports geöffnet lassen.

- `GET /api/wahoo/activities?start=0`: neueste 20 Workouts; `start` ist ein
  nichtnegatives Vielfaches von 20 und wird auf Wahoos `page`/`per_page` abgebildet.
  Liefert nur ID, Name, Startzeit und Dauer (sowie derzeit leeres `sport`).
- `GET /api/wahoo/activities/:id/file`: lädt die Workout-Zusammenfassung des
  angemeldeten Benutzers und deren FIT-Datei. OAuth-Tokens und Download-URLs
  werden nicht an den Browser weitergegeben. Beide Endpunkte benötigen ein
  angemeldetes aktives Konto und erlauben keinen HTTP-Cache.
- Downloads nur per HTTPS von `cdn.wahooligan.com`, ohne Zugangsdaten oder
  Redirects, mit 60 Sekunden Zeitlimit und maximal 50 MiB. Andere Hosts werden
  abgewiesen; tatsächliche Wahoo-Downloadhosts sind im Live-Test zu bestätigen.
  FIT-Header werden vor der Übergabe geprüft. Workouts ohne verfügbare FIT-Datei
  erhalten einen Einzelstatus; die restliche Auswahl läuft weiter.
- FIT-Verarbeitung und Speicherung nutzen den bestehenden Browser-Worker und
  Importweg mit Duplikatprüfung, Importfiltern und optionalem Überschreiben.
  Eine volle Seite bietet weiteres Nachladen an; gegebenenfalls bestätigt erst
  eine zusätzliche leere Seite das Listenende.

Für den Import selbst keine weitere Migration erforderlich; die oben beschriebene
ID-Persistierung setzt Migration 091 voraus. Keine neue Abhängigkeit oder neues npm-Skript.

## Prüfungen und noch offene Live-Prüfung

Automatisierte Importtests stehen in `tests/wahoo-import.test.js`,
`tests/wahoo-import-ui.test.js` und `tests/import-pages.test.js`.
Verbindungstests stehen in `tests/wahoo-callback.test.js` und
`tests/wahoo-connection.test.js`; `tests/wahoo-profile.test.js` prüft das Rendering
in allen sechs Sprachen. Die Service-/Routentests verwenden simulierte Wahoo-Antworten und
Datenbankzugriffe; HTTP-Routentests verwenden ausschließlich einen lokalen Testserver.

Der Benutzer hat am 2026-10-31 nach Einrichtung den erfolgreichen Live-Test des
Verbindungsablaufs (Anmeldung/Freigabe/Callback) bestätigt. Die Testumgebung
(lokal oder Produktion) wurde nicht ausdrücklich benannt; kein separater
Live-Test durch den Agenten.

Noch offen: Trennen und erneutes Verbinden sowie automatische Token-Erneuerung
gegen Wahoo und PostgreSQL. Eine visuelle Browserprüfung, ein Deployment und
die Migration wurden vom Agenten nicht durchgeführt. Tatsächlich gewährter
Scope und konkretes Token-Antwortformat wurden nicht separat geprüft.

Am 2026-11-01 bestätigt der Benutzer den vollständigen automatischen Live-Import:
Webhook empfangen und zugeordnet, Verarbeitung nach zunächst fehlgeschlagenem
Versuch später `completed`, ungefähr sechsminütiges Training in WOA sichtbar.
Damit ist der automatische Ablauf einschließlich Wiederholung für diesen Test
bestätigt. Kein separater Live-Test durch den Agenten; Testumgebung (lokal oder
Produktion), konkrete Freigabeantwort und Downloadhost wurden nicht separat geprüft.
Der manuelle Workout-Import ist dadurch nicht separat live bestätigt.

Ein vorheriger Test mit ungefähr 3,5 Minuten erhielt `skipped`. Die Mindestlänge
von 300 Datensätzen ist eine plausible Ursache, aber der konkrete Überspringgrund
wird derzeit nicht gespeichert. Auch die Ursache des ersten fehlgeschlagenen
Versuchs beim längeren Training bleibt offen: Eine noch nicht verfügbare FIT-Datei
ist eine Vermutung, kein nachgewiesener Wahoo-Fehler.

## Webhooks und automatischer Import

### Einrichtung

1. Migrationen 090–092 müssen manuell ausgeführt sein.
2. Im Wahoo Developer Portal für die Anwendung zusätzlich `offline_data` erlauben.
3. Auf dem WOA-Webserver `WAHOO_WEBHOOK_TOKEN` als eigenes zufälliges Geheimnis
   mit 32–512 Zeichen setzen, beispielsweise 32 zufällige Bytes als 64 Hexzeichen.
   Keinen Wert ins Repository oder in Logs schreiben.
4. Bei Wahoo Webhooks aktivieren (`webhook_enabled`),
   `webhook_url = https://<WOA-Domain>/webhooks/wahoo` und denselben Wert als
   `webhook_token` hinterlegen. Sandbox und Produktion getrennt konfigurieren.
   Die Adresse muss von Wahoo öffentlich per HTTPS erreichbar sein.
5. Anwendung und bestehenden Import-Worker neu starten (`npm run worker` oder
   `npm run start:all`). Der Worker benötigt dieselben Datenbank-/Wahoo-Variablen
   wie die Anwendung sowie die bestehende Redis-Infrastruktur für Folgeaufträge.
6. Im Profil bei bestehenden Verbindungen „Wahoo-Freigabe erweitern“ anklicken,
   bei Wahoo zustimmen und anschließend „Neue Wahoo-Trainings automatisch
   importieren“ aktivieren. Neue Verbindungen fordern die Berechtigung direkt an.
   Nach jeder erneuten Verbindung ist die Importoption zunächst ausgeschaltet.

Der OAuth-Token-Antwort-Scope wird berücksichtigt, falls Wahoo ihn liefert;
ohne `scope` wird gemäß OAuth die angeforderte Freigabe angenommen. Alte
Verbindungen erhalten durch Migration oder Token-Refresh keine Offline-Freigabe.
Die Profilanzeige prüft die Konfiguration des Webservers, nicht die Erreichbarkeit
von außen oder den Betriebszustand des Workers.

### Verarbeitung und Grenzen

- `POST /webhooks/wahoo` läuft ohne Browsersitzung. JSON maximal 64 KiB;
  Prüfung des `webhook_token` mit zeitkonstantem Vergleich. Fehlendes/falsches
  Token: 401; fehlende Serverkonfiguration oder Speicherfehler: 503;
  ungültige IDs/JSON: 400; zu große Nachricht: 413.
- Nur dokumentierte `workout_summary`-Meldungen mit positiven BIGINT-IDs für
  Benutzer, Summary und Workout werden verarbeitet. Andere Ereignistypen,
  unbekannte/abgeschaltete Verbindungen und inaktive Konten werden mit 200
  ignoriert. Empfangene Dateilinks und vollständige Payloads werden nicht gespeichert.
- HTTP 200 erfolgt nach dem dauerhaften Datenbankeintrag (bzw. bei Duplikaten),
  nicht erst nach dem Import. UNIQUE je WOA-/Wahoo-Konto und Summary verhindert
  wiederholte Aufträge. Wahoo wiederholt bei fehlendem 200 nach 30 Minuten,
  vier, 24 und 72 Stunden.
- Der Import-Worker prüft den Eingang alle fünf Sekunden. PostgreSQL-Sessionlocks
  verhindern gleichzeitige Verarbeitung durch mehrere Worker und erlauben
  Wiederaufnahme nach Prozessabbruch. Maximal fünf Versuche; bei Fehlern
  Wartezeiten von 30, 120, 480 und 1.920 Sekunden. Fehlercodes bleiben bereinigt;
  endgültige Fehler stehen als `failed` im Auftragseingang. Keine eigene
  Fehler-/Wiederholungsoberfläche in diesem Umfang.
- Jeder erneute Verarbeitungsversuch startet nach erfolgreicher Verbindungsprüfung
  erneut `GET /v1/workouts/<workout_id>/workout_summary` mit dem OAuth-Token des
  zugeordneten Benutzers. Aus der aktuellen Antwort wird der FIT-Dateilink gelesen
  und die Datei erneut vom zugelassenen CDN geladen. Es wird keine alte
  Download-Adresse zwischengespeichert. Schlägt bereits der Zusammenfassungsabruf
  fehl oder fehlt der Dateilink, erfolgt in diesem Versuch kein FIT-Download.
  Die Wiederholung verwendet den gespeicherten Auftrag; Wahoo muss dafür keinen
  weiteren Webhook senden. Dies ist unabhängig von Wahoos Wiederholung bei
  fehlender HTTP-200-Empfangsbestätigung.
- Vor Download und vor Speicherung werden Wahoo-ID, aktivierte Option,
  Offline-Freigabe und aktiver Kontostatus geprüft. Die letzte Prüfung sperrt
  Konto/Verbindung während des Speicherns gegen Änderungen. Nach Deaktivieren
  werden wartende Aufträge übersprungen. Trennen löscht zugehörige Aufträge.
- Download über die authentifizierte API und bestehenden begrenzten FIT-Download;
  die Summary-ID muss zur Meldung passen. Der FIT-Parser läuft in einem separaten
  Thread (60 Sekunden, 512 MiB V8-Heap-Limit). Bestehende Parserkorrekturen,
  Mindestlänge 300 Datensätze und WOA-Komprimierung gelten auch hier.
- Speicherung und Folgeaufträge verwenden den gemeinsamen WOA-Importweg.
  Vorhandene Trainings werden am Startzeitpunkt erkannt und übersprungen;
  zusätzlich schützt der Datenbankkonflikt auf Benutzer/Startzeit vor Duplikaten.
  Es wird niemals überschrieben. Bei Wiederholungen nach Teilfehlern dürfen
  Folgeaufträge für bereits gespeicherte Trainings erneut angestoßen werden.
- Dies importiert neue Meldungen, keine vollständige Historie. Dafür bleibt der
  manuelle Import bestehen. Empfangene Änderungen/Löschungen überschreiben oder
  löschen keine vorhandenen WOA-Trainings. Wahoo liefert keine Summaries von
  Trainings, die Drittanbieter-Apps erstellt haben.
- Wahoo verlangt laut Dokumentation einen gültigen Access-Token mit `offline_data`
  für Webhooks. Die bestehende Token-Erneuerung erfolgt weiter bei API-Bedarf;
  es gibt keinen zusätzlichen Token-Timer. Langfristige Zustellung bei längerer
  Inaktivität muss live geprüft werden.

Grundlage: [Wahoo-Webhooks](https://cloud-api.wahooligan.com/#webhooks).
Automatisierte Prüfungen stehen zusätzlich in `tests/wahoo-webhook.test.js`
und `tests/wahoo-settings-ui.test.js`. Der erfolgreiche Live-Ablauf ist oben als
Benutzerbestätigung dokumentiert. Weiter offen bleiben insbesondere langfristige
Zustellung bei Inaktivität/Tokenablauf sowie gesonderte Live-Prüfungen von
Duplikaten, Trennen/Deaktivieren und Wiederanlauf nach Prozessabbruch.
