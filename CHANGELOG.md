# Changelog

All notable changes to `@basementuniverse/jsonpad-cli`.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Dates are npm publish dates.

## [Unreleased]

Needs `@basementuniverse/jsonpad-sdk` 2.1.0, and the JSONPad API release with
identity email addresses, password reset and provider sign-in.

### Added

- `--email` on `jsonpad identities create`, `update`, `register` and
  `self update`, with `--no-email` to remove an address. Identities show their
  email address, whether it's verified, and whether they have a password.
- `jsonpad identities login --email`, to log in with an email address instead
  of a name, and `jsonpad identities logout --all`, to end an identity's
  sessions everywhere.
- `jsonpad identities password-reset request|confirm` and
  `jsonpad identities email-verification request|confirm`, for issuing
  single-use tokens and using them.
- `jsonpad identities providers`, listing the sign-in providers enabled for an
  identity group, and `jsonpad identities self providers` with `list` and
  `unlink`, for the accounts an identity can sign in with.
- The identity event types added by the API: sessions revoked, password reset,
  email verification and linked accounts.

### Changed

- `jsonpad identities self update` takes `--current-password`, which the API
  now needs before it changes an identity's password or email address (unless
  the identity has no password). It's read from
  `JSONPAD_IDENTITY_CURRENT_PASSWORD`, or asked for in a terminal.

## [1.3.0] - 2026-09-16

### Removed

- The `xmlhttprequest-ssl` dependency. `jsonpad listen` needed it only because
  `@basementuniverse/jsonpad-realtime-sdk` couldn't connect from Node before
  version 1.6.0.

## [1.2.0] - 2026-09-16

### Added

- `jsonpad lists`, with `list`, `get`, `create`, `update` and `delete`.
- `jsonpad indexes`, with `list`, `get`, `create`, `update`, `delete`,
  `rebuild` (the same as `rebuild-index`) and `wait`. `create` and `update`
  can `--wait` for the index to be built.
- `jsonpad items`, with `list` (filter by indexes with `--where`), `get`,
  `create`, `update` and `delete`, and `jsonpad items data` with `get`, `set`,
  `replace`, `patch` and `delete`, for an item's data or part of it.
- `jsonpad identities`, with `list`, `get`, `create`, `update` and `delete`.
  Identities can be named by id or `group/name`. Passwords are asked for, or
  read from stdin or `JSONPAD_IDENTITY_PASSWORD`, never taken as an option.
- Options that take JSON accept JSON, `@file`, or `-` for stdin.
- Deletes ask for confirmation in a terminal, and need `--yes` elsewhere.
- `--all` and `--max` for commands that list things, to fetch every page.
- `jsonpad lists search`.
- `stats`, `events` and `event` for lists, items, indexes and identities, and
  `jsonpad items restore`.
- `jsonpad items export`, which outputs a list's items as NDJSON, and
  `jsonpad items import`, which creates items from NDJSON or a JSON array.
  Imports check every record first, keep to the plan's rate limits, and can
  `--dry-run` or `--continue-on-error`.
- Identity mode: `jsonpad identities register`, `login` (with `-o env` to set
  `JSONPAD_IDENTITY_TOKEN` and `JSONPAD_IDENTITY_GROUP`), `logout`, and
  `identities self` with `get`, `update` and `delete`. While
  `JSONPAD_IDENTITY_TOKEN` is set, commands that work with items act as the
  identity, and `whoami` says which one. `--identity-group` sets the group.
- `jsonpad listen`, which prints realtime events from lists and items. It
  connects to the production realtime server only.
- `jsonpad completion bash|zsh|fish`, for completing commands and options with
  Tab.

### Changed

- Retries after being rate limited are only mentioned on stderr when the wait
  is 5 seconds or more, or with `--verbose`.
- Piping output to a command that stops reading early (e.g. `head`) no longer
  prints an error.

## [1.1.0] - 2026-09-16

### Added

- Profiles: saved API tokens, so you don't need `JSONPAD_TOKEN` on your own
  machine. `jsonpad config set-profile`, `use`, `list`, `remove` and `path`
  manage them, in a config file only you can read. Choose one with
  `--profile` or `JSONPAD_PROFILE`. `JSONPAD_CONFIG` sets the config file.
- `jsonpad whoami`, which shows the token you're using, its permissions, its
  plan's limits and the account's usage this month.
- `--api-url`, which sets the API's URL for any command.
- `--verbose` (`-V`), which logs each request to stderr, and the rate limit and
  quota left after the command.
- `--output` (`-o`), `--json` and `--quiet` (`-q`) for commands that output
  records. The default is a table in a terminal, and JSON otherwise.
- Exit codes `5` (needs confirmation: run again with `--yes`), `6` (not
  found), `7` (the token isn't allowed, or isn't valid) and `8` (rate limited,
  or a plan limit or the quota was reached). The schema commands and
  `rebuild-index` still exit with `1` for every API error.

### Changed

- Rate limited requests are retried, up to 5 times, after the delay the API
  asks for (at most a minute). This includes the schema commands, which used to
  fail straight away. A request refused because the monthly quota has run out
  isn't retried.

## [1.0.0] - 2026-09-16

The `jsonpad` command, moved out of `@basementuniverse/jsonpad-sdk` (where
it's deprecated) into its own package.

### Added

- The `sync-schema`, `export-schema`, `move-lists` and `rebuild-index`
  commands. They have the same options, output, exit codes and API requests
  as the SDK's `jsonpad` command in `@basementuniverse/jsonpad-sdk` 1.13.0.
- `jsonpad schema sync`, `jsonpad schema export` and `jsonpad schema move`, as
  other names for `sync-schema`, `export-schema` and `move-lists`.
- Help for each command: `jsonpad <command> --help` and
  `jsonpad help <command>`.
- Suggestions for mistyped commands and options.
- A command reference, in `REFERENCE.md`.

### Changed

Compared with the SDK's `jsonpad` command:

- Needs Node.js 22.12 or later, instead of 18.3.
- Help text, and the messages for argument errors like an unknown option or a
  missing argument, come from the new argument parser, so they're worded
  differently. Their exit codes are the same.
- An option value can start with a dash, e.g. `--timeout -5`. The command then
  checks the value as usual, instead of the argument parser refusing it.
- Extra arguments are refused, e.g. a second file for `sync-schema`. They used
  to be ignored.
- `--version` prints this package's version.
