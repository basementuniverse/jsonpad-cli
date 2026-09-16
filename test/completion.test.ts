import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { completions, completionScript } from '../src/completion.ts';
import { createProgram, run } from '../src/program.ts';
import { CLI_BIN } from './parity/harness.ts';
import { createTestContext, temporaryDirectory } from './helpers.ts';

const program = createProgram(createTestContext());
const complete = (...words: string[]) => completions(program, words);

describe('completions', () => {
  test('top-level commands', () => {
    assert.ok(complete('').includes('items'));
    assert.ok(complete('').includes('sync-schema'));
    assert.deepEqual(complete('it'), ['items']);
  });

  test('subcommands, after global options', () => {
    assert.deepEqual(complete('items', 'data', ''), [
      'get',
      'set',
      'replace',
      'patch',
      'delete',
    ]);
    assert.deepEqual(complete('--profile', 'local', 'identities', 'se'), [
      'self',
    ]);
    assert.deepEqual(complete('-V', 'identities', 'self', 'u'), ['update']);
  });

  test("options, including the global ones and a group's default subcommand", () => {
    assert.deepEqual(complete('whoami', '--o'), ['--output']);
    assert.ok(complete('items', '--').includes('--profile'));
    assert.ok(complete('lists', '--all', '--').includes('--max'));
    assert.deepEqual(complete('items', 'recipes', '--or'), ['--order']);
  });

  test("an option's choices", () => {
    assert.deepEqual(complete('whoami', '-o', ''), [
      'table',
      'json',
      'ndjson',
      'id',
    ]);
    assert.deepEqual(complete('lists', '--direction', 'd'), ['desc']);
    assert.deepEqual(complete('identities', 'login', '--output', 'e'), ['env']);
  });

  test("an argument's choices", () => {
    assert.deepEqual(complete('completion', ''), ['bash', 'zsh', 'fish']);
  });

  test('nothing (so the shell completes files) for free-form values', () => {
    assert.deepEqual(complete('items', 'import', 'recipes', ''), []);
    assert.deepEqual(complete('items', 'export', 'recipes', '--out', ''), []);
    assert.deepEqual(complete('items', 'recipes', ''), []);
    assert.deepEqual(complete('lists', '--name', ''), []);
  });

  test('jsonpad __complete outputs one candidate per line', async () => {
    const context = createTestContext();

    assert.equal(await run(['__complete', 'config', 'u'], context), 0);
    assert.equal(context.output.stdout, 'use\n');
  });
});

describe('completion scripts', () => {
  test('are output for each shell, and rejected for others', async () => {
    for (const shell of ['bash', 'zsh', 'fish']) {
      const context = createTestContext();
      assert.equal(await run(['completion', shell], context), 0);
      assert.equal(context.output.stdout, completionScript(shell as 'bash'));
      assert.match(context.output.stdout, /jsonpad __complete/);
    }

    assert.equal(
      await run(['completion', 'powershell'], createTestContext()),
      1
    );
  });

  test('the bash and zsh scripts are valid', () => {
    for (const shell of ['bash', 'zsh'] as const) {
      const check = spawnSync(shell, ['-n'], {
        input: completionScript(shell),
      });

      assert.equal(check.status, 0, `${shell}: ${check.stderr}`);
    }
  });

  test('the bash script completes, using the jsonpad command', t => {
    const bin = temporaryDirectory(t);
    const shim = path.join(bin, 'jsonpad');
    fs.writeFileSync(
      shim,
      `#!/bin/sh\nexec "${process.execPath}" "${CLI_BIN}" "$@"\n`
    );
    fs.chmodSync(shim, 0o755);

    const output = execFileSync(
      'bash',
      [
        '-c',
        `${completionScript('bash')}
COMP_WORDS=(jsonpad items da); COMP_CWORD=2; _jsonpad_completion; echo "\${COMPREPLY[*]}"
COMP_WORDS=(jsonpad completion ""); COMP_CWORD=2; _jsonpad_completion; echo "\${COMPREPLY[*]}"`,
      ],
      { env: { PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' }
    );

    assert.equal(output, 'data\nbash zsh fish\n');
  });
});
