# Hinweise für die Arbeit an diesem Repository

## Kontext über Sitzungen hinweg

- Lies zu Beginn jeder Sitzung `docs/arbeitsstand.md`, bevor Du Änderungen planst oder ausführst.
- Prüfe den tatsächlichen Code und Git-Status; der dokumentierte Arbeitsstand kann veraltet sein.
- Aktualisiere `docs/arbeitsstand.md` nach wesentlichen Änderungen und vor Abschluss eines Implementierungsauftrags: Umfang, Entscheidungen, Umsetzung, Prüfungen und offene Punkte.
- Halte den Arbeitsstand knapp. Speichere keine Zugangsdaten, Tokens oder Inhalte aus `.env`- oder SSH-Dateien darin.
- Unterscheide bestätigte Anforderungen, implementierte Funktionen und noch nicht geprüfte Annahmen. Behaupte keine ausgeführten Migrationen, Tests oder Deployments ohne entsprechende Grundlage.
- Nutze vorhandene Absprachen, bevor Du den Benutzer erneut nach bereits geklärten Anforderungen fragst.

## Projekt und Prüfungen

- Änderungen an Dateien erst nach ausdrücklicher Bestätigung des Benutzers vornehmen. Zunächst prüfen und einen konkreten Vorschlag vorstellen; nach Freigabe den vereinbarten Umfang umsetzen. Reine Lesezugriffe benötigen keine zusätzliche Bestätigung.
- Node.js-Anwendung mit ES-Modulen, Express, PostgreSQL und EJS; Browsercode liegt unter `src/public/js`.
- Verfügbare Prüfungen stehen in `package.json`: `npm test`, `npm run check:syntax`, `npm run check:lint` und `npm run check:types`.
- Führe zur Änderung passende Prüfungen aus und dokumentiere relevante Fehler und Grenzen der Verifikation.
- Kommuniziere mit dem Benutzer auf Deutsch.
