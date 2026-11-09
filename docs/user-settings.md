# User Settings

The authenticated `/profile` page groups settings into six local facets:

| Facet | Contents | Direct Link |
| --- | --- | --- |
| Profile | Personal data, including the independent fallback weight | `/profile#personal` |
| Body weight | Dated body-weight history, editing, and deletion | `/profile#weight-history` |
| Preferences | Language, units, default workout scope, optional Sudoku preference | `/profile#preferences` |
| Connections | Wahoo and Garmin | `/profile#connections` |
| Membership | Current membership, usage, plans, and upgrade | `/profile#membership` |
| Account | Personal API keys, account deletion and cancellation | `/profile#account` |

## Layout and Navigation

- Desktop uses a 200 px local navigation column below the existing page heading.
  The global app navigation is unchanged.
- Below 768 px, a labelled native select replaces the local navigation links.
- Facet changes update the URL fragment and support browser Back/Forward.
  The profile facet is the default for absent, unknown, or malformed fragments.
- Existing descendant anchors, including `#wahoo-settings` and
  `#garmin-settings-title`, open their containing facet and scroll to the target.
- Wahoo callback parameters select Connections when no fragment is supplied.
  Payment return parameters select Membership before the existing payment
  handler processes and removes them.
- All forms remain mounted, preserving unsaved values when switching facets.
  Existing save actions and API requests are unchanged. Shared profile,
  preference, and account feedback appears above the active facet.
- Without JavaScript, all facets remain visible and anchor links still work.

## Required Profile Weight

- Saving through `PUT /api/profile` requires a numeric `weightKg` greater than 0
  and at most 500 kg. Missing, empty, nonnumeric, boolean, and out-of-range values
  return HTTP 400 before opening a database connection.
- The profile weight input is required and supports two decimal places. Profile
  and preference saves both validate the profile form. Invalid fields reveal
  their containing facet and receive focus before native validation feedback.
- Existing database NULL values remain unchanged and readable. There is no
  migration, backfill, default value, or new database constraint. Accounts without
  a profile weight can still log in and use unrelated functionality, but must
  supply a valid profile weight on their next profile or preference save.
- Profile weight remains independent of dated history. History takes precedence
  for weight resolution; profile weight is the fallback. Without either value,
  weight remains unavailable. Saving profile weight does not create history
  entries or recalculate workouts.

## Implementation

`src/views/profile.ejs` owns the navigation and includes six partials from
`src/views/partials/profile/`. `src/public/js/profile-facets.js` controls only
visibility and URL navigation; existing profile/provider scripts retain their
responsibilities and element IDs. Layout styles are in `src/public/css/profile.css`.
Navigation labels are translated in all six existing browser locale files.

The original facet navigation requires no database changes, dependencies or npm
scripts. Personal API keys require the separately prepared migration below.

## Personal API Keys

`/profile#api-keys` opens key management inside the existing Account facet, with
labels in all six supported languages. Users can create named keys, select workout
read access and optionally GPS/FIT read access, inspect safe metadata and confirm
revocation. GPS requires workout read access; FIT requires both. FIT is initially
unchecked, has a six-language disclosure about full series/GPS/device data and
automatically selects its prerequisites. Removing a prerequisite clears FIT.
Existing keys retain their original scopes. The approved defaults are
five active keys and fixed 90-day validity; revoked and expired keys do not count
toward that limit. Active keys precede the bounded history so they remain visible.

The full key is returned only once, masked initially and optionally revealed or
copied. Dismissal and page exit erase the displayed value; it is not saved in
browser storage. Only its cryptographic hash is persisted on the server.
Pending account deletion disables creation, not revocation. Final deletion removes
the key records as part of the existing account-deletion transaction.

Management uses the authenticated browser session, a session-bound CSRF token and
same-origin checks. Keys cannot manage other keys or authenticate profile changes.
The separate Bearer middleware establishes trusted user ID, key ID and scopes
for the implemented public workout list/detail/GPS/FIT routes mounted at `/api/v1`
before browser sessions. Analytics endpoints and a local MCP server remain
deferred. See [public-api-v1.md](public-api-v1.md) for security and rollout
boundaries.

