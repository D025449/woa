# Garmin Connect: persönliche Verbindung

## Schritt 1: Schlüsselverwaltung

Im Profil unter „Garmin Connect“ lässt sich der persönliche API-Schlüssel speichern,
ersetzen und entfernen. Er wird nie zurück an den Browser geliefert. Der Status
„hinterlegt“ bestätigt die Speicherung, keine erfolgreiche Garmin-Anmeldung.
Beim Speichern erfolgt kein Zugriff auf Garmin. Die Verbindung wird beim Abruf der Aktivitäten geprüft.

### Einrichtung

1. `src/migrations/089_user_garmin_connections.sql` direkt gegen die gewünschte
   bestehende Anwendungsdatenbank ausführen. Nicht das gesamte alte Migrationsset
   wiederholen. Die Migration legt ausschließlich `user_garmin_connections` an.
2. `GARMIN_API_ENCRYPTION_KEY` in der Serverumgebung auf 64 Hex-Zeichen setzen
   (32 zufällige Bytes). Beispielsweise einmalig lokal erzeugen:
   `node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))'`.
   Geheim halten und außerhalb der Datenbank sichern. Nicht bei jedem Start neu
   erzeugen: Bereits gespeicherte Schlüssel sind sonst nicht mehr entschlüsselbar
   und müssen erneut eingegeben werden. Für Restore wird derselbe Schlüssel benötigt.
3. Server neu starten und die Profilseite öffnen.

Für die lokale Entwicklungsumgebung wurde bei der Implementierung ein Schlüssel in
`.env.development` ergänzt, ohne vorhandene Werte zu ersetzen. Diese Datei ist von
Git ausgeschlossen. Andere Umgebungen müssen separat konfiguriert werden.
Die Migration führt der Benutzer selbst aus.

Speicherung: AES-256-GCM mit frischer 12-Byte-IV und an die WOA-Benutzer-ID gebundenen
zusätzlichen authentifizierten Daten. Das Datenbankfeld enthält Version, IV,
Authentifizierungstag und verschlüsselte Nutzdaten. Der API-Schlüssel wird beim
endgültigen Löschen eines WOA-Kontos ebenfalls gelöscht. Konten mit vorgemerkter
Löschung dürfen die Verbindung nicht ändern.

### WOA-Endpunkte

Alle Pfade liegen unter `/api/profile/garmin` und verlangen einen angemeldeten Benutzer.

| Methode | Bedeutung |
| --- | --- |
| GET | `{ data: { configured, updatedAt } }`, niemals den Schlüssel |
| PUT | `{ apiKey: "…" }` speichern oder ersetzen; Status zurückgeben |
| DELETE | Schlüssel entfernen, HTTP 204; auch ohne vorhandenen Schlüssel erfolgreich |

Leerwerte, Nicht-Strings, innere Leerzeichen und Schlüssel über 8192 Zeichen werden
abgewiesen. Ohne gültige Server-Verschlüsselungskonfiguration liefert PUT HTTP 503.
Antworten tragen `Cache-Control: no-store`. Die generischen Profil- und
Account-Exportfunktionen enthalten den Garmin-Schlüssel nicht. Nach einem logischen
Account-Export/Import muss die Verbindung erneut eingerichtet werden.

## Manueller Workout-Import

Auf der bestehenden Importseite lädt „Neueste Workouts von Garmin holen“ die letzten
20 Aktivitäten (nach lokaler Startzeit absteigend). Nach Auswahl werden die ZIPs
nacheinander heruntergeladen und durch dieselbe Browser-Verarbeitung wie lokale
Dateien importiert. Der vorhandene Duplikatfilter und die Option zum Überschreiben
gelten auch hier. Keine neue Migration für diesen Schritt erforderlich.

Der Browser muss geöffnet bleiben. Pro Aktivität erscheint „Importiert“,
„Übersprungen“ oder ein Fehler. Fehlgeschlagene Einträge bleiben für einen erneuten
Versuch ausgewählt. Übersprungen kann insbesondere Duplikate und zu kurze Workouts
bedeuten. Bei Archiven mit mehreren FIT-Dateien zeigt der bestehende Importbereich
weitere Details zur zuletzt verarbeiteten Aktivität.

### Backend

