# Garmin Connect: persönliche Verbindung

## Schritt 1: Schlüsselverwaltung

Im Profil unter „Garmin Connect“ lässt sich der persönliche API-Schlüssel speichern,
ersetzen und entfernen. Er wird nie zurück an den Browser geliefert. Der Status
„hinterlegt“ bestätigt die Speicherung, keine erfolgreiche Garmin-Anmeldung.
In diesem Schritt erfolgt noch kein Zugriff auf Garmin.

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

## Vereinbarte Folgeschritte (noch nicht implementiert)

1. Backend-Service: persönlichen Schlüssel zum Token-Abruf verwenden; Tokens bis
   kurz vor Ablauf zwischenspeichern und erneuern.
2. Auf der bestehenden Importseite „Neueste Workouts von Garmin holen“ ergänzen;
   Aktivitätsliste serverseitig abrufen, im Browser zur Auswahl anzeigen.
3. Ausgewählte ZIP-Dateien serverseitig herunterladen und an den Browser reichen.
4. Dieselbe Frontend-Importfunktion für lokale Dateien und Garmin-ZIPs verwenden:
   ZIP-/FIT-Verarbeitung im vorhandenen Browser-Worker, anschließend bestehende Speicherung.
5. Vorhandene Duplikatprüfung zuerst prüfen und wiederverwenden; zunächst keine
   eigene Verwaltung importierter Garmin-IDs und kein zeitgesteuerter Hintergrundimport.

Offizielle Basisadresse: `https://personal.connectapi.garmin.com`.
Aktivitäten: GET `/activitylist-service/activities/search/activities`.
Originaldatei: GET `/download-service/files/activity/{activityId}`.
