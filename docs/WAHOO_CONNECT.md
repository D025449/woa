# Wahoo: vorbereitete Redirect-Adresse

Stand: 2026-10-31. Es existiert bislang ausschließlich ein Callback-Platzhalter,
keine funktionsfähige OAuth-Verbindung und kein Wahoo-Import.

Bei der App-Registrierung ist als Redirect URI vorgesehen:

```text
https://<WOA-Domain>/auth/wahoo/callback
```

Nach Deployment führt GET auf diesen Pfad zur Profilseite mit dem Hinweis:
„Die Wahoo-Anbindung ist noch nicht eingerichtet. Es wurde keine Verbindung hergestellt.“
Ohne WOA-Anmeldung greift anschließend der bestehende Profil-Login.

Der Platzhalter ignoriert alle OAuth-Parameter, tauscht keinen Code gegen Tokens
und speichert keine Verbindung. Er setzt `Cache-Control: no-store` und
`Referrer-Policy: no-referrer`; die Weiterleitung enthält keine OAuth-Parameter.
Kein frei wählbares Weiterleitungsziel.

Für die vollständige Anbindung fehlen insbesondere Verbindungsstart mit
sitzungsgebundener State-Prüfung, Token-Austausch und sichere Token-Verwaltung.
Die App-Registrierung allein schaltet noch keinen Datenzugriff in WOA frei.
