import type { Command } from 'commander';
import type { Context } from '../context.ts';
import { CliError } from '../errors.ts';
import { confirm, readJsonInput } from '../input.ts';
import {
  addDataOutputOptions,
  addOutputOptions,
  formatBytes,
  formatTimestamp,
  printData,
  printRecord,
  resolveOutputFormat,
  type OutputOptions,
  type RecordOutput,
  type RecordsOutput,
} from '../output.ts';
import {
  addBooleanOption,
  addAllOption,
  addPagingOptions,
  checkAllOptions,
  fetchAll,
  parsePositiveInteger,
  addTaggedOption,
  addTagsOption,
  pagingParameters,
  removeUndefined,
  printPages,
  request,
  sdkPointer,
  type AllOptions,
  type PagingOptions,
} from '../resources.ts';
import type { Item } from '../sdk.ts';
import { defineEventCommands, defineStatsCommand } from './history.ts';
import { defineTransferCommands } from './transfer.ts';

type ItemFields = {
  data?: string;
  description?: string;
  tags?: string[];
  readonly?: boolean;
};

type DataOutputOptions = { output?: 'json' | 'ndjson' };

function itemOutput(
  context: Context
): RecordOutput<Item> & RecordsOutput<Item> {
  const { dim } = context.colours;

  return {
    id: item => item.id,
    details: item => [
      ['ID', item.id],
      ['Description', item.description || dim('(none)')],
      ['Tags', item.tags?.length ? item.tags.join(', ') : dim('(none)')],
      ['Version', item.version],
      ['Readonly', item.readonly ? 'yes' : 'no'],
      ['Size', formatBytes(item.size ?? 0)],
      [
        'Identity',
        item.identity
          ? `${item.identity.displayName ?? ''} ${dim(item.identity.id)}`.trim()
          : dim('(none)'),
      ],
      ['Created', formatTimestamp(item.createdAt)],
      ['Updated', formatTimestamp(item.updatedAt)],
      ...(item.data !== undefined
        ? [['Data', JSON.stringify(item.data, null, 2)] as [string, string]]
        : []),
    ],
    columns: [
      { header: 'ID', value: item => item.id },
      { header: 'DESCRIPTION', value: item => item.description || '-' },
      {
        header: 'TAGS',
        value: item => (item.tags?.length ? item.tags.join(', ') : '-'),
      },
      { header: 'SIZE', value: item => formatBytes(item.size ?? 0) },
      { header: 'UPDATED', value: item => formatTimestamp(item.updatedAt) },
    ],
    empty: 'No items',
  };
}

/**
 * Parse --where index=value options into query parameters
 */
export function whereParameters(where: string[] = []): Record<string, string> {
  return Object.fromEntries(
    where.map(filter => {
      const equals = filter.indexOf('=');

      if (equals < 1) {
        throw new CliError(
          `--where must be an index path name and a value, e.g. --where title=Pancakes (got "${filter}")`
        );
      }

      return [filter.slice(0, equals), filter.slice(equals + 1)];
    })
  );
}

function addItemFieldOptions(command: Command): Command {
  command
    .option('--data <json>', "The item's data: JSON, @file or - for stdin")
    .option('--description <text>', 'The description');
  addTagsOption(command);

  return addBooleanOption(
    command,
    'readonly',
    "The item can't be changed or deleted",
    'Not readonly'
  );
}

async function itemBody(context: Context, options: ItemFields) {
  return removeUndefined({
    data:
      options.data === undefined
        ? undefined
        : await readJsonInput(context, '--data', options.data),
    description: options.description,
    tags: options.tags,
    readonly: options.readonly,
  });
}

const includeGuardedDescription =
  'Include guarded values in the item data, for items the identity making the request owns';

