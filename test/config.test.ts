import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import {
  configPath,
  maskToken,
  readConfig,
  resolveAuth,
  validateProfileName,
  writeConfig,
} from '../src/config.ts';
import { CliError, EXIT_NOT_FOUND } from '../src/errors.ts';
import { createTestContext, temporaryDirectory } from './helpers.ts';

describe('configPath', () => {
  test('uses JSONPAD_CONFIG, relative to the working directory', () => {
    const context = createTestContext({
      cwd: '/work',
      env: { JSONPAD_CONFIG: 'jsonpad.json', XDG_CONFIG_HOME: '/xdg' },
    });

    assert.equal(configPath(context), '/work/jsonpad.json');
  });

  test('uses XDG_CONFIG_HOME, then ~/.config', () => {
    assert.equal(
      configPath(createTestContext({ env: { XDG_CONFIG_HOME: '/xdg' } })),
      '/xdg/jsonpad/config.json'
    );
    assert.equal(
      configPath(createTestContext({ homedir: '/home/ada' })),
      '/home/ada/.config/jsonpad/config.json'
    );
  });

  test('ignores a relative XDG_CONFIG_HOME, as the spec says to', () => {
    assert.equal(
      configPath(
        createTestContext({
          homedir: '/home/ada',
          env: { XDG_CONFIG_HOME: 'x' },
        })
      ),
      '/home/ada/.config/jsonpad/config.json'
    );
  });

  test('uses APPDATA on Windows', () => {
    const context = createTestContext({
      platform: 'win32',
      env: { APPDATA: '/appdata' },
    });

    assert.equal(
      configPath(context),
      path.join('/appdata', 'jsonpad', 'config.json')
    );
  });
});

