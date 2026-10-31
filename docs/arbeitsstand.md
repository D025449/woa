# Arbeitsstand

Stand: 2026-10-31. Diese Datei hält Absprachen für folgende Sitzungen fest.
Vor weiterer Arbeit mit Code und Git-Status abgleichen.

## npm-Skript-Dokumentation (2026-10-31)

- `npm run start:all` nach ausdrücklicher Freigabe ergänzt: `src/scripts/start-all.js` startet App, Import- und Backup-Worker als eigene Node-Prozesse ohne zusätzliche Abhängigkeit. Logs erhalten Prozesspräfixe; SIGINT/SIGTERM stoppt alle, nach zehn Sekunden SIGKILL. Unerwartetes Prozessende stoppt die anderen mit Fehlerstatus. Einzelbefehle bleiben bestehen; README und Skriptübersicht aktualisiert.
- Verifikation von `start:all`: `node --check` und gezieltes ESLint erfolgreich. Laufzeitprüfung mit isolierten Testprozessen nicht erfolgreich verifizierbar: Bereits ein minimaler Node-Spawn von `console.log(123)` lieferte in dieser Werkzeugumgebung keine Child-Ausgabe. Keine echten Dienste gestartet; gemeinsames Beenden im normalen Terminal noch zu prüfen.
- Nach ausdrücklicher Freigabe zentrale Übersicht `docs/npm-scripts.md` für alle Skripte aus `package.json` erstellt: Zweck, Aufruf/Parameter, Voraussetzungen, Datenänderungen und Links zu Detailanleitungen; im README verlinkt.
- Verbindlicher Benutzerwunsch in `AGENTS.md` festgehalten: Übersicht und betroffene Detailanleitungen bei relevanten Skriptänderungen im selben Auftrag aktualisieren.
- Angaben durch Codelektüre abgeglichen; keine Betriebs-, Import-, Deploy- oder Migrationsskripte ausgeführt. Nur Dokumentation geändert.
- Verifikation: alle 32 npm-Skripte in der Übersicht enthalten, lokale Linkziele vorhanden, `git diff --check` erfolgreich. Keine Anwendungstests für diese reine Dokumentationsänderung ausgeführt.

## Zeitabhängige Körpergewichtspflege

### Bestätigter Umfang

- Körpergewicht mit Gültigkeitsdatum pflegen: UI, Backend und Read-API.
- Der Benutzer hat gemeldet, dass die Migrationen ausgeführt wurden. Die Datenbankausführung wurde vom Agenten nicht separat geprüft.
- Migration: `src/migrations/088_user_weight_history.sql`.
- Jeder Eintrag gilt einschließlich `valid_from` bis zum nächsten Eintrag desselben Benutzers.
- Für ein angefragtes Datum gilt der neueste Eintrag mit `valid_from <= Datum`.
- Gibt es keinen passenden Eintrag, dient `user_profiles.weight_kg` als Fallback; fehlt auch dieser Wert, ist kein Gewicht verfügbar.
- Profilgewicht und Historie bleiben unabhängig. Kein automatisches Kopieren des Profilgewichts und keine automatische Neuberechnung bestehender Workouts.

### Implementierter Stand

- Service: `src/services/userWeightHistoryService.js`.
- Routen: `src/routes/profileRoutes.js`; alle Zugriffe betreffen den angemeldeten Benutzer.
- Profiloberfläche: `src/views/profile.ejs`, `src/public/js/weight-history-ui.js` und `src/public/js/profile-ui.js`.
- UI erlaubt Anlegen, Bearbeiten (Datum und Gewicht) und Löschen.
- GET `/api/profile/weight-history`: Verlauf, neueste Einträge zuerst.
- POST `/api/profile/weight-history`: Eintrag anlegen.
- PUT und DELETE `/api/profile/weight-history/:id`: Eintrag bearbeiten bzw. löschen.
- GET `/api/profile/weight?date=YYYY-MM-DD`: Gewicht zum Datum mit Quelle `history`, `profile` oder null.
- Datumswerte müssen gültige Kalendertage sein. Gewicht: größer 0, maximal 500 kg, höchstens zwei Nachkommastellen. Ein Datum pro Benutzer; Duplikate liefern HTTP 409.
- Schreibzugriffe verwenden die vorhandene Kontostatus-Prüfung.
- API-Vertrag steht im README; Tests in `tests/user-weight-history.test.js`.
- UI-Überarbeitung am 2026-10-29 nach ausdrücklicher Freigabe: kompakte Zeilen nach dem Vorbild „Similar Workouts“, Gewicht hervorgehoben, lokalisiertes Gültigkeitsdatum, Aktionen rechts (mobil darunter), markierter Eintrag beim Bearbeiten und vorhandener App-Dialog beim Löschen.
- Verlauf hat eine begrenzte Höhe (Desktop ungefähr sechs Einträge) und vertikales Scrollen bei Überlauf; Überschrift und Formular liegen außerhalb des Scrollbereichs. Scrollbereich ist per Tastatur fokussierbar.
- Prüfungen dieser UI-Überarbeitung: JavaScript-Syntax, ESLint der geänderten JS-Datei, EJS-Kompilierung und `git diff --check` erfolgreich. Keine visuelle Browserprüfung durchgeführt.

