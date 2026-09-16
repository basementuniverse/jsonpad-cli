# Changelog

All notable changes to `@basementuniverse/jsonpad-cli`.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Dates are npm publish dates.

## [1.0.0] - Unreleased

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
