# Arbeitsstand

Stand: 2026-11-12. Diese Datei hält Absprachen für folgende Sitzungen fest.
Vor weiterer Arbeit mit Code und Git-Status abgleichen.

## REST und MCP get_workout_map (2026-11-12)

- Neuer REST-Endpoint `GET /api/v1/workouts/:id/map.webp`: rendert 640×400 WebP-Karte
  mit OSM-Hintergrund + GPS-Route. Scope `workouts:gps:read`, Rate-Limit `gps` (40/min).
  Fehler: `workout_not_found` → 404, `map_unavailable` → 503.
- Neues MCP Read-Tool `get_workout_map` (Scope `workouts:read`, Rate-Limit `gps`-Bucket):
  gibt MCP Image Content (`image/webp`, 640×400, base64) + Text-Metadaten zurück.
  Interne 320×200-Thumbnails für die WOA-UI bleiben unverändert.
- `publicWorkoutApiService.map()`: ruft `this.gps()` intern auf, parst GeoJSON-Koordinaten,
  rendert via `LocalThumbnailMapService` (Worker-Thread), rasterisiert SVG mit sharp 640×400.
  `localMapClient` ist injectable. Graceful fail bei nicht konfigurierten lokalen Karten.
- `MCP_TOOL_NAMES` auf 8 (inkl. `get_workout_map`).
- 989/989 Tests grün. Syntax und Lint sauber. Deployed 2026-11-12.

## MCP get_workout_gps und delete_workout (2026-11-12)

- Neues Read-Tool `get_workout_gps`: GPS-Track eines einzelnen Workouts als GeoJSON Feature.
  Scope `workouts:read`, Rate-Limit-Bucket `gps` (40/min). `geometry: null` wenn kein GPS vorhanden.
- Neues Write-Tool `delete_workout`: löscht ein eigenes Workout dauerhaft. Scope `activities:write`,
  `destructiveHint: true`. Server-Instructions verlangen User-Bestätigung vor dem Aufruf.
- `MCP_TOOL_NAMES` auf 7 (inkl. `get_workout_gps`), `MCP_WRITE_TOOL_NAMES` auf 4 (inkl. `delete_workout`).
- Server-Instructions: „GPS and raw sample data are not accessible" → GPS-Hinweis entfernt,
  delete-Hinweis ergänzt.
- 988/988 Tests grün. Deployed 2026-11-12.

- Tool `import_workout_file` für FIT/ZIP-Import via base64. Funktioniert mit nativen MCP-Clients
  (Codex liest Datei vom Filesystem und kodiert programmatisch); Claude.ai-Web kann große Binärdaten
  nicht zuverlässig als base64 in Tool-Parameter schreiben.
- Unterstützt `.fit` (einzeln) und `.zip` (mehrere FIT-Dateien); max. 20 MB base64 ≈ 15 MB roh.
- MCP-Body-Limit von 16 KB auf 22 MB erhöht (`mcpRoutes.js`); Regressionstest ergänzt.
- `overwrite_existing` optional; gleiche Pipeline wie Provider-Sync.
- 986/986 Tests grün. Deployed 2026-11-12.

## MCP sync_workouts_from_providers – overwrite_existing (2026-11-11)

- Neuer optionaler Parameter `overwrite_existing: boolean` (Default `false`) im MCP-Tool
  `sync_workouts_from_providers`.
- Wird als `overwriteExisting` an `importWoaEntryReaders` weitergegeben; bei `true` werden
  zeitlich kollidierende Trainings ersetzt und erscheinen im Ergebnis als `imported`.
- `destructiveHint` auf `true` gesetzt; Tool-Beschreibung und Test angepasst.
- 985/985 Tests grün. Noch nicht deployed.

## MCP sync_workouts_from_providers (2026-11-11)

- Neues MCP-Tool `sync_workouts_from_providers` implementiert (gated auf `activities:write`).
- Orchestrierung in `src/services/mcpProviderSyncService.js`: prüft verbundene Provider per DB,
  holt Aktivitätsliste, lädt FIT-Dateien, konvertiert via bestehenden `convertWahooFit`-Worker
  und importiert via `importWoaEntryReaders` mit `overwriteExisting: false`.
- Garmin-ZIPs werden mit `unzipper` (bereits Dependency) serverseitig entpackt.
- Zeitliche Konflikte und Duplikate werden durch `importWoaEntryReaders` automatisch erkannt
  und als `skipped` mit Reason `workout_time_conflict` zurückgemeldet.
- `MCP_WRITE_TOOL_NAMES` um `sync_workouts_from_providers` ergänzt.
- i18n-Texte `activitiesWrite` und `consentHelpWrite` in allen 6 Sprachen erweitert
  (Garmin/Wahoo-Import erwähnt).
- Input: `providers` (optional, default: alle verbundenen), `limit` 1–20 (default 10).
- Output: `results[]` mit pro-Activity `status` (imported/skipped/failed) + `summary`.
- 985/985 Tests grün, Syntax und Lint sauber. Noch nicht deployed.

## MCP Claude-Verbindung und `prompt`-Parameter (2026-11-11)

- Claude.ai sendet OIDC-Parameter `prompt` in der OAuth-Authorize-Anfrage.
- `prompt` zur Allowlist in `mcpOAuthService.js` `authorization()` ergänzt; akzeptiert, ignoriert.
- `woa-claude` OAuth-Client in `.env.production` eingetragen (per SSH-Python-Skript, da nano
  bei langen JSON-Strings Unicode-Anführungszeichen und Zeilenumbrüche einführt).
- 985/985 Tests grün. Deployed.

## MCP create_training_activity – Scope, Migration und Consent (2026-11-11)

- GPS-Refactoring Step 9 (GpsTrackBlobCodec) und FIT Step 10 (bereits korrekt) abgeschlossen.
- MCP-Tool `create_training_activity` implementiert und deployed. User hat Aktivitätserfassung
  erfolgreich getestet (bestätigt).
- Scope `activities:write` in `MCP_SCOPES` (mcpConfig.js) ergänzt. Default-Scopes und
  `mcpScopes()` so angepasst, dass `activities:write` immer im Grant enthalten ist, auch wenn
  der OAuth-Client es nicht explizit anfordert (ChatGPT sendet explizite Scope-Liste ohne es).
- Migration `100_mcp_activities_write_scope.sql` vorbereitet und vom User ausgeführt: CHECK-Constraint
  auf `user_mcp_grants.scopes` um `activities:write` erweitert, Kardinalitätsgrenze von 3 auf 4..
- Consent-Seite (`mcp-consent.ejs`) und alle 6 i18n-Dateien (de/en/es/fr/it/pt) um
  `activitiesWrite`-Scope-Text und `consentHelpWrite`-Hinweis ergänzt.
- `scopeLabels` in `mcp-connections.ejs` um `activities:write` erweitert..
- `service_documentation: config.origin` in OAuth AS Metadata ergänzt (RFC 8414, Website-Feld).
- ChatGPT Plugin-Version zeigt immer `1.0.0` – das ist ChatGPTs eigene Registrierungsversion,
  nicht unsere MCP-Serverversion. Nicht steuerbar, nicht relevant.
- 985/985 Tests grün, Syntax-Check sauber.

## Deterministic Cursor Tampering Test (2026-11-10)

- User reported a full-suite failure at public-workout-api.test.js:110 and
  approved the test-only correction. The old test replaced the first random
  cursor character with A, leaving it unchanged when already A. A synthetic
  cursor reproduced the unchanged-input acceptance; no API regression identified.
- The test now flips one decoded nonce byte, re-encodes the cursor and verifies
  inequality before expecting rejection. Production cursor code is unchanged.
- Focused pagination test and the complete suite passed: 982/982 tests, including
  the pending ChatGPT ui_locales fix. Diff checks passed; preceding OAuth syntax,
  zero-warning lint and types checks remain valid (no production JS changes in
  this follow-up). Details: public-api-v1.md and mcp-server.md. No migration,
  deployment, restart or commit. ChatGPT connection still needs a fresh attempt
  after deployment/restart.

## ChatGPT Web OAuth Language Hint (2026-11-10)

- User is connecting ChatGPT web and supplied sanitized authorization parameters.
  Client/callback/resource/response type/PKCE match, but ChatGPT adds ui_locales;
  the strict allowlist rejected it before login. User approved a narrow fix.
  Accept this optional hint once, at most 256 characters, and ignore it; exclude
  it from consent/grant/token data and rendering. Other validations remain.
- Regression failed before the fix and passed afterward; all 16 focused MCP
  tests, syntax, zero-warning lint, types and diff checks passed. Real Express/EJS
  HTTP-object fixtures exercise login redirect, consent and callback with the
  hint, plus duplicate/oversized/unknown/security rejection. No full-suite rerun.
- Production read-only checks found the exact user-confirmed ChatGPT callback
  registered for woa-chatgpt with a secret digest. A synthetic authorization probe
  accepted it and redirected to login without consent/token issuance. Sanitized
  production error logs locate the failed real request at GET authorize; extra
  Nginx-log inspection was blocked by technical approval-review stream failures.
- Setup details: docs/mcp-server.md. No migration, deployment, restart, credential
  change or commit. Deploy/restart then begin a fresh ChatGPT Connect flow; real
  web login/consent/token exchange/tools remain unverified.

## Grouped Public Power Profiles (2026-11-10)

- User approved optional week/month/quarter/year grouping for the existing REST
  power-profile endpoint and MCP get_power_profile. One response returns all
  selected CP durations per UTC calendar period; maxima, null/zero distinctions,
  deterministic source ties and source-date weight provenance are preserved.
- Grouped mode without from starts at the earliest valid matching stored effort
  before to; missing to includes today. No matching history without from returns
  an empty list and meta.from=null. Explicit ranges include empty periods. The
  ungrouped 28-day default and response remain unchanged.
- One SQL query ranks valid period/duration winners, with a single batch weight
  lookup. Returned winners retain the row cap; incremental/final response budgets,
  SQL/work-memory/concurrency limits, scopes and quotas remain. Docs and OpenAPI
  v1.5.0: public-api-v1.md/.openapi.json and mcp-server.md. No new npm scripts.
- All 981 tests, syntax, zero-warning lint, types and diff checks passed. Initial
  focused HTTP checks hit sandbox EPERM; after a technical approval-review stream
  failure, the approved full suite passed. Tests use SQL fixtures; live PostgreSQL
  execution/plans/latency remain unverified. No migration, deployment, restart
  or commit performed.

## Public REST/MCP Metrics, Ranges And Diagnostics (2026-11-10)

- User approved shared FTP/TSS and correlated safe diagnostics, then requested
  removing the annual analytics constraint and increasing quotas by four. All
  four analytics endpoints and MCP tools accept multi-year UTC ranges. Default
  remains 28 days; row/byte/SQL/history/concurrency budgets remain. Summary avoids
  serializing unreturned daily results; FTP bucket bytes are checked incrementally.
- Workout and analytics services use one UTC yearly FTP/TSS policy and the same
  full bounded anchor query, including following-year anchors. No FTP before the
  first valid anchor; retain the last afterward; no pre-calculation Watt rounding.
  Historical derived API metrics may change; legacy browser calculations remain.
  Both dedicated pools retain the main pool's dynamically resolved DB name.
- Request quotas: ingress 480/min/IP, authenticated 240/min/user, analytics/GPS/FIT
  40/min/user and OAuth token/revoke 120/min/IP. Key/grant counts and TTL unchanged.
  REST errors and sanitized structured logs share server-generated request IDs;
  HTTP exposes X-Request-ID. MCP tool errors include it; OAuth keeps its JSON shape.
  Logs exclude URL/query/body, credentials, identities, raw messages and stacks.
- All 976 tests, syntax, zero-warning lint, types and diff checks passed. Coverage
  compares actual workout/analytics service results, multi-year REST/MCP, unchanged
  resource limits, quota wiring and correlated secret-free errors. A full-suite
  error Content-Type regression was repaired and the full suite passed afterward.
  Final 26 contract tests also passed after removing the old FTP bucket schema
  cap. Docs: public-api-v1.md/OpenAPI v1.4.0 and mcp-server.md. No new npm scripts.
- No migration, production operation, deployment/restart or commit. Live rollout
  remains pending. User previously confirmed successful woa_training OAuth login;
  current production tool data/refresh have not been independently exercised.

## MCP Consent Callback CSP (2026-11-10)

- User reported first consent click staying on the form and second click denied.
  An isolated browser fixture reproduced that sequence: `form-action 'self'`
  blocked the cross-origin 303 callback after consent consumption. User approved
  adding the validated callback origin with its actual port to the consent CSP.
  No wildcards; exact redirect/path/query/PKCE and origin/session/CSRF checks
  remain. Details and reproduction limits: docs/mcp-server.md.
- Real Express/EJS form with synthetic local session/stubbed issuance reached
  the separate-port callback on the first click for both allow and deny. No real
  grant, token exchange or database operation. All 14 focused MCP tests, syntax,
  zero-warning lint, types and diff checks passed. Tests cover selected HTTPS
  origin, actual varying native ports and rejected unregistered callbacks.
- No full-suite rerun, migration, deployment, service restart or commit. Fresh
  production login/consent, token exchange, tools and refresh remain pending
  rollout. Temporary testservers were stopped after verification.

## Dedicated OAuth And Analytics Pool Credentials (2026-11-10)

- User reported `server_error` after consent and approved fixing both affected
  pools. pg hides `password` from enumeration; spreading shared pool options
  omitted it. Production read-only checks found the expected MCP schema and
  checked table/sequence privileges. A copied-pool `SELECT 1` failed with a SASL
  password-type error; explicit transfer succeeded with the active production
  database configuration. No credentials or user rows were printed.
- OAuth and analytics pools now explicitly retain `pool.options.password`,
  preserving hidden serialization and existing limits. The real-pg fixture
  regression failed before and passed after the fix without opening connections.
  All 969 tests, syntax, zero-warning lint, types and diff checks passed. Initial
  targeted analytics HTTP tests hit sandbox EPERM; the full suite passed with
  approved temporary test ports. Docs: mcp-server.md and public-api-v1.md.
- No migration, deployment, restart or commit. Production consent/token exchange,
  analytics requests and MCP tools/refresh remain pending rollout and fresh login.
  The user-provided Cognito NotAuthorizedException log originates in the login
  path; it does not identify the independently reproduced pool failure.

## MCP Consent Origin Fix (2026-11-10)

