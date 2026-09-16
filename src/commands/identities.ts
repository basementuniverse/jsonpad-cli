import { Option, type Command } from 'commander';
import type { Context, IdentityAuth } from '../context.ts';
import { apiError, apiErrorExitCode, CliError } from '../errors.ts';
import { canPrompt, confirm, promptSecret, readStdin } from '../input.ts';
import {
  addOutputOptions,
  formatTimestamp,
  printRecord,
  renderDetails,
  resolveOutputFormat,
  type OutputOptions,
  type RecordOutput,
  type RecordsOutput,
} from '../output.ts';
import {
  addAllOption,
  addPagingOptions,
  addTaggedOption,
  addTagsOption,
  nullable,
  removeUndefined,
  printPages,
  request,
  resolveIdentityId,
  type AllOptions,
  type PagingOptions,
} from '../resources.ts';
import { JSONPadError, type Identity, type JSONPad } from '../sdk.ts';
import { defineEventCommands, defineStatsCommand } from './history.ts';

const ORDER_FIELDS = [
  'createdAt',
  'updatedAt',
  'name',
  'displayName',
  'group',
  'activated',
];

const IDENTITY_ARGUMENT_DESCRIPTION =
  'The identity: its id, group/name, or the name of an identity without a group';

type IdentityFields = {
  group?: string;
  name?: string;
  displayName?: string | false;
  tags?: string[];
};

export function identityLabel(identity: Identity): string {
  return identity.group ? `${identity.group}/${identity.name}` : identity.name;
}

function identityOutput(
  context: Context
): RecordOutput<Identity> & RecordsOutput<Identity> {
  const { dim } = context.colours;

  return {
    id: identity => identity.id,
    details: identity => [
      ['ID', identity.id],
      ['Group', identity.group || dim('(none)')],
      ['Name', identity.name],
      ['Display name', identity.displayName ?? dim('(none)')],
      [
        'Tags',
        identity.tags?.length ? identity.tags.join(', ') : dim('(none)'),
      ],
      [
        'Last login',
        identity.lastLoginAt
          ? formatTimestamp(identity.lastLoginAt)
          : dim('never'),
      ],
      ['Created', formatTimestamp(identity.createdAt)],
      ['Updated', formatTimestamp(identity.updatedAt)],
    ],
    columns: [
      { header: 'ID', value: identity => identity.id },
      { header: 'GROUP', value: identity => identity.group || '-' },
      { header: 'NAME', value: identity => identity.name },
      {
        header: 'DISPLAY NAME',
        value: identity => identity.displayName ?? '-',
      },
      {
        header: 'LAST LOGIN',
        value: identity =>
          identity.lastLoginAt ? formatTimestamp(identity.lastLoginAt) : '-',
      },
    ],
    empty: 'No identities',
  };
}

/**
 * Read a password: from JSONPAD_IDENTITY_PASSWORD, asked for in a terminal, or
 * from stdin. Passwords are never taken from an option, which would leave them
 * in shell history
 */
async function readPassword(context: Context, label: string): Promise<string> {
  let password = context.env.JSONPAD_IDENTITY_PASSWORD;

  if (password === undefined) {
    password = canPrompt(context)
      ? await promptSecret(context, `Password for ${label}: `)
      : (await readStdin(context)).replace(/\r?\n$/, '');
  }

  if (!password) {
    throw new CliError(
      canPrompt(context)
        ? 'A password is needed'
        : 'A password is needed. Pass it on stdin, or set JSONPAD_IDENTITY_PASSWORD'
    );
  }

  return password;
}

function addIdentityFieldOptions(command: Command, update: boolean): Command {
  command
    .option(
      '--group <group>',
      'The group, which separates identities with the same name'
    )
    .option('--name <name>', 'The name, used to log in')
    .option('--display-name <name>', 'The name to show');
  addTagsOption(command);

  if (update) {
    command
      .option('--no-display-name', 'Remove the display name')
      .option(
        '--password',
        'Change the password: asked for in a terminal, or read from stdin or JSONPAD_IDENTITY_PASSWORD'
      );
  }

  return command;
}

