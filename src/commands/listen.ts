/**
 * jsonpad listen: print realtime events as they happen
 */
import { InvalidArgumentError, Option, type Command } from 'commander';
import { DEFAULT_API_URL } from '../config.ts';
import type { Context } from '../context.ts';
import {
  CliError,
  EXIT_ERROR,
  EXIT_LIMIT_REACHED,
  EXIT_NOT_FOUND,
  EXIT_PERMISSION_DENIED,
} from '../errors.ts';
import { collectList } from '../input.ts';
import { formatTimestamp } from '../output.ts';
import { parsePositiveInteger, request } from '../resources.ts';
import {
  JSONPadRealtime,
  REALTIME_EVENT_TYPES,
  type RealtimeClient,
  type RealtimeErrorEvent,
} from '../realtime.ts';

export const REALTIME_URL = 'https://realtime.jsonpad.io';

type ListenOptions = {
  items?: string[];
  events?: string[];
  output?: 'text' | 'ndjson';
  count?: number;
};

export type RealtimeMessage = {
  type: string;
  listId: string | null;
  itemId: string | null;
  model: Record<string, any>;
  receivedAt: string;
};

export type ListenDependencies = {
  connect: (token: string) => RealtimeClient;

  /**
   * Call the function when the user presses Ctrl+C, and return a function that
   * stops listening for it
   */
  onInterrupt: (stop: () => void) => () => void;
};

const defaultDependencies: ListenDependencies = {
  connect: token => new JSONPadRealtime(token),
  onInterrupt: stop => {
    process.once('SIGINT', stop);
    return () => process.off('SIGINT', stop);
  },
};

export function defineListen(
  command: Command,
  context: Context,
  dependencies: ListenDependencies = defaultDependencies
): Command {
  return command
    .summary('Print realtime events from lists and items as they happen')
    .description(
      `Print realtime events from lists and items as they happen, until you press Ctrl+C. Only lists with realtime turned on send events. This connects to ${REALTIME_URL}, so it doesn't work with --api-url or a profile for another API`
    )
    .argument(
      '[list...]',
      'Only events from these lists (ids or path names). Without any, events from every realtime list'
    )
    .option(
      '--items <items>',
      'Only events for these comma-separated items (ids or aliases; repeatable)',
      collectList
    )
    .addOption(
      new Option(
        '--events <types>',
        `Only these comma-separated event types (repeatable): ${REALTIME_EVENT_TYPES.join(', ')}`
      ).argParser((value: string, previous: string[] = []) => {
        const types = collectList(value, previous);
        const unknown = types.filter(
          type => !(REALTIME_EVENT_TYPES as readonly string[]).includes(type)
        );

        if (unknown.length > 0) {
          throw new InvalidArgumentError(
            `Unknown event type ${unknown.join(', ')}. Choose from: ${REALTIME_EVENT_TYPES.join(', ')}.`
          );
        }

        return types;
      })
    )
    .addOption(
      new Option(
        '-o, --output <format>',
        'Output format: text (the default in a terminal), or ndjson (the default otherwise)'
      ).choices(['text', 'ndjson'])
    )
    .option(
      '--count <number>',
      'Stop after this many events',
      parsePositiveInteger
    )
    .action((lists: string[], options: ListenOptions) =>
      listen(context, lists, options, dependencies)
    );
}

function describeMessage(context: Context, message: RealtimeMessage): string {
  const { dim, bold, green, yellow, red, cyan } = context.colours;
  const colourFor: Record<string, (text: string) => string> = {
    created: green,
    updated: yellow,
    restored: cyan,
    deleted: red,
  };
  const action = message.type.split('-')[1];
  const model = message.model;
  const subject = message.type.startsWith('list-')
    ? `list ${bold(model.pathName || model.id)}`
    : `item ${bold(model.id)} ${dim(`in list ${message.listId ?? '?'}`)}`;
  const version = model.version ? dim(` (version ${model.version})`) : '';

  return `${dim(formatTimestamp(new Date(message.receivedAt)))}  ${(
    colourFor[action] ?? (text => text)
  )(message.type.padEnd(13))}  ${subject}${version}`;
}

/**
 * The exit code for a connection the server refused
 */