- User reported production WOA consent returning `access_denied` after allowing
  Codex access and approved the narrow header correction. An isolated browser
  form reproduced `Origin: null` with `no-referrer`; `same-origin` retained the
  expected origin. Override only the rendered consent GET to `same-origin`.
  Exact-origin/session/expiry/CSRF checks remain; redirects and token responses
  keep `no-referrer`. Details: docs/mcp-server.md.
- All 14 focused MCP tests, syntax, zero-warning lint, types and diff checks
  passed. Coverage includes missing/null/foreign Origin and invalid CSRF
  rejection, native consent and response policies. No full-suite rerun, migration,
  deployment, service restart or commit in this slice. User confirms production
  login and consent UI are reachable; successful token exchange/tools/refresh
  remain pending deployment/restart and a fresh client login.

## Codex Native OAuth Compatibility (2026-11-10)

- User identified the desktop UI as Codex and approved a separate public
  woa-codex client plus native loopback compatibility. Added shared callback
  validation for public http://127.0.0.1 registrations: variable port only when
  none is registered, with exact scheme/literal host/path/query; fixed ports
  remain fixed. Non-loopback callbacks and resource/issuer remain HTTPS.
  Authorization and consent both use it; code exchange retains the exact actual
  redirect/port and PKCE binding. No migration, DCR or CIMD added.
- Updated local /Users/D025449/.codex/config.toml for existing woa_training only:
  oauth.client_id=woa-codex, callback_url=http://127.0.0.1/callback. No secrets,
  bearer token or unrelated settings changed. Installed CLI no-browser probe
  verified the actual client/callback/resource/S256 request, then stopped before
  login/consent/token issuance. CLI get omits OAuth fields; probe confirms use.
- All 968 tests passed with approved temporary local ports; 14 focused MCP tests
  passed. Syntax, zero-warning lint, types and diff checks passed. Setup/client
  JSON and login command are in docs/mcp-server.md. The server client must be
  appended to production configuration after the new code is deployed. Neither
  production client configuration nor code deployment/restart was performed in
  this slice. Actual user consent, tools and refresh remain pending that rollout.

## Production MCP Setup Check (2026-11-10)

- User chose production at https://cwa24.de, confirmed saving MCP settings and
  subsequently confirmed performing the app restart. No assistant restart or
  deployment. SSH read-only checks found MCP code, matching origin and the
  configured woa-chatgpt client with a valid secret-digest format and the official
  issuer-aware ChatGPT callback. No secrets/digests were printed or recorded.
- Public resource and authorization-server discovery returned HTTP 200 with
  matching resource/issuer, PKCE S256 and issuer-response support. Unauthenticated
  /mcp returned HTTP 401 with resource_metadata and no-store. A read-only schema
  query on the active production DB found both MCP tables and consent_hash. This
  does not verify all migration constraints or a successful token exchange.
- Next: user connects ChatGPT using OAuth/client ID woa-chatgpt and the privately
  generated client secret, grants WOA consent and exercises tools/revocation.
  Mac availability and actual ChatGPT OAuth remain unverified. Approval-review
  stream failures on individual read checks resolved on retry.

## Hosted Training MCP And OAuth (2026-11-10)

- User approved hosted read-only MCP with existing WOA login/consent, six tools
  and revocable profile connections. Target order: ChatGPT Mac, then web;
  Mac-specific availability and actual connection remain unverified.
- Added opt-in /mcp (SDK 1.32.2, stateless Streamable HTTP/JSON), OAuth discovery,
  predefined exact-redirect public/confidential clients, mandatory PKCE S256 and
  resource/issuer binding. Five-minute codes, access at most 15 minutes, rotating
  optional refresh and five active grants with fixed 90-day lifetime. Hash-only
  storage, replay revocation, unique consent nonces and live account/grant checks.
- Six scoped tools reuse owned REST services and Redis limits; bounded request/
  response/SQL/concurrency. No GPS/FIT, training writes, model calls or server
  OpenAI key. Profile consent/list/revoke uses browser session/CSRF and escaped
  UI; German/English strings with English fallback in the other four locales.
- Prepared migration 099_mcp_oauth.sql; not executed. Its tables also become
  prerequisites for updated final account deletion, which removes grants/tokens.
  Setup, scopes, TTL, retention, manual rollout and client limits are in
  docs/mcp-server.md; README, user-settings and npm-scripts links updated.
- Full sandbox test run: 964 tests, 945 passed, 19 failed exclusively at blocked
  local listen (EPERM). Final focused MCP suite: 12/12 passed, including real SDK
  protocol, in-memory Node HTTP/Express, consent/CSRF, token rules/rollback/replay,
  scope/owner separation, safe failures and actual browser-module behavior.
  Syntax, zero-warning lint, types and diff checks passed. Automatic approval
  review repeatedly failed with stream-disconnection when requesting real test
  ports, including a user-authorized retry; no such retry was executed.
- Live DB constraints/concurrency/proxy, real network transport, ChatGPT OAuth/
  Mac/web and full profile visual layout remain unverified. No migration,
  deployment, normal service restart or commit. Existing analytics changes kept.
  Expired/revoked grant retention has no scheduled cleanup; define before scale.

## Public Recorded Power Profile And FTP History (2026-11-10)

- User confirmed migration 098 and the initial analytics API smoke test, then
  requested continuation of the agreed second slice. Added GET
  `/api/v1/analytics/power-profile` and `/ftp-history`; OpenAPI v1.3.0. No new
  migration/scope or automatic key upgrade. Target/exercised initial requests
  remain unspecified; no assistant live DB verification.
- Power profile returns stored critical-effort winners for fixed/selected
  durations, Watt/W/kg, source-date weight provenance and source workout IDs/
  offsets. Requires both analytics and workout read; ties preserve microseconds
  and BIGINT precision. Missing durations return null without recomputation.
  Manual modeled activities and non-critical segments never supply records.
- FTP history uses the existing CP8/CP15 continuous-p95/log-extrapolation method
  on UTC week/month/quarter/year buckets, default month. Returns explicit method,
  anchor counts, partial periods and null missing estimates; confidence is an
  effort count, not probability. Requires analytics only. It is distinct from
  browser rolling FTP and summary/load yearly interpolation.
- Both use owned classified cycling scalar queries, read-only repeatable-read
  snapshots, 50,000-effort/1-MiB/5-second SQL limits, bounded winner-date weight
  lookup and the existing shared analytics concurrency/request buckets. No stream
  or GPS access. Updated six-language analytics disclosure. Details and curl:
  `docs/public-api-v1.md`; profile: `docs/user-settings.md`.
- All 954 tests, syntax, zero-warning lint, types and diff checks passed. New tests cover
  winners/zero/missing data, exact IDs/timestamps, weight fallback/provenance, FTP
  percentiles/anchors/calendar clipping, bounded owner SQL, rollback, scopes,
  HTTP buckets and exact OpenAPI fields. A synthetic 50,000-effort build returned
  13 power points/46 weekly FTP buckets in 67 ms (3,464/8,904 bytes).
- Live new-endpoint data/query plans and real weight/source matching remain
  unverified. No assistant DB operation, migration, deployment, normal service
  restart, dependency/npm-script change, commit or MCP implementation.

## Public Analytics Summary And Training Load (2026-11-10)

- User approved the first analytics slice: GET `/api/v1/analytics/summary` and
  `/training-load`. Implemented before browser sessions with independent
  `analytics:read`; no workout IDs/GPS/raw samples. Power-profile/FTP-history
  endpoints were subsequently implemented above; MCP remains deferred. Existing
  keys retain their permissions.
- UTC dates: inclusive `from`, exclusive `to`, 1-366 days; default latest 28
  calendar days including partial today. Owned imported non-motorsport workouts
  and all manual activities contribute volume; classified imported cycling and
  manual cycling contribute known TSS. Estimates, missing TSS/duration and
  non-applicable activities have explicit coverage fields.
- Reused the existing 42/7-day daily-rounded load recurrence with full bounded
  history, rest days through the end and updated-day TSB. Missing TSS contributes
  zero with history coverage flagged; no known TSS means null load. Yearly FTP
  uses UTC interpolation and no pre-first-year fallback. Browser analytics and
  the known coaching last-7/28-activities issue were not changed. Semantics,
  budgets, setup and curl examples: `docs/public-api-v1.md`; contract:
  `docs/public-api-v1.openapi.json` v1.2.0; profile: `docs/user-settings.md`.
- Added opt-in six-language analytics selection, including analytics-only keys.
  Prepared `src/migrations/098_user_api_keys_analytics_scope.sql`; user confirmed
  manual execution and a successful API smoke test on 2026-11-10. Target and
  individual exercised requests were not specified or independently verified. Never execute
  migrations through the assistant. Scope validation preserves GPS/FIT dependencies.
- Bounded owned scalar queries use one read-only repeatable-read snapshot,
  50,000 combined history rows, 500 FTP rows, 20,000 history days and 1 MiB JSON.
  Two concurrent computations/connections per process, dedicated pool with
  5-second connection wait and SQL statement limits; shared Redis analytics
  10/minute/user plus existing ingress/user buckets. No silent truncation.
- All 945 tests, syntax, zero-warning lint, types and diff checks passed. Tests
  cover calendar/UTC boundaries, manual/missing/zero data, historical/rest-day
  load, SQL ownership/budgets/rollback/capacity, scope combinations, issuance,
  HTTP isolation/errors and all-six-language rendering. A synthetic maximum
  50,000-row/20,000-history-day build produced 366 days/124,404 bytes in 38 ms.
- Isolated actual EJS/CSS/browser-module fixture verified unchecked analytics,
  independent selection, disabled issuance with no scopes, simulated analytics-only
  issuance, unchanged old key scopes, secret masking/erasure and no console errors.
  Full profile layout, real credential issuance and live API data are not verified.
- No live PostgreSQL operation, assistant migration, deployment, normal service
  restart, dependency/npm-script change or commit. Live query plans/data and
  real-session/proxy verification remain open.

## User-Confirmed Local FIT Test (2026-11-09)

- User reported successful localhost FIT download (55,011 bytes) and successful
  file access. This confirms that local smoke test, not a complete contents or
  production verification. Migration 097 execution was not separately confirmed.

## Public Single-Workout FIT Download (2026-11-09)

- User approved GET `/api/v1/workouts/{id}/export.fit` and explicit
  `workouts:fit:read`, requiring both workout/GPS read scopes. Existing keys keep
  their permissions; FIT issuance is opt-in with six-language profile controls.
  Analytics remains deferred.
- Implemented owned, bounded source/lap queries and isolated FIT workers using
  the existing generator, stored device fallback, NP/calories and manual/interval
  laps. GPS gaps retain sample timing. Downloads are regenerated, not original
  uploaded bytes. Worker/byte/record/lap and shared-user request limits fail with
  safe JSON errors. Contract, budgets and curl instructions:
  `docs/public-api-v1.md`, `docs/public-api-v1.openapi.json`; profile details:
  `docs/user-settings.md`. Existing browser download was not changed.
- Prepared `src/migrations/097_user_api_keys_fit_scope.sql`; manual execution by
  the user is still pending. It only extends scope validation, without upgrading
  keys or rewriting workouts. Migration 096 execution was previously user-confirmed.
- All 930 tests, syntax, zero-warning lint, types and diff checks passed. Coverage includes
  generator/codec parity, devices/laps, GPS gaps, source/worker budgets, owned SQL,
  HTTP scopes/errors and actual browser-module behavior. A synthetic maximum
  172,800-record/slot export produced 4,147,515 FIT bytes in 169 ms.
- Isolated actual EJS/CSS/module browser fixture verified FIT prerequisites,
  simulated issuance, unchanged existing scopes, secret masking/dismissal and no
  console errors; screenshot inspected. Initial approval transport failures
  resolved after reconnection. Full profile layout, real credentials, live DB
  constraints/query plans and production FIT data remain unverified.
- No assistant migration, PostgreSQL operation, deployment, normal service
  restart, dependency/npm-script change or commit.

## Public Workout REST Completion (2026-11-09)

- User approved finishing the existing workout REST implementation and explicitly
  deferred Analytics. The three GET endpoints are mounted at `/api/v1` before
  browser sessions, with Bearer scopes, owner-bound projections, encrypted
  pagination and shared-user Redis limits. Earlier documentation lagged behind
  the uncommitted endpoint code; reconciled it and the OpenAPI contract.
- User confirmed legacy upload timestamps were stored in UTC. SQL now interprets
  `uploaded_at` explicitly as UTC, independent of the database session timezone.
  Unknown classifications use schema fallbacks; only road/mountain/indoor receive
  derived load metrics. No stored workout data was changed.
- Added API-local structural checks for GPS2 layouts 1-4, preventing the shared
  decoder's incomplete-block tolerance from fabricating zero coordinates. Fixed
  GPS error responses retaining the success GeoJSON content type; errors use JSON.
  Hardened limiter response validation. Limits and rollout details are in
  `docs/public-api-v1.md`; profile documentation is aligned.
- All 919 tests, syntax, zero-warning lint, types and diff checks passed. Expanded
  tests cover OpenAPI fields/references, UTC/filter/cursor rules, codecs/gaps,
  corrupt GPS, slot/response/time/capacity boundaries and HTTP/auth failures. Real
  isolated Redis Lua verified concurrent shared-key limits, separate users,
  pruning/TTL, Retry-After and outage; the temporary instance was stopped.
- User confirmed a successful manual API test on 2026-11-09 after receiving
  the curl test instructions. Environment and individual exercised endpoints/
  error cases were not specified; do not treat this as full live-matrix verification.
- PostgreSQL constraints/concurrency/query plans, production GPS distributions
  and real-session/proxy integration remain unverified. The user subsequently
  confirmed manual execution of migration 096 on 2026-11-09; the target environment
  was not specified and execution was not independently verified by the assistant.
  No assistant PostgreSQL operation, migration, deployment, normal service restart,
  dependency change or commit.
  No Analytics endpoint/scope or MCP server was added.

## Personal API Key Management And REST Contract (2026-11-09)

- User approved REST with personal API keys/scopes, a broad allowlist of elementary
	workout metrics including NP, TSS, IF and their FTP basis, without large blobs
	or internal fields. Analytics GET is a confirmed later requirement, not a V1
	endpoint or currently issuable scope.
- Added `docs/public-api-v1.md` and `docs/public-api-v1.openapi.json`: three owned
	imported-workout GET paths, a shared 34-field list/detail schema, cursor paging,
	separate GPS access requiring both workout scopes and explicit account/key rules.
	No general user-role redesign. Manual/shared activities and writes are deferred.
