import { Option, type Command } from 'commander';
import type { Context, IdentityAuth } from '../context.ts';
import { apiError, apiErrorExitCode, CliError } from '../errors.ts';
import { canPrompt, confirm, promptSecret, readStdin } from '../input.ts';
import {
  addOutputOptions,
  formatTimestamp,
  printRecord,
  printRecords,
  renderDetails,
  resolveOutputFormat,
  type OutputFormat,
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
  UUID,
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
  email?: string | false;
  tags?: string[];
};

/**
 * The sign-in providers identities can use, for showing a name rather than an
 * id. An unknown provider (one added to the API since this release) is shown
 * as it comes
 */
const PROVIDER_NAMES: Record<string, string> = {
  google: 'Google',
  github: 'GitHub',
  apple: 'Apple',
  microsoft: 'Microsoft',
  discord: 'Discord',
  facebook: 'Facebook',
};

export function providerLabel(provider: string): string {
  return PROVIDER_NAMES[provider] ?? provider;
}

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
      ...(identity.email === undefined
        ? []
        : ([
            [
              'Email',
              identity.email
                ? `${identity.email}${
                    identity.emailVerified ? '' : dim(' (not verified)')
                  }`
                : dim('(none)'),
            ],
          ] as [string, string][])),
      ...(identity.hasPassword === undefined
        ? []
        : ([['Password', identity.hasPassword ? 'Set' : dim('not set')]] as [
            string,
            string,
          ][])),
      ...(identity.sessionCount === undefined
        ? []
        : ([['Sessions', String(identity.sessionCount)]] as [
            string,
            string,
          ][])),
      ...(identity.providers?.length
        ? ([
            [
              'Sign-in accounts',
              identity.providers
                .map(account => providerLabel(account.provider))
                .join(', '),
            ],
          ] as [string, string][])
        : []),
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

/**
 * Read an identity's current password, which the API needs before it changes
 * a password or an email address
 */
