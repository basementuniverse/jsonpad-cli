import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import {
  CliError,
  EXIT_CONFIRMATION_NEEDED,
  EXIT_ERROR,
  EXIT_INTERRUPTED,
} from '../src/errors.ts';
import {
  collectList,
  confirm,
  promptSecret,
  readJsonInput,
} from '../src/input.ts';
import { createTestContext, temporaryDirectory } from './helpers.ts';

const exitCode = (code: number) => (error: unknown) =>
  error instanceof CliError && error.exitCode === code;

describe('readJsonInput', () => {
  test('parses an inline value', async () => {
    assert.deepEqual(
      await readJsonInput(createTestContext(), '--data', '{"a":[1,2]}'),
      { a: [1, 2] }
    );
  });

  test('reads @file relative to the working directory', async t => {
    const directory = temporaryDirectory(t);
    fs.writeFileSync(path.join(directory, 'data.json'), '{"name":"Pancakes"}');
    const context = createTestContext({ cwd: directory });

    assert.deepEqual(await readJsonInput(context, '--data', '@data.json'), {
      name: 'Pancakes',
    });
  });

  test('reads - from stdin', async () => {
    const context = createTestContext();
    context.stdinStream.end('[1, 2, 3]\n');

    assert.deepEqual(await readJsonInput(context, '--data', '-'), [1, 2, 3]);
  });

  test('says where invalid JSON came from, and where in it the problem is', async t => {
    const directory = temporaryDirectory(t);
    fs.writeFileSync(path.join(directory, 'bad.json'), '{\n  "a": 1,\n}');
    const context = createTestContext({ cwd: directory });

    await assert.rejects(readJsonInput(context, '--data', '{nope'), {
      message: /^--data isn't valid JSON: .*position 1/,
    });
    await assert.rejects(readJsonInput(context, '--data', '@bad.json'), {
      message: /^--data \(from bad\.json\) isn't valid JSON: .*line 3 column 1/,
    });

    const stdinContext = createTestContext();
    stdinContext.stdinStream.end('');
    await assert.rejects(readJsonInput(stdinContext, '--patch', '-'), {
      message: /^--patch \(from stdin\) isn't valid JSON/,
    });
  });

  test('reports a missing file', async () => {
    await assert.rejects(
      readJsonInput(createTestContext(), '--schema', '@missing.json'),
      { message: "Can't find missing.json (for --schema)" }
    );
  });
});

test('collectList splits commas and collects repeats', () => {
  assert.deepEqual(collectList('a, b,,c'), ['a', 'b', 'c']);
  assert.deepEqual(collectList('d', ['a', 'b']), ['a', 'b', 'd']);
});

describe('confirm', () => {
  test('--yes goes ahead without asking', async () => {
    const context = createTestContext({ interactive: true });

    await confirm(context, { question: 'Delete it?', yes: true });
    assert.equal(context.output.stderr, '');
  });

  test("refuses with exit code 5 when it can't ask", async () => {
    await assert.rejects(
      confirm(createTestContext(), { question: 'Delete recipes?' }),
      (error: unknown) =>
        exitCode(EXIT_CONFIRMATION_NEEDED)(error) &&
        (error as Error).message ===
          'Delete recipes? Run again with --yes to confirm'
    );
  });

  test('asks on a terminal, and goes ahead on yes', async () => {
    for (const answer of ['y\n', 'YES\n', ' yes \n']) {
      const context = createTestContext({ interactive: true });
      const confirmed = confirm(context, { question: 'Delete it?' });
      context.stdinStream.write(answer);

      await confirmed;
      assert.equal(context.output.stderr, 'Delete it? [y/N] ');
    }
  });

  test('is cancelled by anything else, including end of input', async () => {
    for (const answer of ['n\n', '\n', 'yep\n', null]) {
      const context = createTestContext({ interactive: true });
      const confirmed = confirm(context, { question: 'Delete it?' });
      if (answer === null) {
        context.stdinStream.end();
      } else {
        context.stdinStream.write(answer);
      }

      await assert.rejects(confirmed, (error: unknown) =>
        exitCode(EXIT_ERROR)(error)
      );
    }
  });
});

describe('promptSecret', () => {
  test('reads a line without echoing it, handling backspace and escape sequences', async () => {
    const context = createTestContext({ interactive: true });
    const secret = promptSecret(context, 'Token: ');

    context.stdinStream.write('abx');
    context.stdinStream.write(String.fromCharCode(127));
    context.stdinStream.write(`${String.fromCharCode(27)}[A`);
    context.stdinStream.write('c\r');

    assert.equal(await secret, 'abc');
    assert.equal(context.output.stderr, 'Token: \n');
    assert.deepEqual(context.stdinStream.rawModes, [true, false]);
  });

  test('Ctrl+C cancels with exit code 130', async () => {
    const context = createTestContext({ interactive: true });
    const secret = promptSecret(context, 'Token: ');
    context.stdinStream.write(`ab${String.fromCharCode(3)}`);

    await assert.rejects(secret, exitCode(EXIT_INTERRUPTED));
    assert.deepEqual(context.stdinStream.rawModes, [true, false]);
  });

  test("refuses when it isn't a terminal", async () => {
    await assert.rejects(promptSecret(createTestContext(), 'Token: '), {
      message: /isn't a terminal/,
    });
  });
});