- User subsequently approved the key-management slice, including five active keys
	and 90-day validity. Implemented hash-only key storage/lookup, scope validation,
	isolated `req.apiAuth`, live account/expiry/revocation checks, browser-session-only
	management with CSRF/same-origin checks and final-deletion integration.
- Added six-language management in `/profile#api-keys`: create, safe metadata,
	one-time masked/revealable/copyable secret and confirmed revoke. No browser
	persistence of secrets. Active keys precede bounded history. Pending deletion
	disables issuance but permits existing reads/revocation.
- `src/migrations/096_user_api_keys.sql` was prepared for manual execution;
	the user subsequently confirmed execution on 2026-11-09 (target unspecified,
	not independently verified). The table is also required by final account deletion.
	No assistant DB operation, deployment, normal service restart, dependency change
	or commit performed.
- All 903 tests, syntax, strict zero-warning lint, types and diff checks passed.
	Isolated EJS/browser checks covered creation/scopes, literal HTML-shaped names,
	secret dismissal, confirmed revoke, pending deletion, quota, outage/retry and
	desktop/mobile layout. Live SQL constraints/concurrency and real-session/proxy
	integration remain unverified. Details: `docs/public-api-v1.md` and
	`docs/user-settings.md`.
- OpenAPI/schema validation previously passed for the draft data contract. Public
	workout/GPS routes and their limits were subsequently completed in the section
	above. Analytics and MCP remain deferred; no analytics scope is issuable.

## Zero-Warning Lint Cleanup (2026-11-09)

- User approved removal of all 70 unused-variable warnings and a zero-warning
	release gate. Removed dead imports, bindings and private helpers across server,
	browser and shared code. Preserved constructor/module initialization and the
	four-argument Express error-handler signatures; no ESLint rule was disabled.
- Removed unused historical compact encoders and ineffective internal encoder
	selection options. Public exports and legacy readers remain; both WOA creators
	already use WS11. See `docs/woa-workout-stream-format.md`.
- `check:lint` now uses `eslint src --max-warnings 0`; `check` and release inherit
	this limit. Verified clean success and exit 1 for one stdin-only warning, without
	creating a probe file. See `docs/npm-scripts.md`; README link remains valid.
- All 892 tests, syntax, strict lint (zero warnings/errors), types and diff checks
	passed. Twelve comparisons against Git HEAD using `sample.fit` produced identical
	WOA bytes: sync/async, three GPS encodings, identity/gzip and legacy option keys.
- The incomplete segment-delete route received only unused-binding cleanup, not
	a functional repair. No live UI smoke test, live DB change, migration, deployment,
	commit or normal service restart performed.

## Map Cleanup Export Fix (2026-11-09)

- Fixed the module-load failure that stopped the release test gate: exported
	`mapCatalogRegions` and `findMapRegionHits` from the existing provisioning
	logic and reused them in planning. Cleanup and planning now share catalog
	validation and geographic intersection rules; retirement safeguards remain
	unchanged. See `docs/workout-map.md`.
- All 89 focused map tests and all 892 full-suite tests passed, including
	geographic retirement protection. `npm run check` and `npm run check:types`
	passed; lint then reported 70 warnings, resolved in the cleanup above. No deployment,
	commit, migration, production archive operation or service restart performed.

## Workout Dashboard Cycling Type Group (2026-11-09)

- User approved **Radsport** immediately after All types, grouping only road,
	mountain and indoor, excluding unknown and motorsport. Existing individual
	options remain; this adds no stored workout classification.
- Updated custom/native menus, browser selection/restoration/labels, six locale
	files and existing server view-preference validation (`workoutType: cycling`).
	Query builder accepts a bounded validated type list using parameterized ANY;
	the combined workout/manual feed applies it to both branches and count/summary.
	See `docs/user-settings.md#workout-dashboard-type-group`.
- All 47 focused browser-state/preference/query/feed tests passed. Full suite and
	global types were initially blocked by unrelated missing map cleanup exports;
	resolved in the separately approved Map Cleanup Export Fix above.
	Scoped syntax/lint passed with one pre-existing unused-import warning. Isolated
	actual EJS filter/browser module at desktop1365/mobile390 verified menu order,
	exact type list, individual type changes, restored selection and labels; no
	page overflow or JS errors, screenshots inspected. Preview uses local fixture
	persistence, not a live authenticated preference save or DB query; server
	preference/feed tests use existing offline mocks. Preview retained at port64275.
	No migration, DB data change, dependency, deployment or normal service restart
	performed.

## Imported Regional Map Demand And Optional Downloads (2026-11-06)

- User approved durable demand plus import-triggered background planning and
	optional automatic downloads. No monthly transfer or per-region size quota;
	use finest direct catalog regions and existing 50%-volume/100-GiB storage cap.
- Successful single/bulk GPS inserts dispatch debounced `maps-demand` after
	persistence/COMMIT without awaiting work. Existing serial Ops queue, separate
	deduplication key, three attempts with exponential backoff. Dispatch is
	best-effort, not a transactional outbox; admin scan recovers missed jobs.
- Private atomic `map-regional-demand.json` preserves aggregate demand, including
	unsupported regions, beyond queue retention. Admin scan/prepare records it via
	explicit `--record-demand`; plain CLI plan remains read-only. Durable display
	never grants manual approval; fresh manual job and confirmation still required.
- `WOA_MAP_AUTO_DOWNLOAD=1` opts in (default off); only local provider. Automatic
	planning has no parent escalation. Incomplete plans/capacity and existing bad
	archives block automatic downloads. Missing regions use validated immutable
	versions/atomic activation/rollback; updates remain manually approved and
	successful/legacy thumbnails are preserved. See
	`docs/workout-map.md#imported-regional-demand-and-optional-automatic-downloads`
	and `docs/npm-scripts.md` for operations and limitations.
- All 868 tests passed, including 90 focused map/admin/import-conflict tests.
	Real offline CLI checks cover default-off, failed download with no activation,
	versioned installation and reuse without archive GET. Types/editor checks passed
	after correcting the new JSDoc option. Full syntax and scoped lint passed with
	two pre-existing unused-import warnings. Actual EJS/module browser checks with
	simulated APIs at desktop1365/mobile390 verified durable/unsupported display,
	auto on/off status, fresh-scan/explicit-confirmation gating, reset on reload,
	no page overflow and no JS errors; screenshots inspected. Direct CDP viewport
	override was needed because integrated Playwright viewport sizing was inaccurate.
	Isolated preview retained on port52451; normal Dev services were untouched.
- No migration, DB data write, real Redis/import job, provider archive download,
	deployment, normal service restart or environment-file change was performed.
	Safe archive retirement, periodic demand reconciliation, import outbox and UI
	cancellation remain open; full demand scans can delay Ops backups. Storage or
	crash failures can leave a stale demand snapshot; next import/admin scan recovers.

## Versioned Map Installation And Rollback (2026-11-05)

- User confirmed the metadata check now runs in operation and approved manual
	versioned installation, atomic activation and one rollback target. Added
	`map-archive-set.json` with active/previous sets and immutable version paths;
	legacy root archives remain readable until the first versioned installation.
- Downloads preserve active files, validate exact approved GET metadata/length,
	SQLite/Shortbread and current workout viewport coverage, then record SHA-256,
	file identity and source metadata before atomic synced manifest activation.
	Worker revisions follow the active set; active work finishes and successful
	stored thumbnails remain unchanged. No unattended update installation.
- Rollback verifies stored hashes/file identity, full SQLite validation and current
	coverage before switching the pointer. Both actions need explicit same-origin
	admin approval and the expected active identity. Install approvals expire after
	one hour; private snapshots use bounded stdin to the existing isolated CLI.
	Pointer/status reads remain available with a missing active version file so a
	verified previous set can recover it; the renderer still rejects that bad set.
- All versions, staging files and manifests share the 50%/100 GiB budget and
	prepare/storage locks. One previous set is referenced; older/orphaned files are
	protected, not automatically deleted, and continue counting toward the budget.
	Durable regional demand tracking and verified archive retirement remain open.
- All 861 tests passed, including 94 focused map/admin/EJS/CLI tests; full types
	and editor checks clean. Touched code is lint-clean after removing one obsolete
	import; the initial full lint run otherwise had the 70 pre-existing warnings.
	Tests include real BullMQ Jobs and real offline CLI subprocess stdin, stale
	approval, changed GET validators, invalid SQLite, missing coverage, stale
	activation and corrupted rollback targets. Desktop1365/mobile390 browser checks
	with simulated APIs verified explicit actions, busy/reset states, icons, long
	IDs and no page overflow; screenshots inspected. Isolated preview at port60511
	retained. No live Redis job, upstream download, production archive activation,
	deployment, normal service restart, schema change or migration was performed.

## Map Update Job Redis Access Fix (2026-11-05)

- User reported a failed manual update check and approved the fix. Reproduced
	locally with a real BullMQ Job: `job.client` does not exist, causing failure
	before metadata access. Corrected the service to use `job.queue.client`.
- Replaced the misleading plain-object Job mock with the installed BullMQ Job
	class and an offline queue/client stub; checks now cover report persistence and
	progress without inventing a Job client property or opening real connections.
- All 854 tests passed, including 12 focused admin/update cases. Full typecheck,
	touched-file syntax/lint, editor diagnostics and diff checks passed. No live
	Redis/upstream/server test, deployment, restart or migration was performed.
	The updated Ops worker must be deployed before retrying the manual check.

## Map Update Metadata Monitoring (2026-11-05)

- User approved monthly metadata checks plus an explicit admin action, without
	automatic archive download/replacement. Ops worker registers one BullMQ schedule
	for the first of each month at 03:00 UTC when the local provider is enabled;
	when disabled it removes that scheduler. Startup only registers the schedule.
- Added read-only local archive inventory and official catalog/page/HEAD checks,
	strong ETag/valid HTTP-date comparison, ten-minute overall deadline and a maximum
	of 16 archives. No SQLite scan, workout DB access, cache cleanup or file writes.
	Size alone, contradictory size/tag signals, weak-only tags and absent metadata
	are inconclusive. Per-region failures are safe and preserve comparison anchors.
- Redis stores the first usable observation per unchanged local file beyond job
	result retention; changes stay latched until the local fingerprint changes.
	This is upstream observation, not installed-version proof: existing local archive
	versions remain explicitly unverified. Redis loss resets observation history.
	Versioned installation/activation/rollback remains the next separate stage.
- Added same-origin admin `POST /updates` and a separate updates table; update jobs
	cannot become demand snapshots or download approvals. Both use the serial Ops
	queue; only manual jobs use the shared map deduplication key. Future delayed
	monthly jobs neither hold that key nor mark the Admin UI busy. No new npm script, dependency,
	environment variable or migration. Updated map and npm operations documentation.
- All 854 tests passed, syntax/lint passed with 70 existing warnings, typecheck
	and relevant editor diagnostics clean. Actual EJS/map controller preview checked
	at desktop1365/mobile390 with mocked reports: five states, icons, no page-load
	job, one explicit request, busy lockout/progress and no page overflow; screenshots
	inspected. New isolated preview on port59197 retained; normal Dev untouched.
	No live Redis scheduler, upstream requests, production archive modification,
	deployment, normal service restart or migration was performed by Copilot.

## Shared Map Storage Budget (2026-11-05)

- User approved a shared archive/raster budget: at most 50% of total volume size,
	capped at 100 GiB. Split volumes each retain the 50% ceiling with 100 GiB combined.
	New central service counts configured roots once, including partials/rollback
	files; unknown capacity/internal symlinks fail closed. Dedicated private roots
	and matching configuration are required across cooperating processes.
- Downloads and optional cache writes share `.maps-storage.lock`; peak remaining
	bytes and refreshed HEAD sizes are checked plus 5%/256 MiB free-space reserve.
	Oldest recognized completed raster files may be evicted across namespaces.
	All archives, rollback files, unknown files and partials stay protected. Cache
	pressure/busy locks still permit rendering into RAM. No periodic GC or automatic
	archive retirement; killed processes can leave a lock requiring verified cleanup.
- Read-only plans/Admin show usage/limit and block approval if cleanup cannot make
	room; completed prepare reports refreshed usage. No new script, dependency, env
	setting or schema change. Updated map/npm docs; future versioned updater/rollback
	and permanent/import-triggered regional demand remain separate follow-ups.
- Follow-up increased the approved volume share from 30% to 50%, retaining the
	100 GiB cap and free-space reserve. All 57 provisioning/storage tests passed,
	including rounding, the 200 GiB cap threshold and split-volume enforcement.
	No deployment or production cleanup was performed.
- Initial implementation verification: all 846 tests passed (79 focused), syntax/lint passed with 70 existing warnings,
	typecheck/editor checks clean. Tests cover protected data, split/nested roots,
	global cache LRU, locks, pre-GET rejection, HEAD growth and RAM-only rendering.
	Actual EJS/module browser checks with mocked reports at desktop1365/mobile390
	verified budget labels, blocking/cleanup approval and single-line values without
	overflow; screenshots inspected. Existing isolated preview retained. No actual
	production cleanup/download, DB data write, migration, deployment or Dev restart.

## Admin Navigation Matches User Settings (2026-11-05)

- User approved seven local admin areas: Users and roles (default), Map material,
	Database, System backup, Accounts, Segments and Workouts. Main heading is now
	Administration. Same 200 px desktop navigation/mobile select as user settings;
	only the active panel is shown. Existing control IDs and APIs are unchanged.
- Added `admin-facets.js` for fragment/history navigation. Descendant links such
	as `#local-map-management` still work; invalid fragments fall back to Users.
	Panels/forms remain mounted, preserving selections, approvals and job updates;
	all areas/native links remain available if navigation JS fails. No profile
	controller changes. See `docs/user-settings.md#administration-navigation`.
- All 838 tests passed, including new navigation and rendered-EJS structure tests.
	Syntax/lint passed with 70 existing warnings; full typecheck/editor checks clean.
	Actual full EJS and controllers browser-tested with simulated read-only APIs:
	all seven areas desktop1365/mobile390, history, descendant/invalid links, file
	selection retention and script-unavailable fallback. Screenshots inspected,
	no page overflow. Isolated preview left running for user inspection; normal
	Dev backend untouched. No real backup/restore, DB data write, migration or deploy.

## Fast Admin Map Inventory Scan (2026-11-05)

