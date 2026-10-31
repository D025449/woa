# Wahoo verbinden

Stand: 2026-10-31. Implementiert ist der OAuth-Verbindungsablauf mit verschlüsselter
Token-Verwaltung und lokalem Trennen im Profil. Der Workout-Import folgt separat.

## Einrichtung

1. In [Wahoos Developer Portal](https://developers.wahooligan.com/applications)
   eine **Confidential**-Anwendung für den serverseitigen OAuth-Code-Flow einrichten.
   Sandbox und Produktion sind getrennte Anwendungen; Freigaben bei Wahoo beachten.
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

Client-Secret und Verschlüsselungsschlüssel gehören ausschließlich auf den Server..
Den Verschlüsselungsschlüssel getrennt von der Datenbank für Wiederherstellungen
sichern. Austausch ohne Umschlüsselung macht bestehende Tokens unlesbar.
Keine zusätzlichen npm-Skripte oder Abhängigkeiten erforderlich.

## Ablauf und Schnittstellen

- `GET /auth/wahoo/status`: angemeldet, liefert nur `configured`, `available` und
  `updatedAt` in `data`. `configured` bedeutet gespeicherte Verbindung, keine
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
Es wird nur `user_read` angefordert; für späteren Workout-Import muss der Umfang
um `workouts_read` erweitert und erneut autorisiert werden. Kein Hintergrundabruf.
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

Feste Wahoo-Endpunkte, keine HTTP-Redirects, 15 Sekunden Zeitlimit je Anfrage und
64 KiB Antwortlimit. Fehlerantworten werden verworfen. Nach Wahoos Vorgabe löst
erst ein erfolgreicher API-Aufruf mit erneuertem Token die Ablösung vorheriger
Tokens aus; deshalb keine vorsorglichen Erneuerungen ohne API-Bedarf.

Grundlage: [offizielle Wahoo-API-Referenz](https://cloud-api.wahooligan.com/),
am 2026-10-31 geprüft (OAuth, Scopes, Token-Limits und Deauthorization).

## Prüfungen und noch offene Live-Prüfung

Automatisierte Tests stehen in `tests/wahoo-callback.test.js` und
`tests/wahoo-connection.test.js`; `tests/wahoo-profile.test.js` prüft das Rendering
in allen sechs Sprachen. Die Service-/Routentests verwenden simulierte Wahoo-Antworten und
Datenbankzugriffe; HTTP-Routentests verwenden ausschließlich einen lokalen Testserver.

Noch erforderlich nach manueller Einrichtung: echter Wahoo-Consent/Callback,
Trennen und erneutes Verbinden sowie Token-Erneuerung gegen Wahoo und PostgreSQL.
Eine visuelle Browserprüfung, ein Deployment und die Migration wurden vom Agenten
nicht durchgeführt. Der tatsächlich gewährte Scope und das produktive
Token-Antwortformat müssen dabei live bestätigt werden.