export function defineItems(command: Command, context: Context): Command {
  command.description("Create, view, change and delete a list's items");

  const list = command
    .command('list', { isDefault: true })
    .alias('ls')
    .description("List a list's items (the default when no command is given)")
    .argument('<list>', 'The list (id or path name)')
    .option(
      '--where <index=value>',
      'Only items whose indexed value matches, e.g. --where title=Pancakes (repeatable; the index must allow filtering)',
      (value: string, previous: string[] = []) => [...previous, value]
    )
    .option('--alias <value>', 'Only the item with this alias')
    .option('--identity-id <id>', 'Only items owned by this identity');
  addBooleanOption(
    list,
    'readonly',
    'Only readonly items',
    "Only items that aren't readonly"
  );
  addTaggedOption(list);
  list
    .option('--include-data', "Include each item's data")
    .option(
      '--path <json path>',
      'With --include-data, only the part of the data matching this JSONPath, e.g. $.ingredients'
    )
    .option('--include-guarded', includeGuardedDescription);
  addAllOption(list);
  addPagingOptions(list, {
    description:
      'The field to order by: createdAt, updatedAt, or an index path name',
  });
  addOutputOptions(list).action(
    async (
      listId: string,
      options: PagingOptions &
        AllOptions &
        OutputOptions & {
          where?: string[];
          alias?: string;
          identityId?: string;
          readonly?: boolean;
          tagged?: string[];
          includeData?: boolean;
          path?: string;
          includeGuarded?: boolean;
        }
    ) => {
      const where = whereParameters(options.where);
      const jsonpad = context.createClient();
      await printPages(
        context,
        options,
        paging =>
          jsonpad.fetchItems(
            listId,
            removeUndefined({
              ...where,
              ...paging,
              alias: options.alias,
              identityId: options.identityId,
              readonly: options.readonly,
              tagged: options.tagged,
              includeData: options.includeData,
              path: options.path,
              includeGuarded: options.includeGuarded,
            })
          ),
        itemOutput(context)
      );
    }
  );

  addOutputOptions(
    command
      .command('get')
      .description('Show an item, with its data')
      .argument('<list>', 'The list (id or path name)')
      .argument('<item>', 'The item (id or alias)')
      .option(
        '--item-version <version>',
        'An earlier version of the item (see its events)'
      )
      .option(
        '--path <json path>',
        'Only the part of the data matching this JSONPath, e.g. $.ingredients'
      )
      .option('--no-data', "Leave out the item's data")
      .option('--generate', "Generate the item's data, in a generative list")
      .option('--include-guarded', includeGuardedDescription)
  ).action(
    async (
      listId: string,
      itemId: string,
      options: OutputOptions & {
        itemVersion?: string;
        path?: string;
        data: boolean;
        generate?: boolean;
        includeGuarded?: boolean;
      }
    ) => {
      const format = resolveOutputFormat(context, options);
      const jsonpad = context.createClient();
      const item = await request(context, () =>
        jsonpad.fetchItem(
          listId,
          itemId,
          removeUndefined({
            version: options.itemVersion,
            path: options.path,
            includeData: options.data ? undefined : false,
            generate: options.generate,
            includeGuarded: options.includeGuarded,
          })
        )
      );

      printRecord(context, format, item, itemOutput(context));
    }
  );

  addOutputOptions(
    addItemFieldOptions(
      command
        .command('create')
        .description('Create an item')
        .argument('<list>', 'The list (id or path name)')
    ).option('--generate', "Generate the item's data, in a generative list")
  ).action(
    async (
      listId: string,
      options: ItemFields & OutputOptions & { generate?: boolean }
    ) => {
      const format = resolveOutputFormat(context, options);

      if (options.data === undefined && !options.generate) {
        throw new CliError(
          "Pass the item's data with --data (JSON, @file or - for stdin), or --generate in a generative list"
        );
      }

      const body = await itemBody(context, options);
      const jsonpad = context.createClient();
      const item = await request(context, () =>
        jsonpad.createItem(
          listId,
          body,
          removeUndefined({ generate: options.generate })
        )
      );

      printRecord(context, format, item, itemOutput(context));
    }
  );

  addOutputOptions(
    addItemFieldOptions(
      command
        .command('update')
        .description(
          "Change an item. --data replaces all of its data; fields that aren't given are left as they are"
        )
        .argument('<list>', 'The list (id or path name)')
        .argument('<item>', 'The item (id or alias)')
    )
  ).action(
    async (
      listId: string,
      itemId: string,
      options: ItemFields & OutputOptions
    ) => {
      const format = resolveOutputFormat(context, options);
      const body = await itemBody(context, options);
      const jsonpad = context.createClient();
      const item = await request(context, () =>
        jsonpad.updateItem(listId, itemId, body)
      );

      printRecord(context, format, item, itemOutput(context));
    }
  );

  command
    .command('delete')
    .alias('rm')
    .description('Delete an item. It can be restored from its events')
    .argument('<list>', 'The list (id or path name)')
    .argument('<item>', 'The item (id or alias)')
    .option('-y, --yes', "Don't ask for confirmation")
    .action(
      async (listId: string, itemId: string, options: { yes?: boolean }) => {
        await confirm(context, {
          question: `Delete the item ${itemId} from the list ${listId}?`,
          yes: options.yes,
        });

        const jsonpad = context.createClient();
        await request(context, () => jsonpad.deleteItem(listId, itemId));

        context.error(
          `Deleted the item ${context.colours.bold(itemId)} from the list ${listId}`
        );
      }
    );

  addOutputOptions(
    command
      .command('restore')
      .summary('Restore an item to how it was after one of its events')
      .description(
        'Restore an item to how it was after one of its events, re-creating it if it was deleted. Find restorable events with jsonpad items events <list> <item> --restorable'
      )
      .argument('<list>', 'The list (id or path name)')
      .argument('<item>', 'The item (id or alias)')
      .argument('<event>', 'The event id')
  ).action(
    async (
      listId: string,
      itemId: string,
      eventId: string,
      options: OutputOptions
    ) => {
      const format = resolveOutputFormat(context, options);
      const jsonpad = context.createClient();
      const item = await request(context, () =>
        jsonpad.restoreItem(listId, itemId, eventId)
      );

      printRecord(context, format, item, itemOutput(context));
    }
  );

  const target = {
    arguments: [
      ['<list>', 'The list (id or path name)'],
      ['<item>', 'The item (id or alias)'],
    ] as [string, string][],
  };

  defineStatsCommand(command, context, {
    ...target,
    description: "Show an item's events, by day",
    fetch: (jsonpad, [listId, itemId], parameters) =>
      jsonpad.fetchItemStats(listId, itemId, parameters),
  });

  defineEventCommands(command, context, {
    ...target,
    noun: 'item',
    items: true,
    types: ['item-created', 'item-updated', 'item-restored', 'item-deleted'],
    fetchEvents: (jsonpad, [listId, itemId], parameters) =>
      jsonpad.fetchItemEvents(listId, itemId, parameters),
    fetchEvent: (jsonpad, [listId, itemId], eventId, parameters) =>
      jsonpad.fetchItemEvent(listId, itemId, eventId, parameters),
  });

  defineTransferCommands(command, context, whereParameters);

  defineItemsData(
    command
      .command('data')
      .description("View and change an item's data, or part of it"),
    context
  );

  return command;
}

