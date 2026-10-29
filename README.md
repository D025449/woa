# simple-nodejs-app

Simple-nodejs-app is a simple web application created using [Node.js](https://github.com/nodejs/node). It uses [MediaWiki - Wikipedia's Search API](https://www.mediawiki.org/wiki/API:Opensearch) to search for anything entered by the user and parses the result in a JSON format. The infobox of the Wikipedia page is parsed using [wiki-infobox-parser](https://github.com/0x333333/wiki-infobox-parser).

## Download and Installation

- Clone the repo ```https://github.com/rat9615/simple-nodejs-app```
- [Fork, Clone or Download on Github](https://github.com/rat9615/simple-nodejs-app)

## Usage

- After installation, run ```npm install``` to download and install all the required dependencies.
- Run ```npm start``` to run the web application.

### One-time GPS segment best-effort rebuild

The versioned GPS segment best-effort rebuild uses the shared compact matcher and defaults to a
non-destructive dry-run. Apply mode replaces each bounded workout batch transactionally and stores
its checkpoint only after the replacement succeeds. Re-running an interrupted apply resumes from
the last checkpoint. A completed version refuses to run again unless `--rerun-completed` is supplied
deliberately.

```sh
# Development dry-run
npm run migrate:gps-segment-best-efforts -- --batch-size 100

# Development apply
npm run migrate:gps-segment-best-efforts -- --apply --confirm-db cwa24_dev

# Production apply
NODE_ENV=production npm run migrate:gps-segment-best-efforts -- --apply --confirm-db cwa24_prod
```

Use `--limit <count>` for a bounded trial; an applied limited run remains resumable and is not marked
complete. The `--confirm-db` value must exactly match PostgreSQL's `current_database()`. Do not use
`--rerun-completed` unless the completed version is intentionally being repeated from workout ID 0.

## Live Preview

To view a live preview of this application, click [here](https://desolate-coast-53201.herokuapp.com/)
