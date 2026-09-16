import os from 'node:os';
import { createRetryingClient, installVerboseFetch } from './client.ts';
import { resolveAuth, resolveIdentity, type Auth } from './config.ts';
import { createColours, type Colours } from './output.ts';
import { JSONPad } from './sdk.ts';

export type Writer = {
  write(text: string): unknown;
  isTTY?: boolean;
};

export type Reader = NodeJS.ReadableStream & {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
};

/**
 * Options that every command accepts
 */
export type GlobalOptions = {
  profile?: string;
  apiUrl?: string;
  verbose?: boolean;
  identityGroup?: string;
};

/**
 * The identity requests are made as, for commands that act on items
 */
export type IdentityAuth = {
  token: string;
  group: string | null;
};

/**
 * Everything a command needs from its environment, so that commands can be
 * run in tests without touching the real process
 */
export type Context = {
  env: Record<string, string | undefined>;
  cwd: string;
  platform: NodeJS.Platform;
  homedir(): string;
  stdin: Reader;
  stdout: Writer;
  stderr: Writer;
  colours: Colours;

  /**
   * Set from the command line before a command runs
   */
  globalOptions: GlobalOptions;

  /**
   * The token and API URL the client uses, once createClient has been called
   */
  auth: Auth | null;

  /**
   * The client createClient made, if it's been called
   */
  client: JSONPad | null;

  /**
   * The identity the client acts as, from JSONPAD_IDENTITY_TOKEN, once
   * createClient has been called
   */
  identity: IdentityAuth | null;

  /**
   * Write a line to stdout
   */
  log(text?: string): void;

  /**
   * Write a line to stderr
   */
  error(text?: string): void;

  sleep(milliseconds: number): Promise<void>;

  /**
   * Create an API client, with the token and API URL from the command line,
   * the environment or a profile. Throws a CliError if there's no token
   */
  createClient(): JSONPad;
};

export type ContextOptions = Partial<
  Pick<
    Context,
    | 'env'
    | 'cwd'
    | 'platform'
    | 'homedir'
    | 'stdin'
    | 'stdout'
    | 'stderr'
    | 'sleep'
  >
>;

export function createContext(options: ContextOptions = {}): Context {
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  const context: Context = {
    env,
    cwd: options.cwd ?? process.cwd(),
    platform: options.platform ?? process.platform,
    homedir: options.homedir ?? os.homedir,
    stdin: options.stdin ?? process.stdin,
    stdout,
    stderr,
    colours: createColours(!!stdout.isTTY && !('NO_COLOR' in env)),
    globalOptions: {},
    auth: null,
    client: null,
    identity: null,
    log: (text = '') => void stdout.write(`${text}\n`),
    error: (text = '') => void stderr.write(`${text}\n`),
    sleep:
      options.sleep ??
      (milliseconds =>
        new Promise(resolve => setTimeout(resolve, milliseconds))),
    createClient() {
      const auth = resolveAuth(context);

      if (context.globalOptions.verbose) {
        installVerboseFetch(context);
      }

      const identity = resolveIdentity(context);

      context.auth = auth;
      context.identity = identity;
      context.client = createRetryingClient(
        context,
        new JSONPad(auth.token, identity?.group ?? undefined, identity?.token, {
          apiUrl: auth.apiUrl,
        })
      );

      return context.client;
    },
  };

  return context;
}
