import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { Context } from './context.ts';
import {
  CliError,
  EXIT_CONFIRMATION_NEEDED,
  EXIT_ERROR,
  EXIT_INTERRUPTED,
} from './errors.ts';

const CTRL_C = String.fromCharCode(3);
const CTRL_D = String.fromCharCode(4);
const BACKSPACE = String.fromCharCode(8);
const DELETE = String.fromCharCode(127);
const ESCAPE = String.fromCharCode(27);

/**
 * Read everything from stdin
 */
export async function readStdin(context: Context): Promise<string> {
  let text = '';

  context.stdin.setEncoding('utf8');
  for await (const chunk of context.stdin) {
    text += chunk;
  }

  return text;
}

/**
 * Read a JSON option value, which can be:
 * - JSON, e.g. --data '{"name":"Pancakes"}'
 * - @ and a file name, e.g. --data @pancakes.json
 * - a dash to read from stdin, e.g. --data -
 */
export async function readJsonInput(
  context: Context,
  option: string,
  value: string
): Promise<unknown> {
  let text: string;
  let source: string;

  if (value === '-') {
    text = await readStdin(context);
    source = `${option} (from stdin)`;
  } else if (value.startsWith('@')) {
    const file = value.slice(1);

    try {
      text = fs.readFileSync(path.resolve(context.cwd, file), 'utf8');
    } catch (error: any) {
      throw new CliError(
        error.code === 'ENOENT'
          ? `Can't find ${file} (for ${option})`
          : `Can't read ${file} (for ${option}): ${error.message}`
      );
    }
    source = `${option} (from ${file})`;
  } else {
    text = value;
    source = option;
  }

  try {
    return JSON.parse(text);
  } catch (error: any) {
    throw new CliError(`${source} isn't valid JSON: ${error.message}`);
  }
}

/**
 * Collect a repeatable option whose values can also be comma-separated, e.g.
 * --tags a,b --tags c gives ['a', 'b', 'c']
 */
export function collectList(value: string, previous: string[] = []): string[] {
  return [
    ...previous,
    ...value
      .split(',')
      .map(part => part.trim())
      .filter(Boolean),
  ];
}

/**
 * Whether the user can be asked something: stdin and stderr (where questions
 * are written) are both a terminal
 */
export function canPrompt(context: Context): boolean {
  return !!context.stdin.isTTY && !!context.stderr.isTTY;
}

async function askYesNo(context: Context, question: string): Promise<boolean> {
  context.stderr.write(`${question} [y/N] `);

  const lines = readline.createInterface({
    input: context.stdin,
    terminal: false,
  });

  try {
    const answer = await new Promise<string | null>(resolve => {
      lines.once('line', resolve);
      lines.once('close', () => resolve(null));
    });

    if (answer === null) {
      context.stderr.write('\n');
    }

    return /^y(es)?$/i.test((answer ?? '').trim());
  } finally {
    lines.close();
  }
}

/**
 * Check that the user wants to go ahead with something that can't be undone
 *
 * With --yes, there's nothing to check. Otherwise the user is asked on a
 * terminal, and anywhere else (a script, CI) the command is refused, rather
 * than waiting for an answer that will never come
 */
export async function confirm(
  context: Context,
  options: { question: string; yes?: boolean }
): Promise<void> {
  if (options.yes) {
    return;
  }

  if (!canPrompt(context)) {
    throw new CliError(
      `${options.question} Run again with --yes to confirm`,
      EXIT_CONFIRMATION_NEEDED
    );
  }

  if (!(await askYesNo(context, options.question))) {
    throw new CliError('Cancelled', EXIT_ERROR);
  }
}

/**
 * Ask for a secret (e.g. a token) on a terminal, without showing what's typed
 */
export function promptSecret(
  context: Context,
  question: string
): Promise<string> {
  const { stdin, stderr } = context;

  if (!canPrompt(context) || !stdin.setRawMode) {
    return Promise.reject(
      new CliError("Can't ask for input, because this isn't a terminal")
    );
  }

  stderr.write(question);
  stdin.setRawMode(true);
  stdin.setEncoding('utf8');
  stdin.resume();

  return new Promise((resolve, reject) => {
    let value = '';

    const finish = () => {
      stdin.off('data', onData);
      stdin.setRawMode!(false);
      stdin.pause();
      stderr.write('\n');
    };

    const onData = (chunk: string | Buffer) => {
      // Arrow keys and the like arrive as escape sequences, which aren't part
      // of the secret
      if (String(chunk).startsWith(ESCAPE)) {
        return;
      }

      for (const character of String(chunk)) {
        switch (character) {
          case '\r':
          case '\n':
          case CTRL_D:
            finish();
            resolve(value);
            return;
          case CTRL_C:
            finish();
            reject(new CliError('Cancelled', EXIT_INTERRUPTED));
            return;
          case BACKSPACE:
          case DELETE:
            value = value.slice(0, -1);
            break;
          default:
            // Ignore other control characters, e.g. from arrow keys
            if (character >= ' ') {
              value += character;
            }
        }
      }
    };

    stdin.on('data', onData);
  });
}