- User approved separating the slow full archive scan from admin demand checks.
	Admin `maps-scan` now invokes `plan --quick`: stable file metadata, vector-format
	metadata and one Shortbread tile sample, without SQLite `quick_check`.
	Ordinary CLI plan/prepare retain full validation; prepare rejects `--quick`.
- UI distinguishes sampled archives from integrity-checked files and reports
	untested tile coverage as unknown, not zero missing tiles. Sample inspections
	never seed the full-inspection reuse cache, including direct preparation.
	Catalog/network discovery and geometry planning remain; no production timing
	measurement or live authenticated Ops verification yet. No persistent cache.
- All 836 tests passed (57 focused admin/provisioning checks), syntax/lint passed
	with 70 existing warnings, full typecheck clean. Real isolated CLI regression
	verifies quick scans skip `quick_check`; full prepare checks remain covered.
	Actual EJS section/module browser-checked at desktop1365/mobile390 with mocked
	reports: both integrity labels, unknown coverage, approval, no page overflow.
	Screenshots inspected; isolated server stopped. Updated map/npm docs. No
	migration, DB data write, deployment or normal Dev/production restart.

## lastEnd Type Errors Resolved (2026-11-05)

- User approved a minimal fix in `MicroIntervalDetector`: snapshot closure-mutated
	`lastEnd` as `const previousEnd` for the null guard and arithmetic. No threshold
	or detector behavior changes; prior uncommitted lifecycle/admin work preserved.
- Full `npm run check:types` now passes without errors. All 23 microinterval tests,
	detector syntax, targeted ESLint and editor diagnostics pass. Full test suite
	not rerun for this fix. Updated microinterval guide; older type-error notes
	below describe historical verification. No DB write, migration, deploy/restart.

## Local Map Administration: Demand And Manual Provisioning (2026-11-05)

- User approved continuing with the next lifecycle stage. Added map management
	to `/admin/accounts#local-map-management`: region status/size/workout counts,
	download/free-space summary, explicit scan, confirmation and missing-region
	provisioning, job phases/percentages and safe errors. Page load starts no job.
- Jobs reuse the Redis-backed backup Ops queue/worker, serially with backups.
	Map CLI runs in a separate process, preserving read-only inventory, validations,
	runtime DB pointer and download limits. Approval is bound to a <=1h completed
	snapshot and exact region IDs; CLI `--approved-regions` refuses newly missing
	unapproved regions before GET. No schema migration or new worker process needed.
- New protected map endpoints require admin access, matching Origin host for
	mutations, no-store results and shared BullMQ deduplication. Snapshots follow
	existing Ops result retention, not a permanent per-region ledger. No automatic
	import/page-load scan, monthly updater, versioned rollback or global GC yet.
	Downloads need a running Ops worker; no UI cancel implemented and an orphaned
	CLI child is possible if its parent is killed. See map operations docs.
- All 833 tests passed (54 focused admin/provisioning cases), syntax/lint passed
	with 70 existing warnings, editor checks clean; only three known `lastEnd`
	type errors remain. Actual EJS/browser flow checked at desktop1365/mobile390
	using simulated API jobs: gated commands, progress, completed status, icons,
	no automatic jobs or page overflow. Isolated test server stopped afterwards.
	No normal Dev backend restart, production/Redis operation, real map download,
	deployment or migration by Copilot; live authenticated Ops job remains untested.

## Local Map Lifecycle: Fallback Recovery Foundation (2026-11-05)

- User reported successful production preparation: eight archives, 3,236 GPS
	workouts, 2,704 missing thumbnails, zero missing tiles and ready to activate.
	Provider activation/live rendering remain unverified; Copilot did not access
	production. Earlier unknown-preparation entries below are historical.
- User approved staged lifecycle design: nonblocking imports/route fallback,
	deduplicated regional demand and initial admin approval, monthly update checks,
	staged/versioned activation with one rollback set, global storage cleanup and
	preservation of successful/legacy images. See `docs/workout-map.md` for the
	distinction between implemented behavior and accepted follow-up requirements.
- Implemented first stage only: new local SVG fallbacks persist state, inventory
	revision and retry count in the existing thumbnail row. Missing coverage waits
	for a revision change; temporary failures get three attempts (5m/15m waits,
	then hold) until revision change/explicit replacement; unsupported geometry
	does not auto-retry. Successful and unmarked legacy images remain unchanged.
- Inventory identity uses local file metadata, memoized for 5s, with no network
	or SQLite scan. Workers reopen between jobs after changes; active work finishes.
	Existing source-versioned raster cache avoids stale reuse. No upload/view
	downloads, schema change, migration, background retry or legacy backfill.
- All 827 tests passed, including 40 focused thumbnail/worker cases; syntax/lint
	passed with 70 existing warnings; editor checks clean. Typecheck retains only
	three known `lastEnd` errors. No deployment, production write, archive download
	or service restart by Copilot. Regional demand/admin UI, monthly scheduler,
	versioned updater/rollback and global cleanup are NOT implemented in this stage.

## Reuse Unchanged Archive Inspections (2026-11-05)

- User confirmed deploying the progress/retry version and supplied planning output
	for 3,236 GPS workouts with seven existing archives; full SQLite inspection was
	visibly slow at Austria. No final production readiness output was supplied.
- User approved removing duplicate full checks for unchanged files within one
	run. Successful inspections now record device, inode, size, nanosecond mtime
	and ctime and verify stability across validation. A private WeakMap associates
	these results with the exact in-memory plan; no disk marker or JSON trust.
- Under the prepare lock, `check-file-state` skips the second `quick_check` only
	for an unchanged successfully inspected file. Changed/replaced/missing files
	and uncached/deserialized plans retain full checks. New downloads remain fully
	validated; coverage, locking, retries and cleanup are unchanged. First scans
	still run on each invocation; no production timing improvement was measured.
- All 820 tests passed, including 48 focused provisioning/CLI cases. Call-count
	tests confirm two unchanged archives receive two rather than four full checks;
	same-size rewrite/replacement, corruption, deletion, ctime-only change and
	serialized-plan fallback are covered. Syntax/lint passed (70 existing warnings),
	editor diagnostics clean; only the three known `lastEnd` type errors remain.
	Updated map/npm documentation. No production access, deployment, restart,
	actual map download or migration by Copilot. User deployment/new run required.

## Map Preparation Progress And Bounded Size Refresh (2026-11-05)

- User supplied production rejection for Lorraine: HTTP 200, planned/HEAD
	248553472 bytes versus GET 248664064 bytes, no encoding, body present. The
	discrepancy is confirmed; upstream update/cache inconsistency remains an
	assumption. Six completed archives were reported. Latest process listing had
	no match; no final success/readiness output has been supplied.
- User explicitly approved visible phases/download progress and bounded metadata
	refresh. Implemented stderr updates for DB/catalog/plan, archive discovery and
	both inspection passes, reuse, attempts, byte percentages, verification,
	installation and coverage counters. JSON stdout remains separate. No idle
	heartbeat or within-archive SQLite percentage; synchronous checks remain.
- Pure positive safe-integer GET size mismatch now cancels the response, refreshes
	HEAD (30s, no-store), rechecks full remaining space/margin and retries GET
	(no-store). Maximum three GET attempts/two refreshes, sharing the existing 2h
	archive deadline. HTTP/body/encoding failures are not retried; exact stream
	length, SQLite and Shortbread validation remain mandatory. Valid files reused;
	initial plan estimates unchanged. Changes apply only after user deployment.
- All 812 tests passed, including 40 focused provisioning/CLI cases (successful
	refresh, retry exhaustion, bad metadata/disk/content, cancellation, progress,
	actual subprocess JSON/stderr). Syntax/lint passed with 70 existing warnings;
	editor diagnostics clean, only the three known `lastEnd` type errors remain.
	Updated map workflow and npm-script docs. No production access, deployment,
	service restart, actual map download or migration by Copilot.

## Map Download Response Diagnostics (2026-11-05)

- User reported a complete production plan: 3,236 GPS workouts, 2,704 missing
	thumbnails, eight archives/3.93 GiB, 23.57 GiB free. Prepare repeatedly rejected
	an archive response; actual cause/archive remain unconfirmed. The local public
	Alsace HEAD/GET check matched, not evidence of the response received by EC2.
- User approved local diagnostic expansion only. Rejections now identify safe
	archive ID, HTTP status, expected/GET-reported bytes, body presence, normalized
	encoding and specific reasons. Raw unknown headers/body/URLs are not exposed.
	Response checks, cancellation, cleanup and valid-archive reuse are unchanged.
	No progress indicator or relaxed validation was added.
- All 797 tests passed (25 focused provisioning/CLI cases), syntax/lint passed
	with 70 existing warnings; changed files have no editor errors. Only the three
	known `lastEnd` type errors remain. Updated command/detail documentation.
	No production access, deployment, service restart, real archive downloads or
	migrations. User must deploy/retry and supply the enriched error for diagnosis;
	keep provider disabled until preparation is ready.

## Map CLI Runtime Database And Diagnostics Fix (2026-11-05)

- User reported a generic production `maps:plan` failure with the correct
	`--env-file .env.production` invocation and approved a local-only correction.
	The original production cause remains unconfirmed; no remote access/retry.
- CLI now reuses PM2's active-database resolver. Production filename selects
	production mode when no explicit NODE_ENV is in the file; custom filenames
	require NODE_ENV=production. Development does not read the production pointer.
- Failures expose controlled stage/allowlisted code, never raw connection messages,
	stacks, credentials or URLs. Added internal `node --` argument separation after
	reproducing Node 26 consuming a missing --env-file before the script ran.
- All 790 tests passed, including 18 provisioning/CLI tests with temporary
	pointers, simulated connect/read failures and real early-error subprocesses.
	Syntax/lint passed (70 existing warnings); no editor errors in changed files.
	Only three known `lastEnd` type errors remain. No deployment, production access,
	service restart, real archive downloads or migrations by Copilot.
- Updated `docs/workout-map.md` and `docs/npm-scripts.md` with runtime selection,
	unchanged operator commands and safe stage/code troubleshooting.

## Manual Production Map Provisioning Commands (2026-11-05)

- User approved `maps:plan` and `maps:prepare` for manual use after SSH login,
	initially implemented/tested locally only. User reports production environment
	settings entered; Copilot did not inspect/change production or deploy anything.
	Keep the local provider disabled through deployment until prepare reports ready,
	otherwise missing-map fallbacks could be persisted before provisioning.
- Commands require explicit `--env-file`, support `--json`/`--help`, and select
	all valid-GPS workout boxes in an explicit READ ONLY transaction. No track decode,
	DB writes, migrations, image generation, environment edits or service restarts.
	Shared Mercator viewport math includes padding and complete edge raster tiles.
- Added Turf/HTML parser dependencies with locked versions. Official Geofabrik
	polygons, HTML archive links and HEAD sizes drive the plan; unavailable child
	extracts use supported parents. Geometry differences eliminate false failures
	from redundant overlapping aggregates (real catalog contains DACH).
- Prepare reuses valid archives, locks the data directory, checks space and the
	16-file renderer limit, validates unique partial downloads (length/SQLite/vector
	sample), then atomically installs them. Checks every required viewport tile before
	reporting readiness. Safe retries preserve completed/valid files. Stale crash
	locks/parts, archive updates and >16-region consolidation remain manual.
- Actual Dev plan: 3,225 GPS workouts, 2,986 missing thumbnails, zero missing/
	unsupported bounds or unmapped workouts. Eight regions: Alsace, Austria, BW,
	Bayern, Franche-Comte, Hessen, Lorraine, Rheinland-Pfalz. BW/Hessen reused;
	six missing archives total 3,233,480,704 bytes (3.01 GiB). No additional real
	archives downloaded; download/prepare checks use temporary small fixtures.
- All 786 tests passed, including 20 focused planning/provisioning/renderer tests.
	Syntax/lint passed (70 existing warnings); new modules have no editor errors.
	Only the three known `lastEnd` type errors remain. Production-style dependency-
	resolution dry-run and whitespace checks passed. No Linux ARM64 test.
- Production sequence, env settings, command effects/exits/recovery and verification:
	`docs/workout-map.md` (Production Planning And Preparation Over SSH), linked
	from the updated command table in `docs/npm-scripts.md`; README link remains.
- The assistant-managed Dev backend was stopped at user request after the earlier
	integration check. Do not start it automatically; the user manages restarts.

## Local On-Demand Thumbnail Integration (2026-11-05)

- User approved regular service integration on Dev: preserve existing thumbnails,
	generate/persist only missing ones near the workout-list viewport. Existing API
	candidate flags, authenticated routes and advisory-lock/commit storage are
	reused. Explicit GPS edits still intentionally replace their thumbnail.
- Added regular renderer and lazy serial map worker per process (eight outstanding
	requests, 30-second deadline), root dependencies and configurable archives/cache.
	Local mode makes no external map calls; errors/incomplete coverage use persisted
	route-only fallbacks without automatic retries. No automatic style upgrades.
- App/import/backup processes run with local maps on port 3000; port 3001 was
	stopped because the current Cognito registration only supports 3000. User
	confirmed persistent Dev environment entries. BW/Hessen archives remain in
	`tmp/local-map-prototype/data`; cache is `tmp/woa-local-map-cache`.
	Configuration, cache/worker limits and restart instructions: `docs/workout-map.md`
	(Local On-Demand Route Thumbnails), linked from `docs/npm-scripts.md`.
- Real Dev check created missing thumbnail `84965` once (local map, 20,435 bytes),
	verified commit and unchanged content/timestamp on reuse. Existing `85063`
	remained unchanged. No deleted thumbnails, EC2 access, deployment or migration.
- All 771 tests passed, including 32 focused fixture/cache/worker/observer tests.
	Syntax and focused lint passed (one pre-existing unused `os` warning). Typecheck
	has only the three known `lastEnd` errors in `MicroIntervalDetector.js:141`.
	Production-style dependency-resolution dry-run and whitespace checks passed;
	Linux ARM64 remains untested.
- Authenticated live scrolling at `http://localhost:3000/dashboard-new` generated
	and saved missing `84964`/`84963` as local maps; repeated uncached HTTP reads
	preserved content/timestamps. Only 14/96 list images were requested, with the
	far-end entry still untouched. Decode, dimensions, placeholders, nonblank/color
	pixels and desktop thumbnail screenshot passed. Hidden browser documents pause
	observer callbacks; foregrounding the page restored normal behavior.
