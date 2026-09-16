import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { createContext, type Context, type Reader } from '../src/context.ts';

export type TestContext = Context & {
  output: { stdout: string; stderr: string };

  /**
   * Every wait the context was asked for, in milliseconds
   */
  sleeps: number[];
  stdinStream: PassThrough & { rawModes: boolean[] };
};

/**
 * A context that captures output instead of writing it, and doesn't touch the
 * real environment, home directory or stdin
 */
export function createTestContext(
  options: {
    env?: Record<string, string>;

    /**
     * Whether stdout is a terminal
     */
    isTTY?: boolean;

    /**
     * Whether stdin and stderr are a terminal, so the user can be asked things
     */
    interactive?: boolean;
    cwd?: string;
    platform?: NodeJS.Platform;
    homedir?: string;
  } = {}
): TestContext {
  const output = { stdout: '', stderr: '' };
  const sleeps: number[] = [];
  const stdin = Object.assign(new PassThrough(), {
    isTTY: options.interactive ?? false,
    rawModes: [] as boolean[],
  });
  if (options.interactive) {
    Object.assign(stdin, {
      setRawMode: (mode: boolean) => stdin.rawModes.push(mode),
    });
  }

  const context = createContext({
    env: options.env ?? {},
    cwd: options.cwd ?? process.cwd(),
    platform: options.platform ?? 'linux',
    homedir: () => options.homedir ?? '/home/test',
    stdin: stdin as Reader,
    stdout: {
      isTTY: options.isTTY ?? false,
      write: (text: string) => (output.stdout += text),
    },
    stderr: {
      isTTY: options.interactive ?? false,
      write: (text: string) => (output.stderr += text),
    },
    sleep: async milliseconds => void sleeps.push(milliseconds),
  });

  return Object.assign(context, { output, sleeps, stdinStream: stdin });
}

/**
 * Make a temporary directory, removed when the test finishes
 */
export function temporaryDirectory(t: { after(fn: () => void): void }): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonpad-cli-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  return directory;
}
