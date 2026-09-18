# JSONPad CLI

The `jsonpad` command line tool for [JSONPad](https://jsonpad.io).

Use it to manage lists, indexes, items and identities from the command line,
and to sync schema documents (lists and their indexes) with your account, e.g.
in a deploy script or CI.

There's a guide to it in the JSONPad docs:
[Command line tool](https://jsonpad.io/docs/command-line-tool).

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

### Lists, indexes, items and identities

```bash
# Lists
jsonpad lists
jsonpad lists create --name Recipes --path-name recipes --indexable
jsonpad lists get recipes
jsonpad lists update recipes --pinned --tags cookbook,public
jsonpad lists delete recipes

# Indexes, waiting for a new index to be built
jsonpad indexes recipes
jsonpad indexes create recipes --path-name title --pointer /title --alias --filtering --wait
jsonpad indexes wait recipes title

# Items: filter by an index with --where, and fetch an item by its alias
jsonpad items create recipes --data '{"title": "pancakes", "servings": 4}'
jsonpad items create recipes --data @waffles.json
jsonpad items recipes --where title=pancakes --order title
jsonpad items get recipes pancakes

# An item's data, or part of it by JSON pointer
jsonpad items data get recipes pancakes /ingredients
jsonpad items data set recipes pancakes --data '{"servings": 6}'
jsonpad items data replace recipes pancakes /ingredients --data '["flour", "eggs"]'
jsonpad items data patch recipes pancakes --patch @changes.json
jsonpad items data delete recipes pancakes /ingredients/0

# Identities, by id or group/name. Passwords are asked for, or read from stdin
jsonpad identities create --group staff --name ada --email ada@example.com
jsonpad identities get staff/ada
jsonpad identities update staff/ada --display-name Ada --password
```

Lists and indexes can be named by id or path name, and items by id or alias.
Options that take JSON (`--data`, `--schema`, `--patch`) accept JSON, `@file`,
or `-` to read from stdin. `--data` gives a list or index as a whole object,
and other options take precedence over it; for an item, `--data` is the item's
data.

Most commands have a short form: `jsonpad lists` is `jsonpad lists list`, and
`ls` and `rm` work in place of `list` and `delete`. Commands that list things
fetch one page, with `--page`, `--limit` (up to 100), `--order` and
`--direction`, or every page with `--all` (output as NDJSON, one record per
line, unless `--output` says otherwise). `--max` stops `--all` early.

```bash
# Every item's id, e.g. to pipe to xargs
jsonpad items recipes --all -q
```

### Search, stats and history

```bash
jsonpad lists search recipes pancake --include-items

# Counts by day: items, indexes and events
jsonpad lists stats recipes --days 30

# Lists, items, indexes and identities all have stats, events and event
jsonpad items events recipes pancakes --type item-updated --start-at 2026-09-01
jsonpad items event recipes pancakes <event> --include-snapshot

# Put an item back how it was after an event (or re-create a deleted item)
jsonpad items events recipes pancakes --restorable
jsonpad items restore recipes pancakes <event>
```

### Exporting and importing items

```bash
# Every item in a list as NDJSON, oldest first
jsonpad items export recipes --out recipes.ndjson

# Create the items again, e.g. in another list or account
jsonpad items import recipes-copy recipes.ndjson --dry-run
jsonpad items import recipes-copy recipes.ndjson

# Just the data, from one list into another
jsonpad items export recipes --data-only | jsonpad items import archive - --data-only
```

`import` reads NDJSON (one record per line) or a JSON array. Each record is an
item as `export` outputs it (its `data`, `description`, `tags` and `readonly`
are imported; ids and dates aren't), or with `--data-only`, an item's data.

Every record is checked before anything is created. Items are created one at a
time, at the pace the account's plan allows, so a large import can take a
while: on a plan with 60 requests a minute, about a second per item. The
import warns if it's bigger than the requests left this month.

If an item can't be created, the import stops and says how to import the rest.
With `--continue-on-error`, it carries on and lists the failures at the end.

### Acting as an identity

Apps built on JSONPad often log users in as identities, and items can belong to
the identity that created them. To see what an identity sees, log in as one:

```bash
jsonpad identities register --group players --name zed
eval "$(jsonpad identities login --group players --name zed -o env)"

# Items commands now act as players/zed
jsonpad items create scores --data '{"score": 42}'
jsonpad whoami                  # shows the identity too
jsonpad identities self update --display-name Zed
jsonpad identities logout
```

`login -o env` sets `JSONPAD_IDENTITY_TOKEN` (and `JSONPAD_IDENTITY_GROUP`).
While it's set, commands that work with items send the identity along with
the API token. Passwords are asked for in a terminal, or read from stdin or
`JSONPAD_IDENTITY_PASSWORD`. An identity can log in with its email address
instead of its name (`--email`), and `logout --all` ends its sessions
everywhere.

Changing an identity's own password or email address needs its current
password, which is asked for with `--current-password`, or read from
`JSONPAD_IDENTITY_CURRENT_PASSWORD`:

```bash
jsonpad identities self update --email zed@example.com --current-password
jsonpad identities self providers          # accounts it can sign in with
jsonpad identities self providers unlink google
```

### Password reset and email verification

JSONPad never sends email. It issues a single-use token, and your app sends it
to whoever owns the identity, with your own branding. Both halves of that flow
are here, for a server or a support script:

```bash
# Issue a reset token: by id, group/name, or --email
jsonpad identities password-reset request players/zed
jsonpad identities password-reset request --group players --email zed@example.com

# ...send it to them, then set the new password with it
jsonpad identities password-reset confirm <token>

# The same for verifying an email address
jsonpad identities email-verification request players/zed
jsonpad identities email-verification confirm <token>
```

Requesting a token needs the API token's `reset-password` or `verify-email`
permission. If the identity group sends tokens to a webhook, the request
answers `delivery: webhook` and the token goes there instead.

### Signing in with Google, GitHub and others

Providers are set up per identity group in the dashboard, and the sign-in
itself happens in a browser. From here you can see what's enabled, and manage
the accounts an identity can sign in with:

```bash
jsonpad identities providers --group players
jsonpad identities self providers
jsonpad identities self providers unlink github
```

### Realtime events

```bash
# Print events from lists with realtime turned on, until Ctrl+C
jsonpad listen recipes
jsonpad listen recipes --events item-created,item-deleted -o ndjson
jsonpad listen --items pancakes --count 1
```

`listen` connects to JSONPad's realtime server, so it only works with the
production API, not with `--api-url` or a profile for another API. Each plan
limits how many realtime connections an account can hold at once; a refused
connection is retried by itself.

### Schema sync

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
`jsonpad schema export` and `jsonpad schema move`, and `rebuild-index` as
`jsonpad indexes rebuild`.

Run `jsonpad --help`, or `jsonpad <command> --help`, for every option. The full
command reference is in [REFERENCE.md](REFERENCE.md).

### Output

Commands that output records print a table in a terminal, and JSON when their
output is piped or redirected, so `jsonpad lists get recipes | jq .itemCount`
works. Choose a format with `--output` (`-o`):

| Format   | Output                                                   |
| -------- | -------------------------------------------------------- |
| `table`  | Columns, for reading                                     |
| `json`   | JSON (also `--json`)                                     |
| `ndjson` | One JSON record per line                                 |
| `id`     | One id per line, e.g. for `xargs` (also `--quiet`, `-q`) |

`jsonpad items data get` always outputs the data itself, as JSON (or NDJSON
with `-o ndjson`).

Data goes to stdout. Messages, warnings and questions go to stderr.

The schema commands keep their own output, and their `--json` option.

### Confirmations

Commands that delete something ask first. Where they can't ask (e.g. in a
script or CI), they refuse with exit code `5` unless you pass `--yes`.

### Rate limits

A request that's rate limited is retried after the delay the API asks for, up
to 5 times, which is mentioned on stderr if the wait is 5 seconds or more. A
request refused because the monthly quota has run out isn't retried.

`--verbose` (`-V`) logs each request to stderr, and afterwards, the rate limit
and quota left:

```bash
jsonpad whoami --verbose
```

### Shell completion

```bash
# bash: add to ~/.bashrc
eval "$(jsonpad completion bash)"

# zsh: add to ~/.zshrc, after compinit
eval "$(jsonpad completion zsh)"

# fish
jsonpad completion fish > ~/.config/fish/completions/jsonpad.fish
```

Commands, options and their choices are completed. Lists, items and other
names from your account aren't, since that would make a request every time you
press Tab.

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

Versions 1.12 to 1.14 of `@basementuniverse/jsonpad-sdk` included a `jsonpad`
command, which was removed in SDK 2.0.0. This package has the same commands,
options, output and exit codes, so to switch, replace
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
the SDK's command did. They run each scenario against a fake API and compare
the output, exit code, requests and files against golden files in
`test/parity/golden`, which were recorded from the SDK's command before it was
removed.

### Publishing

npm lifecycle scripts may be turned off (`ignore-scripts`), so build and test
explicitly:

```bash
npm test
npm publish --access public
```

## License

MIT