- Mobile DOM/decode/16:10 size checks passed. Dashboard horizontal overflow was
	observed (546px document at 390px viewport), not fixed in this scope. Mobile
	screenshot automation failed after horizontal scrolling moved the target off
	screen; no mobile screenshot result is claimed. Restored desktop viewport and
	original 24-entry preference. See `docs/workout-map.md` for verification limits.

## Local OSM Thumbnail Prototype (2026-11-05)

- Approved follow-up: reusable 256x256 raster tile cache, still Dev-only. Cache
	keys exclude workout/route and include archive file identity/size/timestamps
	and explicit style version. Atomic JSON entries contain lossless PNGs, label
	candidates and image checksums; labels/routes are placed per final thumbnail.
	RAM LRU is bounded to 16 MiB of estimated cached payload; completed disk entries
	to 128 MiB per active source/style namespace. Previous namespaces remain for
	manual cleanup. Same-process concurrent tile builds are shared.
- Updated preview separates uncached vector rendering, forced tile builds,
	disk reuse after clearing RAM and five RAM repeats. Current Mac results for
	85063/85057/83899: vector 359/581/504 ms, build 401/689/588 ms,
	disk 89/94/58 ms, RAM median 15/17/18 ms (about 24-34x versus vector).
	Six/six/four reusable tiles occupy 1,699,736 bytes total (1.62 MiB).
	New SVGs are 12,325/14,217/20,561 bytes. No cold-OS-cache or EC2 benchmark.
- Four focused cache tests passed: persisted reuse across renderer recreation,
	RAM hits without vector rendering, corrupt-entry recovery, concurrent-build
	sharing, style-version separation, memory/disk limits and offline coverage.
	Desktop/mobile screenshots, nine image decodes, map/route pixel checks and
	no-overlap/overflow checks passed; preview reload made no external requests.
	Mean RGB differences from vector-only previews were 7.07/4.39/5.38 out of 255,
	due to fixed-resolution tile resampling. A raw RGB/RGBA composition mismatch
	found during validation was corrected before the final comparisons.
- During the prototype-only phase, user approved Baden-Wuerttemberg and Hessen,
	not production integration. Isolated artifacts and dependencies are under ignored
	`tmp/local-map-prototype/`; app code, root dependencies and stored thumbnails
	were unchanged at that stage. Later Dev integration is described above.
	Preview: `http://127.0.0.1:3110/` while its server runs.
- Downloaded Geofabrik Shortbread 1.0 MBTiles directly: 560,644,096 and
	427,806,720 bytes, totaling 942.7 MiB. No PBF conversion, Java, Docker or
	production upload. SQLite read-only access plus MVT parsing and Sharp render
	an OSM-like style locally; no external map requests during rendering.
- Initial vector-only baseline for 85063/85057/83899: SVGs 15,525/14,793/21,213 bytes;
	warm medians about 325/568/504 ms across five sequential repeats on this Mac.
	First passes about 371/569/514 ms, not cold-disk measurements. Disabling
	Sharp caches and limiting its concurrency reduced measured end-of-run RSS
	from roughly 1.4 GB to roughly 350 MiB; no peak or EC2 benchmark.
- Passed syntax, SQLite quick_check for both archives, offline rendering in
	Stuttgart/Frankfurt, missing-region rejection, compact output assertions,
	desktop/mobile screenshots, image decoding, nonblank map/route pixels and
	layout checks. Browser reload made zero external requests. Dev route queries
	ran in READ ONLY transactions; no application/database writes or migrations.
- Earlier read-only EC2 inspection found one persistent 30-GB XFS root volume,
	about 24 GB free; PostgreSQL uses `/var/lib/pgsql/data` on it. Proposed future
	map folder `/home/ec2-user/woa-map-data/` was NOT created. No EC2 access or
	changes occurred during prototype implementation. Production performance,
	automated updates and regional fallback remain unimplemented/unverified.
- Setup, measurements, limitations and update proposal:
	`docs/workout-map.md` (Local Regional OSM Thumbnail Prototype).

## Production Lockfile Repair (2026-11-04)

- The user-reported deployment of `70df056` pulled code but failed at
	`npm ci --omit=dev`, before service reload: `sharp` was declared without
	matching lockfile entries. The production process state was not inspected.
- User approved a local-only repair. Regenerated `package-lock.json` with
	`npm install --package-lock-only --ignore-scripts --no-audit --no-fund`.
	Sharp 0.35.5 and Linux ARM64 Sharp/libvips packages are now included;
	retained package versions are unchanged.
- Production-style `npm ci --dry-run --ignore-scripts --no-audit --no-fund
	--omit=dev`, structured lockfile assertions and patch whitespace checks passed
	with Node 26.4.0/npm 12.0.2. This does not verify a clean installation,
	native module loading or Linux ARM64 runtime behavior. No server access,
	commit, deployment, restart or migration performed. User must redeploy.
- Added the manifest/lockfile synchronization requirement to
	`docs/npm-scripts.md` under application operations.

## Production Environment Shortcut (2026-11-04)

- User approved `npm run env:prod` to open `~/woa/.env.production` directly in
	Nano through `ssh -t cwa24-ec2`. No wrapper, dependency or automatic restart.
- Usage, prerequisites, saving/discarding edits and separate service restarts
	are documented in `docs/npm-scripts.md` (Edit the Production Environment).
	The existing README link to the script overview remains valid.
- Verified package JSON, shell syntax, npm command dispatch with an echo-only
	script shell, and patch whitespace. No real SSH session, production environment
	access, restart or migration performed; interactive remote editing is untested.

## Persisted Geoapify Thumbnails (2026-11-04)

- User approved Geoapify integration with the original SVG fallback and explicitly
	required durable reuse. Dev key is configured; production needs its own server
	environment configuration. No key values were printed or committed.
- Implemented self-contained SVGs with 320x200/Q55 WebP backgrounds, Mercator-aligned
	routes, gaps, segment colors and visible attribution. Indoor/non-GPS paths stay
	unchanged. Existing thumbnail storage is reused; no migration is needed.
- All creation paths share per-workout PostgreSQL locking, cache recheck and commit
	before return. Successful style-3 maps remain permanently reusable. Corrected
	frozen fallbacks: retry after five minutes or an embedded later deadline;
	legacy fallbacks use their database timestamp. Browser fallback TTL is 60 seconds,
	with separate `cache=1` URL invalidation; successful maps retain immutable caching.
	Older visual styles regenerate lazily; no bulk job or periodic polling.
- User approved better use of the Free quota: reserve three credits per fixed
	320x200 map attempt, allowing at most 1,000 attempts/day/key and one start every
	600 ms. Explicit lower `GEOAPIFY_DAILY_MAP_LIMIT` values remain effective.
	Six generation jobs may overlap per process, leaving four default pool
	connections for other operations. Existing Redis usage counters are preserved.
	Verified all 763 tests, syntax, service lint and patch whitespace. An isolated
	real-Redis check confirmed 600-ms slots, queue rejection, the 1,000-attempt cap
	and pause enforcement; test keys were removed and no provider request was made.
- Redis guards the shared daily and credit-weighted rate limits, with
	bounded queueing, timeouts, image validation and provider cooldowns. A common
	budget requires the same Redis backend. See `docs/workout-map.md` for limits,
	fallback replacement policy and configuration.
- After a reported timeout on workout 85051, increased network/body timeout to
  15 seconds and the per-workout lock wait to 30 seconds. A single failure now
  defers only that thumbnail; three consecutive failures in a process open the
  shared five-minute pause. Success resets the count; HTTP 429 pauses immediately.
  Existing pauses/deadlines expire normally. No extra live provider call was made.
- Provider failures now emit safe server-console warnings with workout ID, reason,
	HTTP status, consecutive-failure count, global-pause flag and retry time. Fallback SVGs persist reason/deadline without keys,
	URLs or raw exceptions. Closed Redis connections may recover on later retries.
- Verified the correction on Dev workout 85045: expired fallback replaced with a
	16,793-byte map SVG using one request; repeated generation used zero requests.
	Restart running app/workers and reload the library to activate the new policy.
- Three real Dev thumbnails (85063/85057/83899) persisted at 18,440/17,698/14,358
	bytes. Three successful provider requests; repeated reads and a concurrent second
	process made zero additional calls. Preview: `http://127.0.0.1:3109/` while the
	ignored `tmp/geoapify-thumbnail-check.mjs` server runs. Desktop/mobile screenshots,
	image decoding, colored pixels and attribution bounds checked in this fixture.
- All 761 tests passed; thumbnail-service lint passed, earlier route lint has two existing warnings. Types
	retain only the three known `lastEnd` null errors. npm reported eleven audit
	findings; no unrelated fixes. No deployment, migration or production write ran;
	authenticated library workflow and Linux ARM64 Sharp installation remain untested.

## GPS Thumbnail Visual Prototype (2026-11-04)

- User requested a rendered comparison, not production integration. Created a
	disposable local preview at `tmp/workout-map-thumbnail-preview.mjs` (ignored
	temporary artifact), served at `http://127.0.0.1:3108/`. Dev access is read-only;
	no existing thumbnails, application code or migrations were changed.
- Three real routes: workouts 85063 (28.3 km), 85057 (48 km), 83899 (95.2 km).
	Follow-up optimization uses actual UI dimensions measured with original CSS in
	a browser fixture: desktop 152x95 CSS px; mobile 127.98x79.98 at a 360px card
	width, with existing 1.08 image zoom. Preview now renders at these sizes.
- Same Web-Mercator crop, simplified vector route (0.45 logical-pixel RDP,
	one-decimal coordinates, defs/use instead of duplicated paths) and three WebP
	background variants. Recommended 320x200/Q55: 9,621 / 9,346 / 10,779 bytes;
	compact 160x100/Q50: 4,897 / 5,382 / 5,643 bytes. First map draft was
	42,803 / 50,575 / 65,548 bytes. Route-only SVGs remain 2,340 / 3,877 / 3,787.
- Small user-requested browser tile view only; OSM attribution retained and normal
	HTTP caching used. Bulk/static production use still requires provider review.
	Checked desktop 1280x1000 and mobile 390x1100, DPR 1/2, screenshots, decoding
	of all 12 images, nonblank/map-route pixels and no horizontal/caption overflow.
	Cached rebuild timings are not cold production generation timing. No production
	rendering/persistence changes. Details: `docs/workout-map.md`.

## Local Constraint Measurements (2026-11-04)

- User authorized measuring the prepared A/B tables. Local PostgreSQL 16.14,
	6,142 valid baseline ranges, eight real payloads (233-17,061 bytes). Warmed,
	alternating order; 128 measured statements per scenario/variant, plus four
	parallel writers in four rounds for one-user and two-user disjoint ranges.
- Server execution p50 without/with exclusion: fresh insert 0.136/0.155 ms
	(+14%); ten-row batch 0.652/0.948 ms (+45%); exact duplicate 0.059/0.060 ms.
	Shifted overlap: baseline inserts at 0.148 ms; exclusion skips at 0.074 ms.
	Parallel throughput is noisy and not a production-capacity estimate.
- All test writes rolled back; benchmark-only VACUUM/ANALYZE between scenarios
	and concurrent rounds. Full-row fingerprints, counts, all three identity
	sequences and benchmark index/constraint definitions verified unchanged.
	Physical benchmark storage/WAL did change. No migration or production access.
- This measured server-side INSERT SELECT, not full upload, network payload
	transfer or durable commits. No new runner/npm script added. Results, buffers,
	WAL, index size and protocol: `docs/workout-import-deduplication.md`.

## Verified Repair And Benchmark Refresh (2026-11-04)

- User reported manually applying the end-time repair. Subsequent SELECT-only
	verification in local `cwa24_dev` found 6,142 valid workout ranges, zero invalid
	ranges and zero remaining repair candidates. Six sampled durations match
	elapsed time exactly; `workouts_no_time_overlap` remains validated. This verifies
	Dev only, not another database or deployment of the import fix.
- User explicitly authorized synchronizing both benchmark copies and updating
	statistics. Updated only 3,908 end times per table from one repeatable-read
	application snapshot, then ran `ANALYZE`. Each now contains 6,142 valid ranges;
	whole-row fingerprints match the source and each other. Transaction committed.
- Preserved all indexes/constraints (eight baseline indexes, nine with exclusion)
	and both independent identity sequences. Source snapshot and source sequence
	remained unchanged. No migration executed by the assistant, no production
	access and no performance measurements. Earlier preparation counts below are
	historical. Details: `docs/workout-import-deduplication.md`.

## Workout End-Time Repair Preparation (2026-11-04)

- User approved the import fix, regression tests and preparation of a manual
	historical-data repair. Both WOA1 encoders now share a per-session fallback:
	missing/invalid/non-increasing timestamps use start plus positive finite elapsed
	duration; valid increasing timestamps are preserved. Timer time and compressed
	stream length are not wall-clock substitutes; multi-session gaps are retained.
- Dev read-only inspection confirmed 3,908 equal start/end timestamps, all with
	positive durations. Six decoded streams confirm nonzero recordings. Original
	historical FIT session fields were not inspected. SELECT-only repair preflight:
	3,908 candidates, zero proposed overlapping pairs.
- Prepared `src/migrations/095_workout_end_time_repair.sql`: transactional repair
	under a write-blocking table lock, with pre-UPDATE conflict detection against
	unchanged and proposed ranges; aborts on conflicts, never disables constraints
	or deletes workouts. ONLY the user executes it. No migration, backfill, restart,
	deployment or benchmark refresh performed. Existing benchmark copies still have
	the old timestamps. Manual audit/rollout: `docs/workout-import-deduplication.md`.
- Focused import/conflict tests: 17 passed. Touched-module lint has no errors
	(14 existing warnings). Full suite: 745 passed; syntax check passed. Typecheck
	still reports only the three known `lastEnd` nullability errors in
	`src/shared/MicroIntervalDetector.js:141`. SQL tests are structural; live
	migration is unverified.

## Prepared Constraint Benchmark (2026-11-04)

- User explicitly authorized preparing the isolated benchmark environment in
	local `cwa24_dev`. Created `benchmark.workouts_unique` and
	`benchmark.workouts_exclusion`, each with the same 6,142 source rows including
	blobs; full-row fingerprints match. Common index definitions match, with eight
	indexes on the baseline and nine on the exclusion variant. Independent identity
	sequences and `ANALYZE` are ready; application table/sequence were not changed.
- 2,234 rows have valid ranges; 3,908 are outside the exclusion predicate. Free
	interval inserts succeed on both test tables; shifted overlaps succeed only
	on the baseline and produce `23P01` on the exclusion variant. All probe writes
	rolled back, leaving both at 6,142 rows. No application migration was run.
