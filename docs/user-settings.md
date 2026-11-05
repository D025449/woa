# User Settings

The authenticated `/profile` page groups settings into six local facets:

| Facet | Contents | Direct Link |
| --- | --- | --- |
| Profile | Personal data, including the independent fallback weight | `/profile#personal` |
| Body weight | Dated body-weight history, editing, and deletion | `/profile#weight-history` |
| Preferences | Language, units, default workout scope, optional Sudoku preference | `/profile#preferences` |
| Connections | Wahoo and Garmin | `/profile#connections` |
| Membership | Current membership, usage, plans, and upgrade | `/profile#membership` |
| Account | Account deletion and cancellation | `/profile#account` |

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

No database changes, migrations, new dependencies, or npm scripts are required.

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