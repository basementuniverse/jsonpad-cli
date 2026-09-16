# JSONPad CLI

The `jsonpad` command line tool for [JSONPad](https://jsonpad.io).

It syncs schema documents (lists and their indexes) with your account, for
example in a deploy script or CI.

## Install

The tool needs Node.js 22.12 or later.

```bash
# Install the jsonpad command globally
npm install -g @basementuniverse/jsonpad-cli

# Or run it without installing
npx @basementuniverse/jsonpad-cli sync-schema --dry-run

# Or add it to a project, and run it with npx jsonpad
npm install --save-dev @basementuniverse/jsonpad-cli
```

## Authentication

The tool reads an API token from the `JSONPAD_TOKEN` environment variable.
Create a token in the JSONPad dashboard.

```bash
export JSONPAD_TOKEN=<your token>
```

For schema commands, the token needs the `sync-schema` permission, plus
permission for each change a sync makes.

Set `JSONPAD_API_URL` to use a different API, e.g. a local server.

## Usage

```bash
# See what a sync would change, then apply it
jsonpad sync-schema --dry-run
jsonpad sync-schema

# Sync a different file, and wait for index builds to finish
jsonpad sync-schema schemas/recipes.json --wait

# Also delete the lists and indexes the document's scope no longer declares
jsonpad sync-schema --prune --dry-run

# Write a schema document for existing lists
jsonpad export-schema --tagged recipe-app --out jsonpad-schema.json

# Move lists to another scope, or rename a scope
jsonpad move-lists recipes ratings --to cookbook-app
jsonpad move-lists --from-scope recipe-app --to cookbook-app

# Rebuild an index whose last build failed
jsonpad rebuild-index recipes title --wait
```

The schema commands are also available as `jsonpad schema sync`,
`jsonpad schema export` and `jsonpad schema move`.

Run `jsonpad --help`, or `jsonpad <command> --help`, for every option. The full
command reference is in [REFERENCE.md](REFERENCE.md).

## Continuous integration

```yaml
- name: Sync the JSONPad schema
  run: npx @basementuniverse/jsonpad-cli sync-schema --wait
  env:
    JSONPAD_TOKEN: ${{ secrets.JSONPAD_TOKEN }}
```

## Exit codes

| Code | Meaning                                                        |
| ---- | -------------------------------------------------------------- |
| `0`  | Success                                                        |
| `1`  | Error, including a sync refused because a change has errors    |
| `2`  | A sync was refused because it needs `--allow-rebuild`          |
| `3`  | An index build failed, or didn't finish in time, while waiting |
| `4`  | A sync was refused because it needs `--allow-destructive`      |

A dry run exits the same way the real sync would.

## Moving from the SDK's `jsonpad` command

Versions 1.12 and 1.13 of `@basementuniverse/jsonpad-sdk` include a `jsonpad`
command. It's deprecated, and it will be removed in SDK 2.0.0. This package has
the same commands, options, output and exit codes, so to switch, replace
`npx @basementuniverse/jsonpad-sdk` with `npx @basementuniverse/jsonpad-cli`.

If you installed the SDK globally to get the command, uninstall it first.
Otherwise npm refuses to install this package, because both packages provide a
`jsonpad` command:

```bash
npm uninstall -g @basementuniverse/jsonpad-sdk
npm install -g @basementuniverse/jsonpad-cli
```

## Development

```bash
npm install
npm test            # builds, then runs the unit and parity tests
npm run reference   # regenerates REFERENCE.md after changing a command
```

`npm test` fails when `REFERENCE.md` is out of date.

The parity tests check that the commands ported from the SDK behave exactly as
the SDK's `bin/jsonpad.js` does. They run each scenario against a fake API and
compare the output, exit code, requests and files against golden files in
`test/parity/golden`. Those files were recorded from the SDK's command with:

```bash
npm run record-parity -- ../jsonpad-sdk-js/bin/jsonpad.js
```

Only re-record them to add scenarios while the SDK still has its command.

### Publishing

npm lifecycle scripts may be turned off (`ignore-scripts`), so build and test
explicitly:

```bash
npm test
npm publish --access public
```

## License

MIT