export function defineIdentities(command: Command, context: Context): Command {
  command.description('Create, view, change and delete identities');

  const list = command
    .command('list', { isDefault: true })
    .alias('ls')
    .description('List identities (the default when no command is given)')
    .option('--group <group>', 'Only identities whose group contains this')
    .option('--name <name>', 'Only identities whose name contains this')
    .option(
      '--display-name <name>',
      'Only identities whose display name contains this'
    );
  addTaggedOption(list);
  addAllOption(list);
  addPagingOptions(list, { choices: ORDER_FIELDS });
  addOutputOptions(list).action(
    async (
      options: PagingOptions &
        AllOptions &
        OutputOptions & {
          group?: string;
          name?: string;
          displayName?: string;
          tagged?: string[];
        }
    ) => {
      const jsonpad = context.createClient();
      await printPages(
        context,
        options,
        paging =>
          jsonpad.fetchIdentities(
            removeUndefined({
              ...paging,
              group: options.group,
              name: options.name,
              displayName: options.displayName,
              tagged: options.tagged,
            }) as Parameters<typeof jsonpad.fetchIdentities>[0]
          ),
        identityOutput(context)
      );
    }
  );

  addOutputOptions(
    command
      .command('get')
      .description('Show an identity')
      .argument('<identity>', IDENTITY_ARGUMENT_DESCRIPTION)
  ).action(async (reference: string, options: OutputOptions) => {
    const format = resolveOutputFormat(context, options);
    const jsonpad = context.createClient();
    const id = await resolveIdentityId(context, jsonpad, reference);
    const identity = await request(context, () => jsonpad.fetchIdentity(id));

    printRecord(context, format, identity, identityOutput(context));
  });

  addOutputOptions(
    addIdentityFieldOptions(
      command
        .command('create')
        .description(
          'Create an identity. The password is asked for in a terminal, or read from stdin or JSONPAD_IDENTITY_PASSWORD'
        ),
      false
    )
  ).action(async (options: IdentityFields & OutputOptions) => {
    const format = resolveOutputFormat(context, options);

    if (!options.name) {
      throw new CliError('An identity needs a name: pass --name');
    }

    const label = options.group
      ? `${options.group}/${options.name}`
      : options.name;
    const password = await readPassword(context, label);
    const jsonpad = context.createClient();
    const identity = await request(context, () =>
      jsonpad.createIdentity(
        removeUndefined({
          group: options.group || undefined,
          name: options.name,
          displayName: options.displayName || undefined,
          tags: options.tags,
          password,
        }) as Parameters<typeof jsonpad.createIdentity>[0]
      )
    );

    printRecord(context, format, identity, identityOutput(context));
  });

  addOutputOptions(
    addIdentityFieldOptions(
      command
        .command('update')
        .description(
          "Change an identity. Fields that aren't given are left as they are"
        )
        .argument('<identity>', IDENTITY_ARGUMENT_DESCRIPTION),
      true
    )
  ).action(
    async (
      reference: string,
      options: IdentityFields & OutputOptions & { password?: boolean }
    ) => {
      const format = resolveOutputFormat(context, options);
      const jsonpad = context.createClient();
      const id = await resolveIdentityId(context, jsonpad, reference);
      const password = options.password
        ? await readPassword(context, reference)
        : undefined;
      const identity = await request(context, () =>
        jsonpad.updateIdentity(
          id,
          removeUndefined({
            group: options.group,
            name: options.name,
            displayName: nullable(options.displayName),
            tags: options.tags,
            password,
          }) as Parameters<typeof jsonpad.updateIdentity>[1]
        )
      );

      printRecord(context, format, identity, identityOutput(context));
    }
  );

  command
    .command('delete')
    .alias('rm')
    .description('Delete an identity')
    .argument('<identity>', IDENTITY_ARGUMENT_DESCRIPTION)
    .option('-y, --yes', "Don't ask for confirmation")
    .action(async (reference: string, options: { yes?: boolean }) => {
      const jsonpad = context.createClient();
      let question = `Delete the identity ${reference}?`;
      let id: string | undefined;

      // Only look up what's being deleted when there's someone to show it to
      if (!options.yes && canPrompt(context)) {
        id = await resolveIdentityId(context, jsonpad, reference);
        const identity = await request(context, () =>
          jsonpad.fetchIdentity(id!)
        );
        question = `Delete the identity ${identityLabel(identity)} (${identity.id})?`;
      }

      await confirm(context, { question, yes: options.yes });
      id ??= await resolveIdentityId(context, jsonpad, reference);

      await request(context, () => jsonpad.deleteIdentity(id));

      context.error(`Deleted the identity ${context.colours.bold(reference)}`);
    });

  defineIdentityModeCommands(command, context);

  const target = {
    arguments: [['<identity>', IDENTITY_ARGUMENT_DESCRIPTION]] as [
      string,
      string,
    ][],
    resolve: async (jsonpad: JSONPad, [reference]: string[]) => [
      await resolveIdentityId(context, jsonpad, reference),
    ],
  };

  defineStatsCommand(command, context, {
    ...target,
    description: "Show an identity's events, by day",
    fetch: (jsonpad, [id], parameters) =>
      jsonpad.fetchIdentityStats(id, parameters),
  });

  defineEventCommands(command, context, {
    ...target,
    noun: 'identity',
    types: [
      'identity-created',
      'identity-updated',
      'identity-deleted',
      'identity-registered',
      'identity-logged-in',
      'identity-logged-out',
      'identity-updated-self',
      'identity-deleted-self',
    ],
    fetchEvents: (jsonpad, [id], parameters) =>
      jsonpad.fetchIdentityEvents(id, parameters),
    fetchEvent: (jsonpad, [id], eventId, parameters) =>
      jsonpad.fetchIdentityEvent(id, eventId, parameters),
  });

  return command;
}

