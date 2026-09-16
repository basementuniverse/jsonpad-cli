import type { Command } from 'commander';
import type { Context } from '../context.ts';
import { CliError } from '../errors.ts';
import { canPrompt, confirm, promptSecret, readStdin } from '../input.ts';
import {
  addOutputOptions,
  formatTimestamp,
  printPage,
  printRecord,
  resolveOutputFormat,
  type OutputOptions,
  type RecordOutput,
  type RecordsOutput,
} from '../output.ts';
import {
  addPagingOptions,
  addTaggedOption,
  addTagsOption,
  nullable,
  pagingParameters,
  removeUndefined,
  request,
  resolveIdentityId,
  type PagingOptions,
} from '../resources.ts';
import type { Identity } from '../sdk.ts';

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
  addPagingOptions(list, { choices: ORDER_FIELDS });
  addOutputOptions(list).action(
    async (
      options: PagingOptions &
        OutputOptions & {
          group?: string;
          name?: string;
          displayName?: string;
          tagged?: string[];
        }
    ) => {
      const format = resolveOutputFormat(context, options);
      const jsonpad = context.createClient();
      const page = await request(context, () =>
        jsonpad.fetchIdentities(
          removeUndefined({
            ...pagingParameters(options),
            group: options.group,
            name: options.name,
            displayName: options.displayName,
            tagged: options.tagged,
          }) as Parameters<typeof jsonpad.fetchIdentities>[0]
        )
      );

      printPage(context, format, page, identityOutput(context));
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

  return command;
}
