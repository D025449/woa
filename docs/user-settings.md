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