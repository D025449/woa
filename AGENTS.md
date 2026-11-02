# Hinweise für die Arbeit an diesem Repository

## Kontext über Sitzungen hinweg

- Lies zu Beginn jeder Sitzung `docs/arbeitsstand.md`, bevor Du Änderungen planst oder ausführst.
- Verschaffe Dir zusätzlich einen Überblick über die Markdown-Dateien in `docs/` und lies vor der jeweiligen Aufgabe die thematisch relevanten Detailanleitungen. Nutze sie zusammen mit dem Arbeitsstand als sitzungsübergreifenden Projektkontext.
- Prüfe den tatsächlichen Code und Git-Status; der dokumentierte Arbeitsstand kann veraltet sein.
- Aktualisiere `docs/arbeitsstand.md` nach wesentlichen Änderungen und vor Abschluss eines Implementierungsauftrags: Umfang, Entscheidungen, Umsetzung, Prüfungen und offene Punkte.
- Halte betroffene Detailanleitungen in `docs/` im selben Auftrag aktuell. Dokumentiere dauerhafte Absprachen und relevanten Kontext dort, wo sie fachlich hingehören; der Arbeitsstand enthält eine knappe Zusammenfassung mit Verweisen statt doppelter Detailbeschreibungen. Neue Dokumentationstexte werden auf Englisch verfasst.
- Halte den Arbeitsstand knapp. Speichere keine Zugangsdaten, Tokens oder Inhalte aus `.env`- oder SSH-Dateien darin.
- Unterscheide bestätigte Anforderungen, implementierte Funktionen und noch nicht geprüfte Annahmen. Behaupte keine ausgeführten Migrationen, Tests oder Deployments ohne entsprechende Grundlage.
- Nutze vorhandene Absprachen, bevor Du den Benutzer erneut nach bereits geklärten Anforderungen fragst.

## Projekt und Prüfungen

- Migrations-SQL niemals selbst ausführen, auch nicht über Migrationsrunner, Deployments oder andere indirekte Wege. Migrationen nur vorbereiten und zur manuellen Ausführung bereitstellen; ausschließlich der Benutzer führt sie aus.

- Änderungen an Dateien erst nach ausdrücklicher Bestätigung des Benutzers vornehmen. Zunächst prüfen und einen konkreten Vorschlag vorstellen; nach Freigabe den vereinbarten Umfang umsetzen. Reine Lesezugriffe benötigen keine zusätzliche Bestätigung.
- Node.js-Anwendung mit ES-Modulen, Express, PostgreSQL und EJS; Browsercode liegt unter `src/public/js`.
- Verfügbare Prüfungen stehen in `package.json`: `npm test`, `npm run check:syntax`, `npm run check:lint` und `npm run check:types`.
- Pflege `docs/npm-scripts.md` und betroffene Detailanleitungen im selben Auftrag mit, wenn npm-Skripte hinzugefügt, entfernt oder in Zweck, Parametern, Voraussetzungen oder Nebenwirkungen relevant geändert werden. Halte den Verweis im README aktuell.
- Führe zur Änderung passende Prüfungen aus und dokumentiere relevante Fehler und Grenzen der Verifikation.
- Kommuniziere mit dem Benutzer auf Deutsch.