async function readCurrentPassword(context: Context): Promise<string> {
  const password =
    context.env.JSONPAD_IDENTITY_CURRENT_PASSWORD ??
    (canPrompt(context)
      ? await promptSecret(context, 'Current password: ')
      : undefined);

  if (!password) {
    throw new CliError(
      canPrompt(context)
        ? 'The current password is needed'
        : 'The current password is needed. Set JSONPAD_IDENTITY_CURRENT_PASSWORD'
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
    .option('--display-name <name>', 'The name to show')
    .option(
      '--email <email>',
      'The email address, which can also be used to log in'
    );
  addTagsOption(command);

  if (update) {
    command
      .option('--no-display-name', 'Remove the display name')
      .option('--no-email', 'Remove the email address')
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
          email: options.email || undefined,
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
            email: nullable(options.email),
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
  defineTokenCommands(command, context);
  defineProviderCommands(command, context);

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
      'identity-sessions-revoked',
      'identity-password-reset-requested',
      'identity-password-reset',
      'identity-email-verification-requested',
      'identity-email-verified',
      'identity-provider-linked',
      'identity-provider-unlinked',
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
        .option(
          '--email <email>',
          'The email address, which can also be used to log in'
        )
    )
  ).action(
    async (
      options: OutputOptions & {
        group?: string;
        name?: string;
        displayName?: string;
        email?: string;
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
            email: options.email || undefined,
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
    .option(
      '--email <email>',
      "The identity's email address, instead of a name"
    )
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
        email?: string;
        output?: 'table' | 'json' | 'env' | 'token';
      }) => {
        if (!options.name && !options.email) {
          throw new CliError(
            "Pass the identity's name with --name, or its email address with --email"
          );
        }

        if (options.name && options.email) {
          throw new CliError('Pass either --name or --email, not both');
        }

        const format =
          options.output ?? (context.stdout.isTTY ? 'table' : 'json');
        const nameOrEmail = (options.name ?? options.email)!;
        const label = options.group
          ? `${options.group}/${nameOrEmail}`
          : nameOrEmail;
        const password = await readPassword(context, label);
        const jsonpad = context.createClient();
        const [identity, token] = await request(context, async () => {
          try {
            return await jsonpad.loginIdentity(
              removeUndefined({
                group: options.group || undefined,
                ...(options.email
                  ? { email: options.email }
                  : { name: options.name }),
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
                }${
                  options.email
                    ? `--email ${shellQuote(options.email)}`
                    : `--name ${shellQuote(options.name!)}`
                } -o env)"`
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
    .option(
      '--all',
      'Log the identity out everywhere, ending its sessions on every device'
    )
    .action(async (options: { all?: boolean }) => {
      const jsonpad = context.createClient();
      requireIdentity(context);
      await request(context, () =>
        jsonpad.logoutIdentity(undefined, { all: options.all })
      );

      context.error(
        `${
          options.all ? 'Logged out everywhere' : 'Logged out'
        }. Unset JSONPAD_IDENTITY_TOKEN and JSONPAD_IDENTITY_GROUP`
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
        '--email <email>',
        'The email address, which needs verifying again'
      )
      .option('--no-email', 'Remove the email address')
      .option(
        '--password',
        'Change the password: asked for in a terminal, or read from stdin or JSONPAD_IDENTITY_PASSWORD'
      )
      .option(
        '--current-password',
        "The identity's current password, needed to change its password or email address. Asked for in a terminal, or read from JSONPAD_IDENTITY_CURRENT_PASSWORD"
      )
  ).action(
    async (
      options: OutputOptions & {
        name?: string;
        displayName?: string | false;
        email?: string | false;
        password?: boolean;
        currentPassword?: boolean;
      }
    ) => {
      const format = resolveOutputFormat(context, options);
      const jsonpad = context.createClient();
      requireIdentity(context);

      // The API needs the current password to change a password or an email
      // address, unless the identity has no password (e.g. it signed in with
      // Google)
      const currentPassword = options.currentPassword
        ? await readCurrentPassword(context)
        : undefined;
      const password = options.password
        ? await readPassword(context, 'this identity')
        : undefined;
      const identity = await request(context, () =>
        jsonpad.updateSelfIdentity(
          removeUndefined({
            name: options.name,
            displayName: nullable(options.displayName),
            email: nullable(options.email),
            password,
            currentPassword,
          }) as Parameters<typeof jsonpad.updateSelfIdentity>[0]
        )
      );

      printRecord(context, format, identity, identityOutput(context));
    }
  );

  const providers = self
    .command('providers')
    .description(
      'The provider accounts (e.g. Google) the identity in JSONPAD_IDENTITY_TOKEN can sign in with'
    );

  addOutputOptions(
    providers
      .command('list', { isDefault: true })
      .alias('ls')
      .description(
        'List the accounts the identity can sign in with (the default when no command is given)'
      )
  ).action(async (options: OutputOptions) => {
    const format = resolveOutputFormat(context, options);
    const jsonpad = context.createClient();
    requireIdentity(context);
    const accounts = await request(context, () =>
      jsonpad.fetchSelfIdentityProviders()
    );

    printRecords(context, format, accounts, {
      id: account => account.provider,
      columns: [
        {
          header: 'PROVIDER',
          value: account => providerLabel(account.provider),
        },
        { header: 'EMAIL', value: account => account.email ?? '-' },
        { header: 'NAME', value: account => account.name ?? '-' },
        {
          header: 'LAST SIGNED IN',
          value: account =>
            account.lastLoginAt ? formatTimestamp(account.lastLoginAt) : '-',
        },
      ],
      empty: 'This identity has no provider accounts',
    });
  });

  providers
    .command('unlink')
    .alias('rm')
    .summary('Stop the identity signing in with a provider account')
    .description(
      "Stop the identity in JSONPAD_IDENTITY_TOKEN signing in with a provider account. An identity's last way of signing in can't be removed: set a password first, or link another account"
    )
    .argument('<provider>', 'The provider, e.g. google')
    .option('-y, --yes', "Don't ask for confirmation")
    .action(async (provider: string, options: { yes?: boolean }) => {
      const jsonpad = context.createClient();
      requireIdentity(context);

      await confirm(context, {
        question: `Stop signing in with ${providerLabel(provider)}?`,
        yes: options.yes,
      });
      await request(context, () =>
        jsonpad.unlinkSelfIdentityProvider(provider)
      );

      context.error(
        `Unlinked the ${context.colours.bold(providerLabel(provider))} account`
      );
    });

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

/**
 * How an identity is chosen for a password reset or email verification token:
 * by the same reference as elsewhere, or by email address
 */
function identityTokenRequest(
  reference: string | undefined,
  options: { group?: string; email?: string }
): { group?: string; identityId?: string; name?: string; email?: string } {
  if (reference && options.email) {
    throw new CliError('Pass either an identity or --email, not both');
  }

  if (options.email) {
    return removeUndefined({
      group: options.group || undefined,
      email: options.email,
    });
  }

  if (!reference) {
    throw new CliError(
      'Pass the identity (its id, group/name, or name), or its email address with --email'
    );
  }

  if (UUID.test(reference)) {
    return { identityId: reference };
  }

  // Names can't contain a slash, but groups can
  const slash = reference.lastIndexOf('/');

  return removeUndefined({
    group:
      slash === -1 ? options.group || undefined : reference.slice(0, slash),
    name: reference.slice(slash + 1),
  });
}

type IssuedToken = {
  token: string | null;
  expiresAt: Date | null;
  identity: Identity | null;
  delivery?: 'webhook';

  /**
   * The response as the API sent it, which json output keeps so that scripts
   * see the same field names as the API and the SDK
   */
  response: unknown;
};

/**
 * Print an issued password reset or email verification token
 */
function printIssuedToken(
  context: Context,
  format: OutputFormat,
  issued: IssuedToken,
  noun: string
): void {
  const { dim } = context.colours;

  if (issued.delivery === 'webhook') {
    if (format === 'table') {
      context.log(
        renderDetails([['Delivery', "sent to the identity group's webhook"]])
      );
      context.error(
        dim(
          `The ${noun} was sent to the webhook, so it isn't returned here. The same response is given whether or not an identity matched.`
        )
      );
    } else {
      printRecord(context, format, issued, {
        id: () => '',
        details: () => [],
        data: () => issued.response,
      });
    }

    return;
  }

  if (!issued.token && format === 'table') {
    context.error(
      `No activated, unlocked identity matched, so no ${noun} was issued`
    );
  }

  printRecord(context, format, issued, {
    data: () => issued.response,
    id: () => issued.identity?.id ?? '',
    details: () => [
      [
        noun === 'reset token' ? 'Reset token' : 'Verification token',
        issued.token ?? dim('(none)'),
      ],
      [
        'Expires',
        issued.expiresAt ? formatTimestamp(issued.expiresAt) : dim('(none)'),
      ],
      [
        'Identity',
        issued.identity
          ? `${identityLabel(issued.identity)} (${issued.identity.id})`
          : dim('(no match)'),
      ],
      ['Email', issued.identity?.email ?? dim('(none)')],
    ],
  });
}

/**
 * Password reset and email verification tokens: JSONPad issues them, and your
 * app sends them on
 */
function defineTokenCommands(command: Command, context: Context): void {
  const kinds = [
    {
      name: 'password-reset',
      summary: 'Issue and use password reset tokens',
      noun: 'reset token',
      requestSummary: 'Issue a password reset token for an identity',
      requestDescription:
        "Issue a single-use password reset token for an identity, to send to whoever owns it. JSONPad never sends email itself. The token is returned unless the identity group delivers tokens to a webhook. This needs the token's reset-password permission",
      confirmSummary: 'Set a new password with a reset token',
      confirmDescription:
        'Set a new password for the identity the reset token was issued for, which logs it out everywhere. The password is asked for in a terminal, or read from stdin or JSONPAD_IDENTITY_PASSWORD',
      request: (jsonpad: JSONPad, data: any): Promise<any> =>
        jsonpad.requestIdentityPasswordReset(data),
    },
    {
      name: 'email-verification',
      summary: 'Issue and use email verification tokens',
      noun: 'verification token',
      requestSummary: 'Issue an email verification token for an identity',
      requestDescription:
        "Issue a single-use email verification token for an identity, to send to the address being verified. This needs the token's verify-email permission",
      confirmSummary: "Verify an identity's email address with a token",
      confirmDescription:
        "Mark an identity's email address as verified, using a verification token",
      request: (jsonpad: JSONPad, data: any): Promise<any> =>
        jsonpad.requestIdentityEmailVerification(data),
    },
  ];

  for (const kind of kinds) {
    const group = command.command(kind.name).description(kind.summary);

    addOutputOptions(
      group
        .command('request')
        .summary(kind.requestSummary)
        .description(kind.requestDescription)
        .argument('[identity]', IDENTITY_ARGUMENT_DESCRIPTION)
        .option('--group <group>', "The identity's group")
        .option(
          '--email <email>',
          "The identity's email address, instead of a name"
        )
    ).action(
      async (
        reference: string | undefined,
        options: OutputOptions & { group?: string; email?: string }
      ) => {
        const format = resolveOutputFormat(context, options);
        const jsonpad = context.createClient();
        const issued = (await request(context, () =>
          kind.request(jsonpad, identityTokenRequest(reference, options))
        )) as any;

        printIssuedToken(
          context,
          format,
          {
            token: issued.resetToken ?? issued.verificationToken ?? null,
            expiresAt: issued.expiresAt ?? null,
            identity: issued.identity ?? null,
            delivery: issued.delivery,
            response: issued,
          },
          kind.noun
        );
      }
    );

    const confirm = group
      .command('confirm')
      .summary(kind.confirmSummary)
      .description(kind.confirmDescription)
      .argument('<token>', `The ${kind.noun}, which can only be used once`);

    addOutputOptions(confirm).action(
      async (token: string, options: OutputOptions) => {
        const format = resolveOutputFormat(context, options);
        const jsonpad = context.createClient();
        const identity = await request(context, async () => {
          if (kind.name === 'password-reset') {
            const password = await readPassword(context, 'the identity');

            return jsonpad.confirmIdentityPasswordReset({
              resetToken: token,
              password,
            });
          }

          return jsonpad.confirmIdentityEmailVerification({
            verificationToken: token,
          });
        });

        printRecord(context, format, identity, identityOutput(context));

        if (kind.name === 'password-reset') {
          context.error(
            context.colours.dim(
              'The identity has been logged out everywhere, and can log in with its new password'
            )
          );
        }
      }
    );
  }
}

/**
 * Signing in with Google, GitHub and the rest
 */
function defineProviderCommands(command: Command, context: Context): void {
  addOutputOptions(
    command
      .command('providers')
      .summary("List an identity group's sign-in providers")
      .description(
        "List the sign-in providers enabled for an identity group, e.g. to see what an app's sign-in page would show. Set them up in the dashboard"
      )
      .option('--group <group>', 'The identity group')
  ).action(async (options: OutputOptions & { group?: string }) => {
    const format = resolveOutputFormat(context, options);
    const jsonpad = context.createClient();
    const providers = await request(context, () =>
      jsonpad.fetchIdentityOAuthProviders(options.group || undefined)
    );

    printRecords(context, format, providers, {
      id: provider => provider.provider,
      columns: [
        { header: 'PROVIDER', value: provider => provider.provider },
        { header: 'NAME', value: provider => provider.name },
      ],
      empty: 'No sign-in providers are enabled for this identity group',
    });
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