- This prepares comparison tables only, not performance results or a benchmark
	runner. The existing insert-explain script must not be used unchanged. Foreign
	keys/triggers are not cloned. No application restart/deployment or production
	access. Details: `docs/workout-import-deduplication.md` (Prepared Development
	Benchmark). Cleanup requires a separate explicit action.

## Flexible Interval Blocks (2026-11-04)

- User approved longer interval detection during import and manually, multiple
	independent sets, flexible durations/counts and approximately 5% effort/pause
	duration tolerance. The separate `intervals` kind reuses structured phases,
	worker/editor, chart/map labels and visibility, persistence, WPP, backups and
	FIT export. Existing microintervals and manual corrections remain protected.
- Migration `094_workout_interval_blocks.sql` is prepared only and MUST be run
	manually by the user before saving/importing the new kind. No migration,
	backfill, real segment save, restart or deployment was performed. Read-only
	`cwa24_dev` analysis recognizes workout 85064 as 3 x 4 min / 3 min, with
	238/235/234-second efforts and 185/186-second pauses; nothing was saved there.
- Verification: 742 tests pass in the complete suite; syntax/targeted ESLint
	pass (15 existing warnings), with the same three known `lastEnd` type errors
	in `MicroIntervalDetector.js:141`. Real browser worker/editor and isolated
	controller-method preview verified separate 3/4-repetition blocks, simulated
	save/manual phase edit, and desktop/mobile editor sizing/screenshots. Not an
	authenticated dashboard/database-write test. Details and limits:
	`docs/workout-microintervals.md` (Longer Interval Blocks / Verification).

## Analytics Terrain Map (2026-11-04)

- User approved the same embedded 2D/3D map for Analytics. It reuses the shared
	workout map, terrain sources, labels, hit testing and position marker. The
	independent `analytics.mapRenderer` preference uses existing JSON view state;
	no migration. Only explicit renderer choices save; automatic fallback and
	no-GPS workouts retain the preferred renderer. Existing CP filtering and
	hidden-map layout remain. Map dimensions refresh before fitting a revealed
	track to avoid inheriting a zero-size Leaflet camera. Details:
	`docs/workout-map.md` (Analytics Workout Detail).
- Verification: 117 focused Analytics/map/preference/hover/header tests passed;
	syntax and targeted ESLint passed (two existing controller warnings). Types
	retain the three known nullability errors in `MicroIntervalDetector.js:141`.
	Actual-template synthetic preview verified desktop/mobile screenshots and
	nonblank pixels, CP filters, marker, switching, simulated preference saves,
	hover/click at pitch 75 and no-GPS/eligible-workout camera recovery. No full
	suite, authenticated end-to-end test, database write, migration or deployment.

## Workout Terrain Hit Testing (2026-11-04)

- User confirmed the same issue in the workout UI and approved applying the
	pixel-distance fix there, with an explanation of the logic change. Both views
	now share projection and nearest-line distance code in `WorkoutTerrainView`;
	the segment view keeps endpoint priority. Workout hover uses map-wide mouse
	events, not native layer-hover events; click and hover share one pixel hit.
- The 9 CSS pixel limit, camera/render/resize/data cache invalidation, GPS gaps,
	existing chart/list callbacks, hover-end selection retention, second-click
	deselection and manual GPS drawing priority are preserved/tested. Details:
	`docs/workout-map.md` (Shared Terrain Hit Testing).
- Verification: 84 focused map/preference/hover/header/track/paging/UI-state
	tests passed; targeted syntax/ESLint and editor diagnostics passed. Real
	canvas events in a freshly loaded workout preview verified zoom 14/pitch 75,
	zoom 15/pitch 80/bearing 40, normal-angle recovery, selection/deselection,
	background clicks, hover callbacks, draft-point priority and nonblank pixels.
	Synthetic preview only, not a complete authenticated chart/dashboard check.
	No full suite, new type check, database write, migration, restart or deployment.

## Segment Terrain Hit Testing (2026-11-04)

- User approved fixing segment selection/cursor failures after zoom/tilt.
	Isolated MapLibre 4.7.1 preview reproduced native feature-query misses on
	pixel-confirmed visible lines at zoom 14/pitch 75, plus false outside hits.
- Segment hover/click now share authoritative projected screen-space geometry:
	nearest smoothed line within 9 CSS pixels, with start/end marker priority.
	Cached projections invalidate on camera movement, map render/resize and data
	rendering. No changes to workout-map hit testing, routing or preferences.
- Verification: all 26 map tests passed, including three new regressions for
	distance limits, native misses/false hits, endpoints, filtered/invalid data,
	cursor/click sharing and projection invalidation. Targeted syntax/ESLint and
	editor diagnostics passed. Real canvas events in the synthetic preview
	confirmed selection/pointer at zoom 14/pitch 75 and zoom 15/pitch 80/bearing 40,
	normal-angle recovery, start/end actions and no outside selection. Details:
	`docs/workout-map.md`. No authenticated application test, full suite, database
	write, migration, restart or deployment.

## Segment Terrain and Server-Side Map Preferences (2026-11-04)

- User approved the same embedded 2D/3D alternative for the segment page and
	server-side renderer persistence in both views. Optional `mapRenderer`
	(`2d`/`3d`) uses existing per-user JSON view preferences, independently under
	`workout-library` and `segments`; no migration. Missing server choices default
	to 2D, and automatic fallbacks do not overwrite the preferred renderer.
- Segment terrain reuses the workout terrain implementation with specialized
	selection, endpoint actions, escaped tooltips and labels. Active camera bounds
	drive viewport/filter loads; profile markers and routing drafts are shared.
	Switching preserves draft points and uses the existing routing endpoint.
	Navigation/attribution move left to avoid the segment detail overlay.
- Verification: 79 focused tests passed, including both controller restore/save
	paths, delayed workout activation and non-persisting fallbacks. Syntax and
	targeted ESLint pass (seven existing warnings). Types retain the three known
	nullability errors in unchanged `MicroIntervalDetector.js:141`.
- Isolated real-template/library preview verified desktop terrain/pixels and
	screenshot, canvas line/start/end clicks, labels/marker, camera movement,
	simulated routing and draft/fallback behavior. Mobile 390 x 844 DOM/canvas
	checks passed without horizontal overflow; browser screenshot raster clipping
	prevents claiming full mobile visual verification. Details and limits:
	`docs/workout-map.md`. No full suite, authenticated end-to-end preference test,
	live routing, database access/write, migration, restart or deployment.

## Segment Label Layers and Translucency (2026-11-04)

- User requested headers above lines and slightly translucent labels. A real
	ECharts render confirmed group z-order did not reach header children, which
	were at z=0 below a z=4 crossing line. Header rect/dot/text now each explicitly
	use z=120+lane. Background alpha is 0.52 normally, 0.78 active and 0.84 hovered;
	text and CP dots stay opaque. Hover and mouseout use the same opacity constants.
- Leaflet labels additionally moved from the segment pane to a dedicated
	pointer-transparent pane at z=575, above highlights at 550. Shared Leaflet/
	MapLibre label backgrounds use 0.78 alpha and 2px blur, without fading text.
	Details: `docs/workout-map.md`.
- Verification: all 33 focused CP-header, map-label and segment-visibility tests
	passed. Targeted syntax/ESLint and `git diff --check` passed, with four known
	unused-variable/argument warnings. Browser checks confirmed actual ECharts
	display-list order, header screenshot, Leaflet pane order/alpha and screenshot,
	MapLibre mobile alpha/screenshot/nonblank pixels with no horizontal overflow.
	Isolated preview only; no full authenticated workout UI test, full suite,
	database changes, migrations, service restart or deployment.

## Segment Hover and Terrain Labels (2026-11-04)

- User approved fixing chart-header hover not highlighting the route and adding
	the missing MapLibre segment labels. The chart callback now forwards enter/
	leave to the existing map hover methods as well as the segment list. Hover
	end retains existing selection; no extra map-to-chart callback is emitted.
- Leaflet and MapLibre now share label text, colors, CP markers, path-length
	thresholds and overlap selection. Terrain labels use MapLibre projection and
	noninteractive DOM markers, updated after render/camera move/resize and removed
	when no longer visible. GPS editing and the popup flyover are unchanged.
- Details: `docs/workout-map.md`. Verification: all 30 focused map-label,
	segment-visibility and CP-header tests passed. Targeted ESLint has no errors
	and four existing warnings; syntax, editor diagnostics and `git diff --check`
	passed. Isolated browser preview verified actual chart-callback forwarding
	against Leaflet/MapLibre, selection restoration, S-1/CP4 labels, camera changes,
	desktop/mobile screenshots, nonblank canvas pixels and no label overlap in the
	tested viewport. Preview-only hidden-tab animation-frame workaround retained.
	Full authenticated ECharts/list/map pointer interaction and full suite were
	not run. No database access, migration, service restart or deployment.

## GPS Editing in MapLibre (2026-11-04)

- User approved moving the existing workout GPS editing options into the
	embedded MapLibre view as well as Leaflet. Existing ownership/GPS-source
	restrictions, routing, save, GPX and copy handlers are unchanged; no new
	routing service, backend endpoint, migration or elevation calculation.
- Terrain clicks append shared draft points, rendered as colored circles and
	a dashed line. Editing no longer forces 2D, and editable owned workouts
	without GPS may open 3D. Renderer switches preserve the draft. Clear,
	cancel, save and failed-save preservation reuse the existing controls;
	switching workouts discards the previous draft. MapLibre double-click zoom
	is disabled while editing and restored afterward. No point dragging or
	individual deletion added; the existing append/clear-all workflow is retained.
- Details and current restrictions: `docs/workout-map.md`. This supersedes
	the initial 2D-only editing restriction documented in the previous entry.
	The popup flyover and separate segment page remain untouched.
- Verification: 14 focused tests passed; targeted ESLint has no errors and
	one existing unused-variable warning. Browser preview verified terrain
	click forwarding with simulated canvas mouse events, three-point geometry,
	renderer-switch preservation, simulated save, desktop/mobile screenshots
	and nonblank canvas pixels. Hidden-tab rendering required a preview-only
	animation-frame shim, not a production code change. No authenticated
	dashboard test, live routing/upload/save, database operation, migration,
	deployment or full-suite run.

## In-Place Workout Terrain Map (2026-11-03)

- User approved only an embedded Leaflet/MapLibre switch in the workout UI,
	including actual terrain like the MapLibre example. The existing flyover
	modal and separate segment page remain unchanged.
- Added a 2D/3D control; Leaflet stays the default. MapLibre uses OSM raster
	tiles and Mapterhorn Terrarium DEM tiles with 1x relief and hillshading,
	without an API key. Shared track gaps, segment colors/selection/hover and
	chart-position markers are retained. The switch transfers center and
	approximate zoom; manual editing and workouts without GPS stay in 2D.
- Terrain initializes on demand. Startup/source/WebGL failures or the initial
	20-second timeout return to Leaflet with localized feedback. Existing
	MapLibre 4.7.1 loading for the flyover is unchanged. No database changes,
	migration, scheduler, full app startup or deployment performed.
- Details, provider usage/attribution, privacy and limitations:
	`docs/workout-map.md`. Public hosting is not an unlimited service guarantee.
- Verification: 10 focused tests passed; targeted ESLint has no errors and
	one existing unused-variable warning. Syntax, EJS compilation, all six
	locale JSON bundles, editor diagnostics and `git diff --check` passed.
	Isolated Playwright preview with real map modules/public tiles and synthetic
	GPS verified desktop/mobile screenshots, nonblank canvas pixels, terrain,
	marker/selection, rotation/tilt, center preservation, workout/no-GPS changes
	and mobile popup bounds. Full suite and authenticated dashboard/real chart
	interaction were not tested. Static preview runs at http://127.0.0.1:3107;
	it does not start application workers or access the database.

## Workout Time Exclusion (2026-11-03)

- User chose any positive same-user time overlap as a conflict, rather than the
	proposed 90% rule with application-level serialization. Prepared migration 093
	adds an immediate GiST exclusion constraint via `btree_gist` on valid half-open
	`[start_time, end_time)` ranges. Adjacent workouts remain allowed; invalid or
	missing ranges are excluded. Existing start-time uniqueness remains unchanged.
- Common inserts now use untargeted `ON CONFLICT DO NOTHING`. Shifted conflicts
	are skipped without mapping their postprocessing onto existing workouts.
	Bundle WPP1/GBE1 filtering and recovery checkpoints accept explicit time skips;
	Wahoo persistence-time skips do not trigger failure retries.
- Overwrite remains exact-start-only and is always transactional per batch.
	Missing replacements roll back that batch to preserve deleted workouts and
	dependencies. No custom duplicate-detection advisory locks were added.
- Manual audit, rollout, table-lock impact and limits are documented in
	`docs/workout-import-deduplication.md`; provider/recovery guides link there.
	Existing overlaps prevent constraint creation and require manual resolution.
- Verification: all 699 tests passed, including new conflict, overwrite rollback,
	WPP1/GBE1 filtering and Wahoo skip regressions with mocked database access.
	Syntax, targeted ESLint (one existing warning), editor diagnostics and
	`git diff --check` passed. Types retain only the three known nullability errors
	in unchanged `src/shared/MicroIntervalDetector.js:141`. Migration checks are
	structural only. No live database/constraint/concurrency/performance check,
	migration execution, browser check, restart or deployment. Migration 093 must
	still be executed manually by the user before the new DB protection is active.

## German Umlaut Copy Cleanup (2026-11-02)

- User approved all previously listed German umlaut corrections: upload/3D-map
	translations, sharing/segment/invitation errors, ZIP benchmark labels, and the
	upload timing label. Translation keys, placeholders, identifiers, and behavior
	remain unchanged; proper German characters are used in visible copy.
- Corrected the existing German prose in `docs/woa-workout-stream-format.md`
	and `docs/nginx-upstream-timing.md`, including the remaining stream-document
	closing section. Code examples, formulas, and technical names are unchanged.
	Removed obsolete ASCII spelling examples from the earlier deletion-copy note.
- Verification: 14 focused i18n/profile/upload tests passed; all changed JS
	files passed syntax checks. German JSON parses and retains all pre-existing
	keys and interpolation placeholders. Targeted ESLint has no errors and six
	existing warnings in `upload-new.js`; editor diagnostics, targeted spelling
	search, and `git diff --check` passed. No live browser check, database access,
	migration, service restart, or deployment.