### Bisherige Verifikation und offene Punkte

- In der Implementierungssitzung erfolgreich: neue Service-Tests, JavaScript-Syntaxprüfung und EJS-Kompilierung.
- ESLint der geänderten JavaScript-Dateien: keine Fehler, vorhandene Warnung zum ungenutzten `next` in `profileRoutes.js`.
- Gesamtsuite in dieser Sitzung: 107 Testdateien erfolgreich, eine fehlgeschlagen (`tests/explain-workout-insert-args.test.js`). Ursache noch nicht geklärt; nicht als behoben behandeln.
- Noch kein dokumentierter Live-Test gegen PostgreSQL und kein dokumentierter Browsertest.
- Neue Texte sind deutsch und englisch vorhanden; die übrigen Sprachdateien enthalten für die neue Oberfläche bisher englische Texte.
- Analytics-W/kg nach ausdrücklicher Freigabe am 2026-10-29 umgesetzt: CP-/FTP-Kacheln zeigen unter Watt zusätzlich W/kg mit zwei Nachkommastellen; Hinweistext enthält Gewicht, Bezugsdatum und Quelle. Ohne Gewicht erscheint „– W/kg“.
- Bezugsdatum ist der UTC-Kalendertag von `start_time` des CP-Ursprungsworkouts bzw. `startTime` des zugrunde liegenden FTP-Schätzpunkts. Die Wattachsen bleiben unverändert.
- `UserWeightHistoryService.enrichPowerRows` lädt Gewicht für eindeutige Bezugsdaten gebündelt über einen Lateral-Join; Profilgewicht bleibt Fallback. Keine einzelne HTTP-Abfrage pro Kachel.
- JSON-CP-API und binäre Analytics-Übersicht liefern Gewichtsmetadaten. Binärformat Version 5 ergänzt drei Bytes pro CP-/FTP-Datensatz; Decoder kann Version 4 weiterhin lesen. W/kg wird aus dem angezeigten, auf ganze Watt gerundeten Leistungswert berechnet.
- Gewichts- und Profilspeicherung invalidieren den serverseitigen Analytics-Cache. Der Overview-Client fragt ohne Browser-HTTP-Cache an; Importversionen wurden aktualisiert.
- Verifikation der Analytics-Ergänzung: gezielte Tests für Codec, Gewichtshistorie, Analytics-Cache, Perioden und FTP-Trend erfolgreich; Syntaxprüfung und EJS-Kompilierung erfolgreich; ESLint ohne Fehler (bestehende Warnungen). Gesamtsuite weiterhin 107 erfolgreich / eine Testdatei fehlgeschlagen (`explain-workout-insert-args`). Noch keine visuelle Browserprüfung, Live-Datenbankprüfung oder EXPLAIN-Messung dieser Ergänzung.

## Vorgemerkte Trainings-KPIs (2026-10-30)

- Benutzer möchte die besprochenen Ideen und die vorgeschlagene Reihenfolge für eine spätere Umsetzung festhalten. Noch kein Implementierungsauftrag und keine Freigabe für Codeänderungen.
- Vorgeschlagene Reihenfolge: zuerst aerobe Entkopplung/Herzfrequenzdrift und aerober Effizienztrend (Leistung im Verhältnis zum Puls), danach Durability (Leistung nach Vorbelastung), anschließend Intervall-Wiederholbarkeit als weiterer Favorit.
- Entkopplung/Effizienz nur aus geeigneten, vergleichbaren Ausdauerabschnitten; Pausen, Intensitätswechsel und Umgebungsbedingungen berücksichtigen. Konkrete Berechnung und Darstellung noch festzulegen.
- Durability: z. B. beste 5-/20-Minuten-Leistung nach 1.000/2.000 kJ Vorbelastung gegenüber normaler Bestleistung. Fehlende harte Versuche dürfen nicht als Leistungsabfall interpretiert werden; Definition und Datenverfügbarkeit noch prüfen.
- Intervall-Wiederholbarkeit: Leistung je Wiederholung und Abfall im Verlauf, ergänzt um Pausenlänge und Pulsverlauf.
- Weitere Ideen ohne festgelegte Reihenfolge: Trainingskontinuität (Wochenziele/Unterbrechungen), Belastungsprogression (Stunden/TSS/intensive Minuten gegenüber Vorwochen), Aktualität und Datengrundlage des Leistungsprofils (Alter/Ursprungsworkout/vergleichbare Belastungen), absolute Minuten je Leistungszone und Wochenentwicklung als Ergänzung zur vorhandenen Leistungsverteilung.
- Vor darauf aufbauenden Planungskennzahlen prüfen/korrigieren: `trainingContextService.js` nutzt für `hours7d`/`hours28d` und entsprechende TSS-Summen aktuell die letzten 7/28 Aktivitäten (`slice`) statt Datumsfenster. Bei der Codelektüre bestätigt, noch nicht behoben.
- Bereits vorhanden laut bisheriger Codelektüre: CTL/ATL/TSB, TSS, FTP, CP-Leistungsprofile, W/kg, Leistungsverteilung sowie Planerfüllung/Soll-Ist im Coaching. Vor Umsetzung erneut abgleichen.
- In dieser Sitzung ausschließlich diese Vormerkung dokumentiert; keine neuen KPIs implementiert. Prüfung: `git diff --check`.

