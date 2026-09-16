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

Every command needs an API token, which you can create in the JSONPad
dashboard. For schema commands, the token needs the `sync-schema` permission,
plus permission for each change a sync makes.

In CI and scripts, set the `JSONPAD_TOKEN` environment variable:

```bash
export JSONPAD_TOKEN=<your token>
```

On your own machine, save tokens as profiles instead. The token is asked for
without being shown, or read from stdin:

```bash
jsonpad config set-profile prod
jsonpad config set-profile local --api-url http://localhost:3000

# Check which token you're using, what it can do, and how much quota is left
jsonpad whoami
jsonpad whoami --profile local
```

The first profile you add is the default. Profiles are saved in a config file
that only you can read (`jsonpad config path` shows where; set
`JSONPAD_CONFIG` to use a different file).

```bash
jsonpad config list             # tokens are masked
jsonpad config use local        # change the default profile
jsonpad config remove local
```

Which token a command uses, in order:

1. a profile chosen with `--profile` or `JSONPAD_PROFILE`
2. `JSONPAD_TOKEN`
3. the default profile

The API URL comes from `--api-url`, then the profile's URL, then
`JSONPAD_API_URL`, then `https://api.jsonpad.io`.

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

# Show the token, its plan's limits and this month's usage
jsonpad whoami
```

The schema commands are also available as `jsonpad schema sync`,
`jsonpad schema export` and `jsonpad schema move`.

Run `jsonpad --help`, or `jsonpad <command> --help`, for every option. The full
command reference is in [REFERENCE.md](REFERENCE.md).

### Output

Commands that output records (`whoami` and `config list` so far) print a table
in a terminal, and JSON when their output is piped or redirected, so
`jsonpad whoami | jq .usage` works. Choose a format with `--output` (`-o`):

| Format   | Output                                                   |
| -------- | -------------------------------------------------------- |
| `table`  | Columns, for reading                                     |
| `json`   | JSON (also `--json`)                                     |
| `ndjson` | One JSON record per line                                 |
| `id`     | One id per line, e.g. for `xargs` (also `--quiet`, `-q`) |

Data goes to stdout. Messages, warnings and questions go to stderr.

The schema commands keep their own output, and their `--json` option.

### Confirmations

Commands that delete something ask first. Where they can't ask (e.g. in a
script or CI), they refuse with exit code `5` unless you pass `--yes`.

### Rate limits

A request that's rate limited is retried after the delay the API asks for, up
to 5 times. A request refused because the monthly quota has run out isn't
retried.

`--verbose` (`-V`) logs each request to stderr, and afterwards, the rate limit
and quota left:

```bash
jsonpad whoami --verbose
```

## Continuous integration

```yaml
- name: Sync the JSONPad schema
  run: npx @basementuniverse/jsonpad-cli sync-schema --wait
  env:
    JSONPAD_TOKEN: ${{ secrets.JSONPAD_TOKEN }}
```

## Exit codes

| Code | Meaning                                                                 |
| ---- | ----------------------------------------------------------------------- |
| `0`  | Success                                                                 |
| `1`  | Error, including a sync refused because a change has errors             |
| `2`  | A sync was refused because it needs `--allow-rebuild`                   |
| `3`  | An index build failed, or didn't finish in time, while waiting          |
| `4`  | A sync was refused because it needs `--allow-destructive`               |
| `5`  | Refused because it needs confirmation: run again with `--yes`           |
| `6`  | Not found                                                               |
| `7`  | The token isn't allowed to do this, or isn't valid                      |
| `8`  | Rate limited (after retrying), or a plan limit or the quota was reached |

A dry run exits the same way the real sync would.

The schema commands (`sync-schema`, `export-schema`, `move-lists`) and
`rebuild-index` exit with `1` for every API error, as they did in the SDK.

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