function refusalExitCode(event: RealtimeErrorEvent): number {
  switch (event.errorName) {
    case 'USER_NOT_AUTHENTICATED':
    case 'TOKEN_NOT_AUTHORIZED':
      return EXIT_PERMISSION_DENIED;
    case 'REALTIME_CONNECTION_LIMIT_EXCEEDED':
      return EXIT_LIMIT_REACHED;
    case 'LIST_NOT_FOUND':
    case 'ITEM_NOT_FOUND':
      return EXIT_NOT_FOUND;
    default:
      return EXIT_ERROR;
  }
}

export async function listen(
  context: Context,
  lists: string[],
  options: ListenOptions,
  dependencies: ListenDependencies
): Promise<void> {
  const { dim, yellow } = context.colours;
  const format = options.output ?? (context.stdout.isTTY ? 'text' : 'ndjson');

  // Resolve the token first, so that a missing token is reported as usual
  const jsonpad = context.createClient();
  const auth = context.auth!;

  // The realtime SDK always connects to the production realtime server, so the
  // token has to be one for the production API
  if (auth.apiUrl.replace(/\/+$/, '') !== DEFAULT_API_URL) {
    throw new CliError(
      `jsonpad listen connects to ${REALTIME_URL}, so it only works with ${DEFAULT_API_URL}, not ${auth.apiUrl} (from ${
        context.globalOptions.apiUrl
          ? '--api-url'
          : auth.source.type === 'profile'
            ? `the profile ${auth.source.name}`
            : 'JSONPAD_API_URL'
      })`
    );
  }

  // The realtime server ignores lists it can't find, and lists without realtime
  // turned on never send events, so either would wait forever in silence
  for (const listId of lists) {
    const list = await request(context, () => jsonpad.fetchList(listId));

    if (!list.realtime) {
      context.error(
        `${yellow('warning')}: ${listId} has realtime turned off, so it won't send events. Turn it on with: jsonpad lists update ${listId} --realtime`
      );
    }
  }

  const eventTypes = options.events?.length
    ? options.events
    : [...REALTIME_EVENT_TYPES];
  context.error(dim(`Connecting to ${REALTIME_URL}...`));
  const realtime = dependencies.connect(auth.token);
  let received = 0;

  await new Promise<void>((resolve, reject) => {
    // Events already on their way can still arrive after closing
    let finished = false;

    const finish = (error?: CliError) => {
      if (finished) {
        return;
      }
      finished = true;
      stopWaitingForInterrupt();
      realtime.close();
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const stopWaitingForInterrupt = dependencies.onInterrupt(() => {
      context.error(dim('Stopped'));
      finish();
    });

    realtime.addEventListener('connected', () => {
      context.error(
        dim(
          `Listening for ${
            options.events?.length ? eventTypes.join(', ') : 'all events'
          }${lists.length > 0 ? ` in ${lists.join(', ')}` : ''}${
            options.items?.length
              ? ` for items ${options.items.join(', ')}`
              : ''
          }. Press Ctrl+C to stop`
        )
      );
    });

    realtime.addEventListener('disconnected', () => {
      context.error(yellow('Disconnected, reconnecting...'));
    });

    realtime.addEventListener('error', event => {
      const error = event as RealtimeErrorEvent;

      // The SDK retries some refusals itself, e.g. too many connections
      if (error.retryIn !== null) {
        context.error(
          yellow(`${error.detail}. Trying again in ${error.retryIn}s...`)
        );
        return;
      }

      // A server refusal ends the command. Other errors (e.g. an event that
      // couldn't be parsed) are only reported
      if (error.errorName !== null) {
        finish(new CliError(error.detail, refusalExitCode(error)));
      } else {
        context.error(yellow(`warning: ${error.detail}`));
      }
    });

    for (const type of eventTypes) {
      realtime.addEventListener(type, event => {
        if (finished) {
          return;
        }

        const detail = (event as CustomEvent).detail ?? {};
        const message: RealtimeMessage = {
          type,
          listId: detail.listId ?? null,
          itemId: detail.itemId ?? null,
          model: detail.model ?? {},
          receivedAt: new Date().toISOString(),
        };

        context.log(
          format === 'ndjson'
            ? JSON.stringify(message)
            : describeMessage(context, message)
        );

        received++;
        if (options.count !== undefined && received >= options.count) {
          finish();
        }
      });
    }

    try {
      realtime.listen(
        eventTypes as Parameters<RealtimeClient['listen']>[0],
        lists.length > 0 ? lists : undefined,
        options.items?.length ? options.items : undefined
      );
    } catch (error) {
      finish(
        new CliError(error instanceof Error ? error.message : String(error))
      );
    }
  });
}