/**
 * Leave out the identity in JSONPAD_IDENTITY_TOKEN, for requests that don't
 * act as it (e.g. logging in as a different identity)
 */
const NO_IDENTITY = { ignore: true, token: '' };

/**
 * Quote a value for a POSIX shell
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function requireIdentity(context: Context): IdentityAuth {
  if (!context.identity) {
    throw new CliError(
      'This needs an identity token in JSONPAD_IDENTITY_TOKEN. Log in with: eval "$(jsonpad identities login --name <name> -o env)"'
    );
  }

  return context.identity;
}

function defineIdentityModeCommands(command: Command, context: Context): void {
  addOutputOptions(
    addTagsOption(
      command
        .command('register')
        .summary('Register an identity, as an app would for a new user')
        .description(
          "Register an identity, as an app would for a new user. Unlike create, this needs the token's register permission. The password is asked for in a terminal, or read from stdin or JSONPAD_IDENTITY_PASSWORD"
        )
        .option('--group <group>', 'The group')
        .option('--name <name>', 'The name, used to log in')
        .option('--display-name <name>', 'The name to show')
    )
  ).action(
    async (
      options: OutputOptions & {
        group?: string;
        name?: string;
        displayName?: string;
      }
    ) => {
      const format = resolveOutputFormat(context, options);

      if (!options.name) {
        throw new CliError('An identity needs a name: pass --name');
      }

      const password = await readPassword(
        context,
        options.group ? `${options.group}/${options.name}` : options.name
      );
      const jsonpad = context.createClient();
      const identity = await request(context, () =>
        jsonpad.registerIdentity(
          removeUndefined({
            group: options.group || undefined,
            name: options.name,
            displayName: options.displayName || undefined,
            password,
          }) as Parameters<typeof jsonpad.registerIdentity>[0],
          NO_IDENTITY
        )
      );

      printRecord(context, format, identity, identityOutput(context));
    }
  );

  command
    .command('login')
    .summary('Log in as an identity, to act as it')
    .description(
      'Log in as an identity, and output its identity token. Set JSONPAD_IDENTITY_TOKEN (and JSONPAD_IDENTITY_GROUP) to it to act as the identity when working with items, e.g. eval "$(jsonpad identities login --name ada -o env)". The password is asked for in a terminal, or read from stdin or JSONPAD_IDENTITY_PASSWORD'
    )
    .option('--group <group>', "The identity's group")
    .option('--name <name>', "The identity's name")
    .addOption(
      new Option(
        '-o, --output <format>',
        'Output format: table (the default in a terminal), json (the default otherwise), env (export commands for a POSIX shell), or token (just the token)'
      ).choices(['table', 'json', 'env', 'token'])
    )
    .action(
      async (options: {
        group?: string;
        name?: string;
        output?: 'table' | 'json' | 'env' | 'token';
      }) => {
        if (!options.name) {
          throw new CliError("Pass the identity's name with --name");
        }

        const format =
          options.output ?? (context.stdout.isTTY ? 'table' : 'json');
        const label = options.group
          ? `${options.group}/${options.name}`
          : options.name;
        const password = await readPassword(context, label);
        const jsonpad = context.createClient();
        const [identity, token] = await request(context, async () => {
          try {
            return await jsonpad.loginIdentity(
              removeUndefined({
                group: options.group || undefined,
                name: options.name,
                password,
              }) as Parameters<typeof jsonpad.loginIdentity>[0],
              NO_IDENTITY
            );
          } catch (error) {
            // Failed logins lock the identity for a while, which isn't worth
            // retrying automatically
            if (
              error instanceof JSONPadError &&
              error.errorName === 'IDENTITY_TOO_MANY_ATTEMPTS'
            ) {
              throw new CliError(
                `${apiError(error).message}. Wait a few seconds and try again: the wait doubles after each failed attempt`,
                apiErrorExitCode(error)
              );
            }
            throw error;
          }
        });

        if (!token) {
          throw new CliError("The API didn't return an identity token");
        }

        const group = identity.group || null;

        switch (format) {
          case 'token':
            context.log(token);
            break;
          case 'env':
            context.log(`export JSONPAD_IDENTITY_TOKEN=${shellQuote(token)}`);
            context.log(
              group
                ? `export JSONPAD_IDENTITY_GROUP=${shellQuote(group)}`
                : 'unset JSONPAD_IDENTITY_GROUP'
            );
            break;
          case 'json':
            context.log(JSON.stringify({ identity, token }, null, 2));
            break;
          case 'table':
            context.log(renderIdentityWithToken(context, identity, token));
            context.error(
              context.colours.dim(
                `To act as ${label}, set JSONPAD_IDENTITY_TOKEN${
                  group ? ' and JSONPAD_IDENTITY_GROUP' : ''
                }, e.g. with: eval "$(jsonpad identities login ${
                  group ? `--group ${shellQuote(group)} ` : ''
                }--name ${shellQuote(options.name)} -o env)"`
              )
            );
            break;
        }
      }
    );

  command
    .command('logout')
    .description(
      'Log out the identity in JSONPAD_IDENTITY_TOKEN, so that its token stops working'
    )
    .action(async () => {
      const jsonpad = context.createClient();
      requireIdentity(context);
      await request(context, () => jsonpad.logoutIdentity());

      context.error(
        'Logged out. Unset JSONPAD_IDENTITY_TOKEN and JSONPAD_IDENTITY_GROUP'
      );
    });

  const self = command
    .command('self')
    .description(
      'View, change or delete the identity in JSONPAD_IDENTITY_TOKEN, as the identity itself'
    );

  addOutputOptions(
    self
      .command('get', { isDefault: true })
      .description(
        'Show the identity in JSONPAD_IDENTITY_TOKEN (the default when no command is given)'
      )
  ).action(async (options: OutputOptions) => {
    const format = resolveOutputFormat(context, options);
    const jsonpad = context.createClient();
    requireIdentity(context);
    const identity = await request(context, () => jsonpad.fetchSelfIdentity());

    printRecord(context, format, identity, identityOutput(context));
  });

  addOutputOptions(
    self
      .command('update')
      .description(
        "Change the identity in JSONPAD_IDENTITY_TOKEN. Fields that aren't given are left as they are"
      )
      .option('--name <name>', 'The name, used to log in')
      .option('--display-name <name>', 'The name to show')
      .option('--no-display-name', 'Remove the display name')
      .option(
        '--password',
        'Change the password: asked for in a terminal, or read from stdin or JSONPAD_IDENTITY_PASSWORD'
      )
  ).action(
    async (
      options: OutputOptions & {
        name?: string;
        displayName?: string | false;
        password?: boolean;
      }
    ) => {
      const format = resolveOutputFormat(context, options);
      const jsonpad = context.createClient();
      requireIdentity(context);
      const password = options.password
        ? await readPassword(context, 'this identity')
        : undefined;
      const identity = await request(context, () =>
        jsonpad.updateSelfIdentity(
          removeUndefined({
            name: options.name,
            displayName: nullable(options.displayName),
            password,
          }) as Parameters<typeof jsonpad.updateSelfIdentity>[0]
        )
      );

      printRecord(context, format, identity, identityOutput(context));
    }
  );

  self
    .command('delete')
    .alias('rm')
    .description('Delete the identity in JSONPAD_IDENTITY_TOKEN')
    .option('-y, --yes', "Don't ask for confirmation")
    .action(async (options: { yes?: boolean }) => {
      const jsonpad = context.createClient();
      requireIdentity(context);
      let question = 'Delete the identity in JSONPAD_IDENTITY_TOKEN?';

      if (!options.yes && canPrompt(context)) {
        const identity = await request(context, () =>
          jsonpad.fetchSelfIdentity()
        );
        question = `Delete the identity ${identityLabel(identity)} (${identity.id})?`;
      }

      await confirm(context, { question, yes: options.yes });
      await request(context, () => jsonpad.deleteSelfIdentity());

      context.error(
        'Deleted the identity. Unset JSONPAD_IDENTITY_TOKEN and JSONPAD_IDENTITY_GROUP'
      );
    });
}

function renderIdentityWithToken(
  context: Context,
  identity: Identity,
  token: string
): string {
  const rows = identityOutput(context).details(identity);

  return renderDetails([...rows, ['Token', token]]);
}