## Deploy-Testkorrektur (2026-10-31)

- Nach Freigabe veraltete Cache-Version im Test `tests/upload-overwrite-propagation.test.js` auf `garmin-pagination-1` aktualisiert; entspricht dem Upload-Template. Keine Änderung am Überschreibverhalten.
- Betroffene Testdatei mit `node --test tests/upload-overwrite-propagation.test.js` erfolgreich; `git diff --check` erfolgreich. Kein erneutes Deployment und keine Gesamtsuite ausgeführt.

## Garmin-Schlüsselhilfe (2026-10-31)

- Freigegebene schlanke Variante umgesetzt: Hilfelink „ⓘ API-Schlüssel bei Garmin erstellen“ direkt beim Profil-Schlüsselfeld öffnet die offizielle Garmin-Anleitung in einem neuen Tab; kurzer Hinweis zum Erstellen und Einfügen. Kein Modal und keine kopierten Garmin-Prozessschritte.
- Texte in allen sechs Sprachdateien ergänzt; neuer Tab für Screenreader angekündigt, erklärender Hinweis mit Eingabefeld verknüpft. `docs/GARMIN_CONNECT.md` verweist ebenfalls auf Garmin; Link gelegentlich prüfen.
- Prüfung: EJS-Kompilierung, JSON-/Sprachschlüsselprüfung und `git diff --check` erfolgreich. Offizielle Zielseite in dieser Unterhaltung zuvor abgerufen und inhaltlich bestätigt. Keine visuelle Browserprüfung, kein Deployment.

## Garmin-Nachladen (2026-10-31)

- Nach ausdrücklicher Freigabe „Weitere 20 laden“ ergänzt: ältere Seiten werden angehängt; Auswahl und Einzelstatus bleiben erhalten. Gleiche Aktivitäts-IDs erscheinen nur einmal. Downloads und Duplikatprüfung bleiben im bestehenden Importweg.
- GET `/api/garmin/activities?start=20` akzeptiert einen optionalen nichtnegativen ganzzahligen Offset, feste Seitengröße 20; ungültige Werte liefern HTTP 400. Nach kurzer/leerer Seite verschwindet der Button; Fehler erlauben Wiederholung desselben Offsets.
- Oberfläche, Sprachtexte, Cache-Versionen und `docs/GARMIN_CONNECT.md` aktualisiert. Keine Migration erforderlich oder ausgeführt.
- Verifikation: 14 Garmin-Tests erfolgreich, einschließlich Nachladen/Auswahlerhalt/Fehlerwiederholung/Deduplizierung/Offsetvalidierung. HTTP-Tests nach Sandbox-EPERM mit erlaubtem lokalen Testserver erfolgreich wiederholt. Syntax der betroffenen JS-Dateien, gezieltes ESLint (nur sechs bestehende Warnungen in upload-new.js), EJS-Kompilierung und Diff-Prüfung erfolgreich.
- Offen: Live-Test älterer Seiten bei Garmin und visuelle Browserprüfung. Kein Deployment durchgeführt.

## Garmin Connect (2026-10-30)

### Bestätigter Umfang und Umsetzung

