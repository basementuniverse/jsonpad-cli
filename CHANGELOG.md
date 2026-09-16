# Changelog

All notable changes to `@basementuniverse/jsonpad-cli`.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Dates are npm publish dates.

## [1.1.0] - 2024-06-06

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

## [1.0.0] - 2024-06-06

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