The user confirmed manual execution of `src/migrations/096_user_api_keys.sql`
on 2026-11-09; the target environment was not specified. The assistant did not
execute or independently verify it. The new key routes and final account deletion
require its table in the deployment target.
FIT scope issuance additionally requires manually applying prepared migration
`097_user_api_keys_fit_scope.sql`. It has not been executed by the assistant or
confirmed by the user. It changes only the scope constraint, not existing keys.
No new dependency or npm script is introduced. Current FIT completion passed all
930 tests, syntax, strict lint and types. An isolated browser fixture verified FIT
prerequisites, simulated issuance, existing scopes and secret dismissal using the
actual EJS partial and module. Earlier key-management checks included desktop/
mobile layout; the latest fixture does not verify the full profile layout.
Actual database execution and real-session/proxy integration remain unverified.
The user subsequently confirmed a successful manual API smoke test on 2026-11-09;
the environment and individual requests were not specified. Current REST
verification and remaining live checks are documented in [public-api-v1.md](public-api-v1.md).

## Workout Dashboard Type Group

The workout dashboard type menu and its native select include **Radsport**
(Cycling) immediately after All types. The group selects exactly the existing
`road`, `mountain` and `indoor` workout types; `unknown`, `motorsport`, NULL and
unrelated manual activity types are excluded. Existing individual choices remain
available. This is a filter group, not a new stored workout classification.

The selected filter uses `workoutType: "cycling"` in the existing per-user
workout-library view preferences and is restored when reopening the dashboard.
It remains separate from the broader activity-type Cycling filter, which may
include workouts with an unknown subtype. Both combined-feed branches and their
count/summary query use the same validated, parameterized type list before paging.
No migration, dependency or npm script is required.

## Administration Navigation

The authenticated administrator page `/admin/accounts` follows the same local
navigation pattern, without changing the user settings page or global navigation:

| Area | Contents | Direct Link |
| --- | --- | --- |
| Users and roles | User search and administrator permissions (default area) | `/admin/accounts#users` |
| Map material | Regional inventory and explicitly approved provisioning | `/admin/accounts#maps` |
| Database | PostgreSQL snapshots, isolated restore, activation, rollback and deletion | `/admin/accounts#database` |
| System backup | Portable system backup and component restore | `/admin/accounts#system-backup` |
| Accounts | Account JSON export and import | `/admin/accounts#accounts` |
| Segments | Segment ZIP export, preview and import | `/admin/accounts#segments` |
| Workouts | Workout ZIP export, preview and import | `/admin/accounts#workouts` |

Desktop uses the same 200 px navigation column; below 768 px a labelled native
select replaces the links. Only the active area is visible with navigation JS.
Absent, unknown and malformed fragments select Users and roles. Existing nested
anchors such as `#local-map-management`, `#database-backup-wizard` and
`#segment-backup-preview` reveal their containing area and scroll to the target.
Links and selection update the fragment with Back/Forward support. Forms and
controllers stay mounted; switching areas does not clear input values, selected
files, approvals or ongoing operation updates. Without navigation JS, all areas
remain visible and the native links remain available. Existing APIs and operation
handlers are unchanged.

`src/views/admin-accounts.ejs` owns the seven panel boundaries and navigation;
`src/public/js/admin-facets.js` controls visibility/history, and
`src/public/css/admin-accounts.css` provides the responsive layout. No profile
controller refactor, dependency, npm script or schema change is involved.

Verification: all 838 tests passed, including navigation and rendered-EJS checks
in `tests/admin-workout-preview-browser.test.js`. Syntax, lint and type checking
passed (70 existing lint warnings). An isolated full-EJS preview with actual
browser controllers and simulated read-only APIs checked all seven areas at
1365 px desktop and 390 px mobile, descendant links, invalid fragments, browser
Back/Forward, retained file selection and script-unavailable fallback. Desktop
and mobile screenshots were inspected; no horizontal page overflow was found.
This was not a live authenticated backend, Redis, backup/restore or database test.