- `garminConnectService.js` liest den Schlüssel ausschließlich für den angemeldeten
  Benutzer und fordert ein Token an. Prozesslokaler Token-Cache (maximal 1000
  Einträge), Erneuerung eine Minute vor Ablauf, ein erneuter Versuch nach HTTP 401.
  Schlüsselersetzung/-entfernung wird vor jeder Anfrage anhand der Datenbank erkannt.
- Token-Antworten unterstützen `access_token`/`expires_in` sowie
  `accessToken`/`expiresIn`. Ohne Laufzeitangabe gilt maximal 24 Stunden; ein
  JWT-Ablaufdatum begrenzt den Cache zusätzlich. Das konkrete Antwortformat ist noch
  nicht durch einen Live-Abruf verifiziert.
- GET `/api/garmin/activities` liefert nur ID, Name, lokale Startzeit, Sportart und
  Dauer. GET `/api/garmin/activities/:id/file` liefert die Original-ZIP.
- Beide Endpunkte verlangen einen angemeldeten, aktiven Benutzer und setzen
  `Cache-Control: no-store`. Schlüssel und Tokens gelangen nicht zum Browser.
- Anfragen nur an die feste Garmin-Basisadresse, keine Weiterleitungen;
  Zeitlimit 60 Sekunden, JSON maximal 2 MB, Tokenantwort maximal 64 KB,
  ZIP maximal 64 MB einschließlich Prüfung der ZIP-Signatur. Garmin-Fehlertexte
  werden nicht an den Client weitergereicht.
- Die bestehende Frontend-Verarbeitung in `upload-new.js` nimmt zusätzliche
  Quelldateien entgegen und meldet den Abschluss erst nach Verarbeitung/Speicherung.
  Während des Garmin-Ablaufs ist paralleles lokales Importieren gesperrt.

Offizielle Basisadresse: `https://personal.connectapi.garmin.com`.
Aktivitäten: GET `/activitylist-service/activities/search/activities`.
Originaldatei: GET `/download-service/files/activity/{activityId}`.
Token: POST `/personalapitoken-service/personal-api/personal-api-key/token`,
Header `Authorization: ApiKey …`; Datenabrufe mit `Authorization: Bearer …`.

## Verifikation und Grenzen

- Tests mit simulierten Garmin-Antworten: Cache/Erneuerung/401-Retry,
  Schlüsselwechsel/-entfernung, Benutzertrennung, ungültige IDs, Größenlimit,
  unerwartete Antworten und HTTP-Zugriffsschutz.
- Frontend-Test mit simuliertem DOM: Auswahl, sequenzielle Verarbeitung,
  Fortsetzung nach Download-/Importfehlern, erneute Auswahl und Textdarstellung.
- Benutzer bestätigt vollständigen lokalen Live-Test erfolgreich: Token-Abruf,
  Aktivitätsliste, ZIP-Download und FIT-Verarbeitung bis zur Speicherung. Kein
  separater Live-Test durch den Agenten. Vollständiger Produktionsimport noch
  nicht bestätigt.
- Keine zusätzliche Garmin-ID-Verwaltung, kein Hintergrundimport ohne Browser,
  keine Seitennavigation für ältere Garmin-Aktivitäten in dieser Version.

## Fehlerdiagnose

Fehlerantworten enthalten zusätzlich `diagnostic`, beispielsweise
`{"stage":"token","upstreamStatus":400,"technicalCode":"HTTP_ERROR"}`.
Die Oberfläche zeigt den lokalisierten Schritt, Garmin-HTTP-Status (falls verfügbar)
und technischen Code. Im Serverlog stehen dieselben bereinigten Angaben unter
`[garmin] request failed`. Es werden keine Response-Bodies, ursprünglichen
Fehlermeldungen, URLs, Zugangsdaten oder Tokens ausgegeben; technische Codes und
Schritte werden anhand fester Listen gefiltert. Datenbank-/Entschlüsselungsfehler
werden separat als `DATABASE_ERROR` bzw. `STORAGE_ERROR` eingeordnet.

Token-Anforderungen senden `Accept: */*`. Neben JSON-Objekten werden JSON-Strings
und einzelne Token als `text/plain` oder `application/jwt` verarbeitet. HTML,
mehrzeilige Token und ungültige JSON-Antworten werden abgewiesen. Der Benutzer
hat die Behebung des lokalen HTTP-406-Fehlers und den vollständigen Import bestätigt.
