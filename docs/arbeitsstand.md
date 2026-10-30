# Arbeitsstand

Stand: 2026-10-30. Diese Datei hält Absprachen für folgende Sitzungen fest.
Vor weiterer Arbeit mit Code und Git-Status abgleichen.

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

## Garmin Connect (2026-10-30)

- Freigegeben und implementiert: erster Schritt, UI im Profil zum Hinterlegen/Ersetzen/Entfernen des persönlichen API-Schlüssels und Persistenz. Keine Garmin-Anmeldung oder Imports in diesem Schritt.
- Neue Tabelle `user_garmin_connections`, additive Migration `src/migrations/089_user_garmin_connections.sql`. Benutzer hat ausdrücklich korrigiert: Er führt die Migration selbst aus. Vom Agenten nicht ausgeführt; keine Live-Datenbankprüfung.
- Service `garminConnectionService.js`: AES-256-GCM, neue IV je Speicherung, Benutzer-ID als AAD. Separater Server-Schlüssel `GARMIN_API_ENCRYPTION_KEY` (64 Hex-Zeichen); lokal in Git-ignorierter `.env.development` eingerichtet, geheimen Wert nicht dokumentieren. Neustart erforderlich; andere Umgebungen separat konfigurieren und Schlüssel für Restore sichern.
- GET/PUT/DELETE `/api/profile/garmin`; explizite Anmeldung, bestehende Kontostatus-Schreibsperre, Statusantwort ohne Schlüssel, kein HTTP-Cache. Schlüssel wird bei endgültiger Kontolöschung entfernt. Profil-/Account-Exports enthalten keine Garmin-Zugangsdaten.
- Profiloberfläche: neues Passwortfeld, Status „hinterlegt“, Ersetzen, Entfernen mit App-Dialog; zeigt ausdrücklich, dass keine Garmin-Prüfung erfolgt ist. Texte deutsch/englisch, übrige Sprachen englisch.
- Verifikation: drei neue Tests für Verschlüsselung/Manipulation/Benutzerbindung, Persistenz und HTTP-Zugriffsschutz erfolgreich. Gesamtsuite aktuell 616 Tests erfolgreich, keine Fehler. Syntaxprüfung und EJS-Kompilierung erfolgreich, gezieltes ESLint ohne Fehler (vorhandene `next`-Warnung in Profilrouten). Typprüfung scheitert an drei bestehenden Null-Prüfungen in `src/shared/MicroIntervalDetector.js:141`; keine Garmin-bezogenen Typfehler. Kein visueller Browsertest.
- Vereinbarter weiterer Ablauf: Token-Service → Aktion „Neueste Workouts von Garmin holen“ auf Importseite mit Aktivitätsauswahl → Server reicht ZIPs an Browser → vorhandener Browser-Worker parst FIT → bestehender Upload speichert. Duplikatprüfung zuerst wiederverwenden; zusätzliche Garmin-ID-Verwaltung zunächst zurückgestellt. Kein Hintergrundimport ohne Browser.
- Details zu Einrichtung, API-Vertrag und Folgeschritten: `docs/GARMIN_CONNECT.md`.

## Sitzungsübergreifender Kontext

- Verbindliche Absprache: Dateien nur nach ausdrücklicher Bestätigung ändern. Vorher lesen, analysieren und einen konkreten Vorschlag zeigen. Die beschriebene UI-Überarbeitung einschließlich Scrollbereich wurde mit „ok los“ freigegeben.
- Anlass: Nach einem VS-Code-Neustart fehlte im Chat die vorherige Absprache zum Implementierungsumfang.
- `AGENTS.md` verweist auf diese Datei, damit kommende Sitzungen den dokumentierten Kontext wieder aufnehmen und fortschreiben.
- Diese Dateien ersetzen keinen vollständigen Chatverlauf und stellen keinen automatischen Chat-Import dar.