- Persönlichen API-Schlüssel im Profil hinterlegen, ersetzen und entfernen. Verschlüsselte Speicherung in `user_garmin_connections`; additive Migration `src/migrations/089_user_garmin_connections.sql` nur erstellt, vom Agenten nicht ausgeführt. Migrationen führt ausschließlich der Benutzer aus.
- `garminConnectionService.js`: AES-256-GCM, frische IV je Speicherung und Benutzer-ID als AAD. Separater Server-Schlüssel `GARMIN_API_ENCRYPTION_KEY`; lokal eingerichtet, auf Produktion laut Benutzer ebenfalls eingerichtet. Schlüssel niemals dokumentieren und für Restore außerhalb der Datenbank sichern.
- GET/PUT/DELETE `/api/profile/garmin`: angemeldeter Benutzer, bestehende Kontostatus-Schreibsperre, Statusantwort ohne Schlüssel, kein HTTP-Cache. Beim endgültigen Löschen des Kontos wird die Verbindung entfernt; Profil-/Account-Exports enthalten keine Garmin-Zugangsdaten.
- Manueller Import auf bestehender Importseite: „Neueste Workouts von Garmin holen“, Auswahl aus neuesten 20 Aktivitäten, sequenzieller ZIP-Download und Einzelstatus. `garminRoutes.js`, `garminConnectService.js`, `garmin-import-ui.js`; ZIP-/FIT-Verarbeitung im bestehenden Browser-Worker und bestehender Speicherweg in `upload-new.js`.
- Vorhandene Duplikatprüfung und Überschreiboption gelten weiter. Einzelne Fehler stoppen die restliche Auswahl nicht. Keine zusätzliche Garmin-ID-Verwaltung, ältere Listenseiten wurden am 2026-10-31 ergänzt (siehe oben); kein Hintergrundimport ohne Browser. Für den Import keine weitere Migration erforderlich.
- Token-Cache pro Benutzer und gespeicherter Schlüsselversion; Erneuerung vor Ablauf und einmal nach HTTP 401. Schlüssel/Tokens ausschließlich serverseitig. Feste Garmin-Adresse, keine Redirects, Zeit-/Größenlimits und ZIP-Signaturprüfung.
- Diagnosefeld mit Schritt, Garmin-HTTP-Status und freigegebenem technischen Code, Anzeige im UI und bereinigtes Serverlog. Keine Schlüssel, Tokens, ursprünglichen Fehlermeldungen oder Antwortinhalte ausgeben.
- Lokaler HTTP-406-Fehler bei Token-Anforderung nach Umstellung auf `Accept: */*` behoben laut Benutzer. Parser unterstützt JSON-Objekte, JSON-Strings und einzelne Token als `text/plain`/`application/jwt`; HTML/ungültige Token werden abgewiesen.

### Verifikation und aktueller Stand

- **Benutzer bestätigt vollständigen lokalen Live-Test erfolgreich:** Token-Anforderung, Aktivitätsliste, Auswahl, ZIP-Download und FIT-Import bis zur Speicherung. Kein separater Live-Test durch den Agenten; konkretes Token-Antwortformat nicht separat festgestellt.
- Auf Produktion hat der Benutzer zuvor die erfolgreiche Schlüsselspeicherung bestätigt. Vollständiger Garmin-Import auf Produktion noch nicht bestätigt.
- Zuletzt 625 Tests erfolgreich. Syntax, gezieltes ESLint, EJS-Kompilierung und `git diff --check` erfolgreich; vorhandene ESLint-Warnungen bleiben. Typprüfung scheitert weiterhin an drei bekannten Null-Prüfungen in `src/shared/MicroIntervalDetector.js:141`.
- Noch nicht live bestätigt: erneuter Import derselben Aktivität/Duplikatverhalten und langfristige automatische Token-Erneuerung. Automatisierte Tests für Cache/Erneuerung/401-Retry, Benutzertrennung, Diagnose/Geheimnisschutz und UI-Fehlerfortsetzung vorhanden.
- Einrichtung und API-Vertrag: `docs/GARMIN_CONNECT.md`.

## Sitzungsübergreifender Kontext

- **Verbindlich: Migrations-SQL niemals durch den Agenten ausführen, auch nicht indirekt über Runner oder Deployments. Nur erstellen/vorbereiten; ausschließlich der Benutzer führt Migrationen aus.** Ebenso in `AGENTS.md` festgehalten.

- Verbindliche Absprache: Dateien nur nach ausdrücklicher Bestätigung ändern. Vorher lesen, analysieren und einen konkreten Vorschlag zeigen. Die beschriebene UI-Überarbeitung einschließlich Scrollbereich wurde mit „ok los“ freigegeben.
- Anlass: Nach einem VS-Code-Neustart fehlte im Chat die vorherige Absprache zum Implementierungsumfang.
- `AGENTS.md` verweist auf diese Datei, damit kommende Sitzungen den dokumentierten Kontext wieder aufnehmen und fortschreiben.
- Diese Dateien ersetzen keinen vollständigen Chatverlauf und stellen keinen automatischen Chat-Import dar.