function defineItemsData(command: Command, context: Context): Command {
  addPagingOptions(
    addDataOutputOptions(
      command
        .command('get')
        .description(
          "Output an item's data, or part of it. Without an item, output the data of a page of the list's items"
        )
        .argument('<list>', 'The list (id or path name)')
        .argument('[item]', 'The item (id or alias)')
        .argument(
          '[pointer]',
          'A JSON pointer to part of the data, e.g. /ingredients/0'
        )
        .option(
          '--item-version <version>',
          'An earlier version of the item (see its events)'
        )
        .option(
          '--path <json path>',
          'Only the part of the data matching this JSONPath, e.g. $.ingredients'
        )
        .option(
          '--where <index=value>',
          'Without an item: only items whose indexed value matches (repeatable)',
          (value: string, previous: string[] = []) => [...previous, value]
        )
        .option('--include-guarded', includeGuardedDescription)
        .option(
          '--all',
          "Without an item: output every item's data, one per line (NDJSON) unless --output is json"
        )
        .option(
          '--max <number>',
          'With --all, stop after this many',
          parsePositiveInteger
        )
    ),
    {
      description:
        'Without an item: the field to order by (createdAt, updatedAt, or an index path name)',
    }
  ).action(
    async (
      listId: string,
      itemId: string | undefined,
      pointer: string | undefined,
      options: DataOutputOptions &
        PagingOptions &
        AllOptions & {
          itemVersion?: string;
          path?: string;
          where?: string[];
          includeGuarded?: boolean;
        }
    ) => {
      const jsonpad = context.createClient();

      if (itemId === undefined) {
        checkAllOptions(options);
        const where = whereParameters(options.where);
        const fetchPage = (paging: Partial<PagingOptions>) =>
          jsonpad.fetchItemsData(
            listId,
            removeUndefined({
              ...where,
              ...pagingParameters(options),
              ...paging,
              path: options.path,
              includeGuarded: options.includeGuarded,
            })
          );

        if (!options.all) {
          const page = await request(context, () => fetchPage({}));
          printData(context, options.output ?? 'json', page.data, {
            list: true,
          });
          return;
        }

        const records = fetchAll(context, fetchPage, options.max);
        if ((options.output ?? 'ndjson') === 'ndjson') {
          for await (const data of records) {
            printData(context, 'ndjson', data);
          }
        } else {
          const all: unknown[] = [];
          for await (const data of records) {
            all.push(data);
          }
          printData(context, 'json', all);
        }
        return;
      }

      if (options.all || options.max !== undefined) {
        throw new CliError('--all and --max only work without an item');
      }

      const data = await request(context, () =>
        jsonpad.fetchItemData(
          listId,
          itemId,
          removeUndefined({
            pointer: sdkPointer(pointer),
            version: options.itemVersion,
            path: options.path,
            includeGuarded: options.includeGuarded,
          })
        )
      );

      printData(context, options.output ?? 'json', data);
    }
  );

  const writeCommands = [
    {
      name: 'set',
      description:
        "Merge data into an item's data, or into part of it. Objects are merged, and arrays are added to",
      send: 'updateItemData',
      input: '--data',
    },
    {
      name: 'replace',
      description: "Replace an item's data, or part of it",
      send: 'replaceItemData',
      input: '--data',
    },
    {
      name: 'patch',
      description:
        "Change an item's data, or part of it, with a JSON patch (RFC 6902)",
      send: 'patchItemData',
      input: '--patch',
    },
  ] as const;

  for (const { name, description, send, input } of writeCommands) {
    addOutputOptions(
      command
        .command(name)
        .description(`${description}. Outputs the changed item`)
        .argument('<list>', 'The list (id or path name)')
        .argument('<item>', 'The item (id or alias)')
        .argument(
          '[pointer]',
          'A JSON pointer to part of the data, e.g. /ingredients'
        )
        .requiredOption(
          `${input} <json>`,
          input === '--patch'
            ? 'The JSON patch: JSON, @file or - for stdin'
            : 'The data: JSON, @file or - for stdin'
        )
    ).action(
      async (
        listId: string,
        itemId: string,
        pointer: string | undefined,
        options: OutputOptions & { data?: string; patch?: string }
      ) => {
        const format = resolveOutputFormat(context, options);
        const value = await readJsonInput(
          context,
          input,
          (input === '--patch' ? options.patch : options.data)!
        );

        if (send === 'patchItemData' && !Array.isArray(value)) {
          throw new CliError(
            '--patch must be a JSON patch: an array of operations, e.g. [{"op":"replace","path":"/title","value":"Crêpes"}]'
          );
        }

        const jsonpad = context.createClient();
        const parameters = removeUndefined({ pointer: sdkPointer(pointer) });
        const item = await request(context, () =>
          send === 'patchItemData'
            ? jsonpad.patchItemData(listId, itemId, value as any, parameters)
            : jsonpad[send](listId, itemId, value, parameters)
        );

        printRecord(context, format, item, itemOutput(context));
      }
    );
  }

  addOutputOptions(
    command
      .command('delete')
      .alias('rm')
      .description("Delete part of an item's data. Outputs the changed item")
      .argument('<list>', 'The list (id or path name)')
      .argument('<item>', 'The item (id or alias)')
      .argument(
        '<pointer>',
        'A JSON pointer to the part to delete, e.g. /ingredients/0'
      )
      .option('-y, --yes', "Don't ask for confirmation")
  ).action(
    async (
      listId: string,
      itemId: string,
      pointer: string,
      options: OutputOptions & { yes?: boolean }
    ) => {
      const format = resolveOutputFormat(context, options);

      if (!sdkPointer(pointer)) {
        throw new CliError(
          'Give a pointer to part of the data. To delete the whole item, use jsonpad items delete'
        );
      }

      await confirm(context, {
        question: `Delete ${pointer} from the item ${itemId} in the list ${listId}?`,
        yes: options.yes,
      });

      const jsonpad = context.createClient();
      const item = await request(context, () =>
        jsonpad.deleteItemData(listId, itemId, { pointer: sdkPointer(pointer) })
      );

      printRecord(context, format, item, itemOutput(context));
    }
  );

  return command;
}