## German Deletion Copy (2026-11-02)

- User-approved copy correction in `src/public/i18n/de.json`: replaced remaining
	ASCII deletion spellings with proper umlauts in account-deletion and import messages,
	including adjacent German day-period and final-removal wording. Keys, placeholders, and
	behavior remain unchanged; use proper umlauts in German UI copy.
- Verification: JSON parsing, absence of remaining ASCII deletion spellings, retained
	date placeholder, six-language profile rendering, and `git diff --check` passed.
- Follow-up: corrected the remaining group-owner deletion error in
	`src/services/collaborationDBService.js` and removed obsolete spelling examples
	from this note. Mocked owner-denial check, service syntax, repository text
	search, and `git diff --check` passed; no live database access.

## Development Translation Reload (2026-11-02)

- User-approved change in `src/i18n/index.js`: when `NODE_ENV` is unset or
	`development`, requests check locale file metadata and reload changed bundles
	as one atomic snapshot. Unchanged JSON is not reread; locale additions/removals
	are discovered. Middleware uses the latest snapshot rather than startup data.
- Read/parse failures retain all last valid bundles and emit one sanitized
	warning per failure period; correction is retried on subsequent requests.
	Startup without a valid snapshot still fails on invalid files. Production and
	other explicit environments retain their startup cache without request-time
	filesystem checks. No dependency, watcher, new npm script, or DB change.
- One manual backend restart is needed to activate this implementation; future
	development translation edits only require browser refresh. Existing pages do
	not update automatically. Setup and limits: `docs/npm-scripts.md` under
	"Translation Changes During Development". No services restarted by the agent.
- Verification: 13 focused tests passed, including temporary-file reload,
	unchanged-file read avoidance, snapshot isolation, locale discovery/removal,
	malformed JSON recovery, missing-file fallback, startup failure, and immutable
	production/test caches, plus six-language profile rendering and intensity copy.
	Syntax, targeted ESLint, editor diagnostics, and `git diff --check` passed.
	Type checking reports only the three known nullability errors in unchanged
	`src/shared/MicroIntervalDetector.js:141`. No full suite or live browser check.

## Body Weight Facet and Required Profile Weight (2026-11-02)

- User-approved follow-up: body-weight history is now the sixth settings facet,
	immediately after Profile, with its own EJS partial and `/profile#weight-history`
	link. Existing history controls and storage behavior remain unchanged; labels
	are available in all six languages. Profile weight stays in personal data.
- Profile and preference saves require a valid profile weight greater than 0
	and at most 500 kg. Native form validation reveals/focuses invalid fields across
	facets; server validation rejects invalid weights before database access.
- Existing NULL values remain readable and unchanged. No migration, backfill,
	default value, new constraint, or live database operation. History resolution,
	profile fallback, and missing-weight behavior remain unchanged. Details in
	`docs/user-settings.md`; README updated for the API requirement.
- Verification: four existing rendering/history checks passed, including profile
	rendering in six languages. Mocked service checks covered invalid/valid weights
	and reading NULL; mocked UI checks covered rejected preference saves without
	HTTP, revealing/focusing profile weight, history deep links, and valid saves.
	Syntax, targeted ESLint, editor diagnostics, and `git diff --check` passed.
	No new test files or visual browser check. Type checking reports only the three
	known nullability errors in unchanged `src/shared/MicroIntervalDetector.js:141`.

## User Settings Facets (2026-11-02)

- User-approved split into Profile, Preferences, Connections, Membership, and
	Account. Desktop uses local navigation below the heading; mobile uses a select.
	Five EJS partials preserve existing controls, IDs, save actions, and APIs.
- Facets retain unsaved form values, support URL/history navigation and existing
	provider anchors, and select Membership on payment returns. Shared feedback
	remains visible across facets. No-JavaScript fallback shows all sections.
	Structure and direct links: `docs/user-settings.md`.
- Verification: existing six-language profile rendering and Wahoo UI checks
	passed (three tests); isolated navigation checks covered ten entry URLs,
	desktop/mobile selection, popstate, and hashchange. Syntax, targeted ESLint,
	editor diagnostics, and `git diff --check` passed. No new test files.
- User reports the local app running. No completed visual browser check or live
	OAuth/payment/save round-trip; browser opening was cancelled. No app/worker
	restart, migration, or deployment performed by the agent.

## Wahoo Settings Spacing (2026-11-02)

- User-approved change: wrapped the Wahoo section content in the existing
	`profile-form` container so it uses the same responsive inner padding as
	neighboring profile sections. Controls and behavior remain unchanged.
- Verification: profile EJS compilation and `git diff --check` passed.
	No tests added or run, as requested; no visual browser check performed.

## Automatic Development Login URLs (2026-11-02)

- User-approved change: in development (also when `NODE_ENV` is unset),
	`start:all` passes localhost `APP_BASE_URL` and Cognito callback values to child
	processes; `start:tunnel` uses the fixed ngrok origin. Local URLs use `PORT`,
	defaulting to 3000. Both commands load the selected environment configuration.
- Overrides apply only to spawned processes and supersede old app/Cognito URL
	values. Wahoo variables, environment files, and non-development URLs remain
	unchanged. `npm start` and individual worker commands are unaffected.
- Both Cognito callback URLs must be allowed externally. Wahoo connection flows
	remain ngrok-only with the current Wahoo redirect. Details in
	`docs/npm-scripts.md` and `docs/WAHOO_CONNECT.md`; README updated.
- User confirmed Google/Cognito login and Wahoo connection working on the Mac
	through ngrok after correcting the localhost Cognito redirect, before this
	automatic switching change. This does not confirm automatic webhook imports
	or a live test of the new switching behavior. No migrations run by the agent.
- Verification: all 12 focused starter tests passed, including URL
	overrides, configured ports, unchanged Wahoo settings/source environment,
	production preservation, and existing readiness/shutdown/error behavior.
	Syntax, targeted ESLint, editor diagnostics, and `git diff --check` passed.
	Full type checking reports only the three known nullability errors in the
	unchanged `src/shared/MicroIntervalDetector.js:141`. No full test suite or
	live OAuth round-trip was run for this change; running services were not
	restarted. Existing user changes to migration files were left untouched.

## Optional Local ngrok Starter (2026-11-02)

- User-approved short command implemented: `npm run start:tunnel` starts the app,
	import worker, backup worker, and ngrok at
	`https://scenic-riverbed-unloader.ngrok-free.dev`. `start:all` remains local-only.
- Uses the same environment/port as the app (default 3000), waits up to 30 seconds
	for local HTTP readiness, prefixes tunnel logs, and includes ngrok in shutdown.
	Tunnel failures leave core services running; core failures still stop all.
- Setup, public exposure, conflicts with existing processes, and limitations are
	documented in `docs/npm-scripts.md` under “Local Development With ngrok”; README
	links there. No dependencies, environment files, or migration behavior changed.
- Verification: eight focused starter tests passed (mocked subprocesses,
	real local HTTP readiness/retry/redirect/cancellation checks). Syntax, targeted
  ESLint, editor diagnostics, and `git diff --check` passed. Full type checking
  now reports only the three previously known nullability errors in
  `src/shared/MicroIntervalDetector.js:141`; the starter's previous stream typing
  error was resolved in the touched code. No full test suite was run.
  Combined live service startup has not
	been performed; existing app, workers, and tunnel were not stopped or restarted.

## Documentation Context Across Sessions (2026-11-02)

- User-approved rule added to `AGENTS.md`: read this working state at session start, review the Markdown files available in `docs/`, and read the relevant detailed guides before each task.
- Keep affected detailed guides current in the same task. Store lasting agreements and relevant context in the appropriate documentation; keep this working state concise and link to details instead of duplicating them. Write new documentation text in English.
- Documentation-only change; no application code, migrations, deployment, or environment configuration changed.
- Verification: `git diff --check` passed and the diff was reviewed for the approved scope. No application tests run for this documentation-only change.

## Automatischer Wahoo-Import über Webhooks (2026-11-01)

- Freigegebener Umfang umgesetzt: `/webhooks/wahoo`, Tokenprüfung, Benutzerzuordnung, Hintergrundimport ohne Überschreiben, Profiloption und OAuth-Scope `offline_data`. Benutzer bestätigt Migration 092 manuell ausgeführt; keine separate Datenbankprüfung oder Ausführung durch den Agenten. Benutzer hatte zuvor die ID-Persistierung erfolgreich getestet.
- Empfang vor Session-/Login-Middleware: begrenztes JSON, zeitkonstanter Vergleich von `WAHOO_WEBHOOK_TOKEN` (32–512 Zeichen), validierte BIGINT-IDs, dauerhafter Eingang nur für aktive/aktivierte Verbindungen mit Offline-Freigabe, UNIQUE-Deduplizierung. Keine Payloads, Tokens oder gelieferten Download-URLs speichern. 200 erst nach Speicherung/bei ignorierten Meldungen, bereinigte Fehler.
- Bestehender Import-Worker prüft PostgreSQL-Eingang alle fünf Sekunden; Session-Advisory-Lock verhindert parallele Bearbeitung und erlaubt Wiederaufnahme nach Prozessabbruch. Maximal fünf Versuche mit Backoff, finale Fehler als `failed`. Download über authentifizierte Wahoo-API, Summary-ID-Abgleich und vorhandene CDN-/FIT-Limits.
- FIT-Konvertierung in separatem Node-Thread mit 60-Sekunden-/512-MiB-V8-Heap-Limit; vorhandene Parserkorrekturen, 300-Datensatz-Minimum, Intensitätsfeatures und WOA-Komprimierung. Gemeinsamer WOA-Speicher-/Nachverarbeitungsweg wiederverwendet. Startzeit-Duplikate überspringen, DB-Konflikt schützt zusätzlich; Wiederholungen können Folgeaufträge nach Teilfehlern erneut anstoßen.
- Vor Download und unmittelbar vor Speicherung Verbindung, Wahoo-ID, Option, Offline-Freigabe und Kontostatus prüfen; beim Speichern Konto/Verbindung gegen Änderungen sperren. Verbindungslöschung entfernt Eingang. Keine automatische Löschung/Überschreibung aufgrund Wahoo-Änderungen.
- Profiloption standardmäßig aus; bestehende Verbindungen können Freigabe direkt erweitern. Neue Verbindung setzt Option wieder aus. Tokenantwort-Scope wird berücksichtigt, bei ausgelassenem Scope gilt gemäß OAuth angeforderter Umfang. Status liefert nur Flags, keine IDs/Tokens. Neue Texte deutsch/englisch, übrige Sprachen hierfür Englisch. Anleitung und npm-Skriptübersicht für erweiterten Worker aktualisiert; keine neuen Skripte/Abhängigkeiten.
- Verifikation: Gesamtsuite **670/670 erfolgreich** mit erlaubten lokalen Testports; echte FIT→WOA-Konvertierung im Thread, ungültige/kurze FITs, Webhook-Authentifizierung/Parserlimits/Fehlerbereinigung, Benutzer-/Aktivierungsfilter, Deduplizierungs-SQL, erneute Kontoprüfung, Startzeit-Duplikate, Claim/Backoff/Lockfreigabe, Profilsteuerung und Routenschutz geprüft (DB/Queues simuliert). Syntax erfolgreich, ESLint ohne Fehler (71 bestehende Warnungen), Typprüfung unverändert vier bekannte Fehler in `start-all.js:39` und `MicroIntervalDetector.js:141`. `git diff --check` erfolgreich.
- Benutzer bestätigt am 2026-11-01 vollständigen Live-Ablauf: Webhook zugeordnet, beim ungefähr sechsminütigen Training zunächst `pending`/`wahoo_import_failed`, später `completed` und Training sichtbar in WOA. Automatische Wiederholung damit erfolgreich bestätigt; keine separate Live-Prüfung durch den Agenten, Umgebung nicht benannt. Einrichtung funktionierte für diesen Test; genaue Portal-/Serverwerte nicht geprüft.
- Vorheriger 3,5-Minuten-Test: `skipped`; Mindestlänge als plausible, nicht belegte Ursache. Ursache des ersten Fehlers beim längeren Test unbekannt; FIT-Datei eventuell noch nicht verfügbar, ausdrücklich unbestätigt. Allgemeiner Fehlercode grenzt den Verarbeitungsschritt nicht ein.
- Retry-Ablauf in Anleitung ergänzt: nach Verbindungsprüfung bei jedem Versuch Summary erneut authentifiziert abrufen, aktuellen Dateilink lesen und FIT erneut laden; keine gespeicherte Download-Adresse und kein neuer Webhook erforderlich. Wahoos Zustellwiederholung bleibt davon unabhängig.
- Offen: langfristige Zustellung bei abgelaufenem Access-Token, gesonderte Live-Prüfungen von Duplikaten/Trennen/Deaktivieren/Prozesswiederanlauf und visuelle Browserprüfung. Kein zusätzlicher Token-Timer; Erneuerung weiter bei API-Bedarf. Keine eigene Fehler-/Retry-Oberfläche. Keine Änderungen an Geheimnissen, kein Deployment durch den Agenten.
- Dokumentationsnachtrag nach ausdrücklicher Freigabe: Anleitung und Arbeitsstand aktualisiert, Codepfad erneut gelesen; `git diff --check` erfolgreich. Keine neuen Anwendungstests für die reine Dokumentationsänderung.

## Wahoo-ID für Webhooks vorbereiten (2026-11-01)

