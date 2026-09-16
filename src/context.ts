import { CliError } from './errors.ts';
import { createColours, type Colours } from './output.ts';
import { JSONPad } from './sdk.ts';

export type Writer = {
  write(text: string): unknown;
  isTTY?: boolean;
};

/**
 * Everything a command needs from its environment, so that commands can be
 * run in tests without touching the real process
 */
export type Context = {
  env: Record<string, string | undefined>;
  cwd: string;
  stdout: Writer;
  stderr: Writer;
  colours: Colours;

  /**
   * Write a line to stdout
   */
  log(text?: string): void;

  /**
   * Write a line to stderr
   */
  error(text?: string): void;

  /**
   * Create an API client from the environment. Throws a CliError if there's
   * no token
   */
  createClient(): JSONPad;
};

export function createContext(
  options: Partial<Pick<Context, 'env' | 'cwd' | 'stdout' | 'stderr'>> = {}
): Context {
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  return {
    env,
    cwd: options.cwd ?? process.cwd(),
    stdout,
    stderr,
    colours: createColours(!!stdout.isTTY && !('NO_COLOR' in env)),
    log: (text = '') => void stdout.write(`${text}\n`),
    error: (text = '') => void stderr.write(`${text}\n`),
    createClient() {
      const token = env.JSONPAD_TOKEN;

      if (!token) {
        throw new CliError(
          'Set the JSONPAD_TOKEN environment variable to an API token'
        );
      }

      return new JSONPad(token, undefined, undefined, {
        apiUrl: env.JSONPAD_API_URL || undefined,
      });
    },
  };
}