describe('readConfig and writeConfig', () => {
  test('a missing file is an empty config', t => {
    const directory = temporaryDirectory(t);
    const context = createTestContext({
      env: { JSONPAD_CONFIG: path.join(directory, 'config.json') },
    });

    assert.deepEqual(readConfig(context), { profiles: {} });
  });

  test('writes a file only the user can read, in a new directory', t => {
    const directory = temporaryDirectory(t);
    const file = path.join(directory, 'nested', 'config.json');
    const context = createTestContext({ env: { JSONPAD_CONFIG: file } });
    const config = {
      defaultProfile: 'local',
      profiles: { local: { token: 'abc', apiUrl: 'http://localhost:3000' } },
    };

    assert.equal(writeConfig(context, config), file);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
    assert.deepEqual(readConfig(context), config);
    assert.equal(context.output.stderr, '');
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['config.json']);
  });

  test('warns when other users can read the file', t => {
    const directory = temporaryDirectory(t);
    const file = path.join(directory, 'config.json');
    fs.writeFileSync(file, '{"profiles":{}}', { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    const context = createTestContext({ env: { JSONPAD_CONFIG: file } });

    readConfig(context);

    assert.match(context.output.stderr, /can be read by other users/);
    assert.match(context.output.stderr, /chmod 600/);
  });

  test('refuses invalid JSON and invalid shapes', t => {
    const directory = temporaryDirectory(t);
    const file = path.join(directory, 'config.json');
    const context = createTestContext({ env: { JSONPAD_CONFIG: file } });

    for (const [text, message] of [
      ['{ nope', /Can't parse/],
      ['[]', /isn't a valid config file/],
      ['{"profiles":{"a":{"token":1}}}', /isn't a valid config file/],
      ['{"profiles":{},"defaultProfile":3}', /isn't a valid config file/],
    ] as const) {
      fs.writeFileSync(file, text, { mode: 0o600 });
      assert.throws(() => readConfig(context), message);
    }
  });
});

describe('resolveAuth', () => {
  function setup(
    t: { after(fn: () => void): void },
    env: Record<string, string>,
    globalOptions = {}
  ) {
    const directory = temporaryDirectory(t);
    const file = path.join(directory, 'config.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        defaultProfile: 'prod',
        profiles: {
          prod: { token: 'prod-token' },
          local: { token: 'local-token', apiUrl: 'http://localhost:3000' },
        },
      }),
      { mode: 0o600 }
    );

    const context = createTestContext({
      env: { JSONPAD_CONFIG: file, ...env },
    });
    context.globalOptions = globalOptions;

    return context;
  }

  test('JSONPAD_TOKEN comes before the default profile', t => {
    const context = setup(t, {
      JSONPAD_TOKEN: 'env-token',
      JSONPAD_API_URL: 'http://env',
    });

    assert.deepEqual(resolveAuth(context), {
      token: 'env-token',
      apiUrl: 'http://env',
      source: { type: 'environment' },
    });
  });

  test("JSONPAD_TOKEN doesn't read the config file at all", t => {
    const context = createTestContext({
      env: { JSONPAD_TOKEN: 'env-token', JSONPAD_CONFIG: '/does/not/exist/x' },
    });

    assert.equal(resolveAuth(context).apiUrl, 'https://api.jsonpad.io');
  });

  test('the default profile is used without JSONPAD_TOKEN', t => {
    const context = setup(t, { JSONPAD_API_URL: 'http://env' });

    assert.deepEqual(resolveAuth(context), {
      token: 'prod-token',
      apiUrl: 'http://env',
      source: { type: 'profile', name: 'prod' },
    });
  });

  test('--profile and JSONPAD_PROFILE come before JSONPAD_TOKEN', t => {
    for (const context of [
      setup(t, { JSONPAD_TOKEN: 'env-token' }, { profile: 'local' }),
      setup(t, { JSONPAD_TOKEN: 'env-token', JSONPAD_PROFILE: 'local' }),
    ]) {
      assert.deepEqual(resolveAuth(context), {
        token: 'local-token',
        apiUrl: 'http://localhost:3000',
        source: { type: 'profile', name: 'local' },
      });
    }
  });

  test('--profile comes before JSONPAD_PROFILE', t => {
    const context = setup(t, { JSONPAD_PROFILE: 'local' }, { profile: 'prod' });

    assert.equal(resolveAuth(context).token, 'prod-token');
  });

  test("a profile's API URL comes before JSONPAD_API_URL, and --api-url before both", t => {
    assert.equal(
      resolveAuth(
        setup(t, { JSONPAD_API_URL: 'http://env' }, { profile: 'local' })
      ).apiUrl,
      'http://localhost:3000'
    );
    assert.equal(
      resolveAuth(
        setup(
          t,
          { JSONPAD_API_URL: 'http://env' },
          {
            profile: 'local',
            apiUrl: 'http://flag',
          }
        )
      ).apiUrl,
      'http://flag'
    );
    assert.equal(
      resolveAuth(setup(t, { JSONPAD_TOKEN: 'x' }, { apiUrl: 'http://flag' }))
        .apiUrl,
      'http://flag'
    );
  });

  test('a missing profile is a not found error', t => {
    assert.throws(
      () => resolveAuth(setup(t, {}, { profile: 'ghost' })),
      (error: unknown) =>
        error instanceof CliError &&
        error.exitCode === EXIT_NOT_FOUND &&
        /no profile named "ghost"/.test(error.message)
    );
  });

  test('with no token and no profiles, the message is the one the SDK command used', () => {
    const context = createTestContext({
      env: { JSONPAD_CONFIG: '/does/not/exist/config.json' },
    });

    assert.throws(() => resolveAuth(context), {
      message: 'Set the JSONPAD_TOKEN environment variable to an API token',
    });
  });
});

test('validateProfileName', () => {
  for (const name of ['prod', 'local-2', 'my_app']) {
    assert.doesNotThrow(() => validateProfileName(name));
  }
  for (const name of ['', '-x', 'a b', 'a/b', '../x']) {
    assert.throws(() => validateProfileName(name), CliError);
  }
});

test('maskToken shows only the end of a token', () => {
  assert.equal(maskToken('abcdefghijklmnop'), '••••mnop');
  assert.equal(maskToken('short'), '••••');
});