- Freigegebene Reihenfolge: zuerst Migrations-SQL bereitstellen, Benutzer führt es aus; anschließend Code zum Befüllen umsetzen.
- `091_wahoo_user_id.sql` vorbereitet: nullable positive BIGINT-Spalte `wahoo_user_id` in `user_wahoo_connections`, UNIQUE für eindeutige Wahoo-/WOA-Zuordnung. Bestehende Verbindungen bleiben zunächst NULL. Anleitung ergänzt.
- Benutzer bestätigt manuelle Ausführung von Migration 091; keine separate Datenbankprüfung und keine Ausführung durch den Agenten.
- Befüllen implementiert: beim Verbinden authentifiziertes `/v1/user` lesen und validierte ID atomar mit Tokens speichern. Bei NULL beim nächsten Wahoo-API-Abruf nachtragen (bei `/v1/user` kein doppelter Abruf); kein Abruf beim bloßen Profilöffnen. Nur ID speichern, bestehende Scopes genügen.
- Positive BIGINT-ID als String ohne unsichere Zahlenkonvertierung; UNIQUE-Konflikte/ungültige Profile bereinigt abweisen. Beim Nachtragen Tokenhülle vergleichen gegen zwischenzeitliches Trennen/Neuverbinden/Refresh; rotierte Tokens bleiben bei Folgefehler erhalten. Anleitung aktualisiert. Webhook-Empfang weiterhin nicht implementiert.
- Verifikation: 26 gezielte Wahoo-Tests erfolgreich mit getrennten Testprozessen und freigegebenen lokalen HTTP-Testports (Sandbox sonst EPERM). Darunter neue Fälle für Speichern, Nachtragen mit/ohne Refresh, ungültige IDs, Konflikte und zwischenzeitliche Verbindungsänderung. Gemeinsamer Lauf ohne Prozessisolation hatte eine Mock-Wechselwirkung; regulärer isolierter Lauf erfolgreich. Service-Syntax, gezieltes ESLint und `git diff --check` erfolgreich. Kein Live-Test, Deployment oder Gesamtsuitenlauf für diese Ergänzung.

## Wahoo-Workout-Import (2026-11-01)

- Ausdrücklich freigegebener Umfang umgesetzt: eigene Seite `/files/wahooImport`, Dashboard-Einstieg „Von Wahoo importieren“, Verbindungshinweis, Auswahl, Nachladen in 20er-Seiten, Überschreiboption und Einzelstatus. Auswahl/Status bleiben beim Nachladen erhalten; einzelne Fehler stoppen die restliche Auswahl nicht.
- OAuth fordert jetzt `user_read workouts_read`; bestehende Verbindungen mit reinem Profilzugriff müssen getrennt und erneut verbunden werden. Keine zusätzliche Migration oder npm-Skripte/Abhängigkeiten.
- `wahooImportService.js` und `/api/wahoo/activities[/:id/file]`: aktives angemeldetes Konto, benutzergebundene API-Zugriffe, feste API-Pfade, validierte IDs/Offsets und bereinigte Fehler. Bestehende Token-Erneuerung für API-Aufrufe wiederverwendet; Tokens bleiben serverseitig.
- FIT-Download nur HTTPS von `cdn.wahooligan.com`, ohne OAuth-Header/Redirects, maximal 50 MiB/60 Sekunden und FIT-Headerprüfung. JSON-Limit für authentifizierte API-Aufrufe auf 1 MiB erweitert; Token-Austausch weiterhin 64 KiB. Andere Downloadhosts werden abgewiesen und müssen gegebenenfalls nach belegtem Live-Befund ergänzt werden.
- Gemeinsame Auswahloberfläche in `garmin-import-ui.js` um Provider/Dateiformat erweitert; Wahoo übergibt FIT an `externalWorkoutImport`, bestehender Worker-/Speicherweg mit Duplikaten und Importfiltern. Neue Texte deutsch/englisch; vorhandene gemeinsame Texte in weiteren Sprachen übernommen. Anleitung aktualisiert, bereits vorhandene Dokumentationsänderungen erhalten.
- Verifikation: Gesamtsuite **651/651 erfolgreich** mit freigegebenen lokalen Testports (Sandbox blockiert sonst `listen`). Neue Tests für Pagination, Benutzerbindung, Routenschutz, Fehlerbereinigung, CDN-/FIT-Prüfung, Auswahl/Fehlerfortsetzung und Rendering. Nach abschließender Textbereinigung zusätzlich 16 gezielte Tests erfolgreich. Syntax erfolgreich; ESLint ohne Fehler (71 bestehende Warnungen); Typprüfung weiterhin vier bekannte Fehler in unveränderten `start-all.js:39` und `MicroIntervalDetector.js:141`. `git diff --check` erfolgreich.
- Offen: Live-Test der erweiterten Wahoo-Freigabe, tatsächlicher FIT-Downloadhost, Import/Duplikate/Überschreiben sowie visuelle Browserprüfung. Keine Migration oder Deployment ausgeführt. API-Vertrag anhand offizieller Wahoo-Referenz erneut geprüft.

## Wahoo-OAuth-Verbindung (2026-10-31)

- Nach ausdrücklicher Freigabe den Callback-Platzhalter durch den OAuth-Code-Flow für eine Confidential-App ersetzt: Verbindungsstart, sitzungs-/benutzergebundener State (zehn Minuten), Callback mit State-Verbrauch vor Token-Austausch und feste Profil-Rückmeldungen. Nur Scope `user_read`; Workout-Import bleibt separater Umfang.
- `wahooRoutes.js`: angemeldete Benutzer, Kontostatus-Schreibsperre, explizite Origin-Prüfung für Start/Trennen, no-store/no-referrer; Status ohne Tokens. Profiloberfläche mit Verbinden/Status/Trennen und bestehendem Bestätigungsdialog; Deutsch/Englisch, übrige vier Sprachen hierfür Englisch.
- Neuer `wahooConnectionService.js`: Tokens/Ablaufzeit als AES-256-GCM-Hülle mit Benutzerbindung, feste Wahoo-Endpunkte, keine Redirects, 15-Sekunden-/64-KiB-Limits und bereinigte Fehler. Interner `readUser`-Service erneuert nur vor API-Bedarf, mit Datenbank-Zeilensperre und Persistierung rotierter Tokens vor API-Aufruf. Noch kein öffentlicher Datenabruf und kein automatischer 401-Retry.
- Trennen löscht lokal Tokens und den laufenden OAuth-Versuch dieser Sitzung; kein Remote-Widerruf bei Wahoo. Oberfläche/Dokumentation erklären den zusätzlichen Widerruf im Wahoo-Konto. Endgültige Kontolöschung entfernt die Verbindung; Account-/Profilexporte enthalten keine Tokens.
- Migration `src/migrations/090_user_wahoo_connections.sql` ausschließlich vorbereitet, **nicht ausgeführt**. Servervariablen `WAHOO_CLIENT_ID`, `WAHOO_CLIENT_SECRET`, `WAHOO_REDIRECT_URI`, `WAHOO_TOKEN_ENCRYPTION_KEY` erforderlich, keine Werte eingerichtet. Einrichtung/API/Grenzen in `docs/WAHOO_CONNECT.md`; offizielle Wahoo-Referenz geprüft.
- Verifikation: Gesamtsuite 640/640 erfolgreich mit freigegebenen lokalen Testports; anschließend zusätzliche Prüfungen für Refresh-Fehler/fehlende Verbindung und Profil-Rendering in sechs Sprachen ergänzt, abschließend alle 13 Wahoo-Tests erfolgreich. Syntaxprüfung erfolgreich; gesamtes ESLint ohne Fehler (71 bestehende Warnungen). Typprüfung scheitert in unveränderten Dateien: `start-all.js:39` (`write`-Typ) und drei Null-Prüfungen in `MicroIntervalDetector.js:141`.
- Benutzer bestätigt nach Einrichtung einen erfolgreichen Live-Test des Wahoo-Verbindungsablaufs (Anmeldung/Freigabe/Callback). Kein separater Live-Test durch den Agenten; lokale oder produktive Umgebung nicht ausdrücklich benannt. Konkrete Migration/Deployment-Ausführung und Tokenformat nicht separat geprüft.
- Noch offen: automatische Token-Erneuerung gegen Wahoo/PostgreSQL sowie Trennen/erneutes Verbinden live prüfen. Damals war der Workout-Import noch nicht freigegeben/implementiert; inzwischen umgesetzt, siehe Abschnitt oben. Früherer Platzhalter-Abschnitt unten dokumentiert den abgelösten Stand.
- Sitzungsabschluss: ausschließlich Live-Test-Bestätigung und offene Punkte dokumentiert; `git diff --check` erfolgreich.

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

## Wahoo-Callback-Platzhalter (2026-10-31)

- Nach Freigabe des vorgeschlagenen Platzhalters GET `/auth/wahoo/callback` ergänzt. Feste Weiterleitung zum Profil mit lokalisiertem Hinweis „noch nicht eingerichtet“; Profil-Anmeldung bleibt erforderlich. OAuth-Parameter werden ignoriert und nicht weitergereicht, kein Token-Austausch oder Speichern einer Verbindung.
- Route setzt no-store/no-referrer. Hinweis in allen Sprachdateien vorhanden (Deutsch/Englisch), Profil-Template angepasst; Registrierungsadresse und Grenzen in `docs/WAHOO_CONNECT.md` dokumentiert.
- Verifikation: gezielter Callback-Test (feste Weiterleitung, Parameter nicht konsumiert, Header), Syntax von App/Route, ESLint der Route, EJS-Kompilierung, Sprachdateiprüfung und Diff-Prüfung erfolgreich. Kein Deployment und kein Live-Callback ausgeführt.
- Vollständiger OAuth-Ablauf und Wahoo-Import sind nicht implementiert und nicht Teil dieses Auftrags.

## Menüleiste bereinigt (2026-10-31)

- Nach Freigabe Upload-Eintrag aus der gemeinsamen Menüleiste (`partials/app-topbar.ejs`) entfernt. „Training hinzufügen“ in der Workouts-Ansicht bleibt der Einstieg für die vier Optionen.
- Verifikation: Menüleiste gerendert und Upload-Abwesenheit/Workouts-Link geprüft, Importseiten-Tests und `git diff --check` erfolgreich. Keine visuelle Browserprüfung.

## Getrennte Importseiten (2026-10-31)

- Nach ausdrücklicher Freigabe umgesetzt: vierte Dashboard-Option „Von Garmin importieren“ im Dialog „Training hinzufügen“, Desktop-Raster mit zwei Spalten. Eigene geschützte Seite `/files/garminImport` mit Schlüsselstatus, Profileinrichtung bei fehlendem Schlüssel, Auswahl/Nachladen, Überschreiboption und Einzelstatus; Hinweis zum Offenlassen der Seite.
- Garmin-Bereich aus Datei-Upload `/files/uploadUI` entfernt. Button heißt „Importieren“, Ablauf-Erklärung entfernt; beide Seiten einspaltig mit normalem Seitenscrollen. Fortschritt bleibt während der Verarbeitung verfügbar.
- Bewährte ZIP-/FIT-Verarbeitung in `upload-new.js` weiterverwendet: exportierte `externalWorkoutImport`-Schnittstelle, Garmin-Anbindung in separatem `garmin-import-page.js`; gemeinsames EJS-Partial für Fortschritt. Kein verstecktes Datei-Formular auf der Garmin-Seite.
- Sprachschlüssel in sechs Dateien vorhanden (neue Garmin-Seitentexte deutsch/englisch, übrige Sprachen hierfür Englisch). Cache-Versionen aktualisiert; Upload-Test prüft vorhandene Version statt eines fest eingefrorenen Werts. Garmin-Anleitung aktualisiert.
- Verifikation: gesamte Testsuite 630/630 erfolgreich (mit lokalen Testports); neue Renderprüfungen für lokalen Import und Garmin mit/ohne Schlüssel sowie bestehende Garmin-/Überschreibtests erfolgreich. Syntax der betroffenen JS-Dateien, EJS-Kompilierung des Dashboards und gezieltes ESLint erfolgreich (zehn bestehende Warnungen). Diff-Prüfung erfolgreich.
- Offen: visuelle Browserprüfung und Live-Import über die neue Garmin-Seite. Keine Migration und kein Deployment ausgeführt.

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

## Redundanz-Refactoring src/ (2026-11-11)

Schritte 1–9 abgeschlossen; Details und offener Schritt 10 in `memory/project_refactoring_redundanzen.md`.
Schritt 9: 4 identische Dekodier-Funktionen (`buildGpsSlotsAndSegments`, `toSegmentGeoJson`,
`decodeGpsBitmapColumnarPayload`, `decodeGpsCoordinatePayload`) als Named Exports aus
`shared/GpsTrackBlobCodec.js` exportiert; lokale Kopien und verwaiste Konstanten
(`GPS2_COORDINATE_SCALE`, `GPS2_DELTA_ESCAPE`) aus `services/gpsTrackBlobService.js` entfernt.
Kein Overhead im Hot-Path; Buffer-Normalisierung im Service unverändert.
982/982 Tests, Syntax und Zero-Warning-Lint bestanden. Deploy/Prüfung durch Benutzer ausstehend.

## MCP create_training_activity (2026-11-11)

- User möchte manuelle Trainingserfassung per Sprache/Text über KI-Client (Claude/Codex via MCP).
- Neues MCP-Tool `create_training_activity` mit Scope `activities:write` hinzugefügt.
- Ruft bestehenden `TrainingActivityDBService.create` + `invalidateAnalyticsOverviewCache` auf.
- Felder: `activity_type`, `start_time`, `duration_seconds` immer; Cycling braucht zusätzlich
  `workout_type`, `baseline_power_mode`, `baseline_power_value`; optional: `title`, `notes`,
  `perceived_exertion`, `estimated_tss`, `strength_focus`, `intervals` (max 20 Blöcke).
- KI fragt bei fehlenden Pflichtfeldern nach; `start_time` niemals selbst annehmen.
- Neuer Export `MCP_WRITE_TOOL_NAMES` in `mcpServerService.js`.
- `activities`-Parameter in `createTrainingMcpServer` für testbare Injektion.
- 985/985 Tests (3 neue), Syntax und Zero-Warning-Lint bestanden.
- Deploy und Re-Consent bestehender MCP-Clients (woa-chatgpt, woa-codex) nötig, um
  `activities:write` nutzen zu können. Neue Grants müssen Scope explizit anfordern.

## Sitzungsübergreifender Kontext

- **Verbindlich: Migrations-SQL niemals durch den Agenten ausführen, auch nicht indirekt über Runner oder Deployments. Nur erstellen/vorbereiten; ausschließlich der Benutzer führt Migrationen aus.** Ebenso in `AGENTS.md` festgehalten.

- Verbindliche Absprache: Dateien nur nach ausdrücklicher Bestätigung ändern. Vorher lesen, analysieren und einen konkreten Vorschlag zeigen. Die beschriebene UI-Überarbeitung einschließlich Scrollbereich wurde mit „ok los“ freigegeben.
- Anlass: Nach einem VS-Code-Neustart fehlte im Chat die vorherige Absprache zum Implementierungsumfang.
- `AGENTS.md` verweist auf diese Datei, damit kommende Sitzungen den dokumentierten Kontext wieder aufnehmen und fortschreiben.
- Diese Dateien ersetzen keinen vollständigen Chatverlauf und stellen keinen automatischen Chat-Import dar.
