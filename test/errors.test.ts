import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  apiError,
  CliError,
  describeApiError,
  EXIT_ERROR,
  EXIT_LIMIT_REACHED,
  EXIT_NOT_FOUND,
  EXIT_PERMISSION_DENIED,
} from '../src/errors.ts';
import { parseTimeout } from '../src/indexes.ts';
import { JSONPadError } from '../src/sdk.ts';

const meta = {
  status: 400,
  requestId: null,
  rateLimit: null,
  quota: null,
  retryAfter: null,
};

test('describeApiError uses the message from a jsonpad error response', () => {
  const error = new JSONPadError(
    400,
    JSON.stringify({ name: 'VALIDATION_ERROR', code: 1, message: 'Nope' }),
    meta
  );

  assert.equal(describeApiError(error), 'Nope');
});

test("describeApiError falls back to the status when the body isn't JSON", () => {
  assert.equal(
    describeApiError(new JSONPadError(502, '<html>', meta)),
    'The API responded with status 502'
  );
});

test('describeApiError uses the raw body when the JSON has no message', () => {
  assert.equal(describeApiError(new JSONPadError(500, '{}', meta)), '{}');
});

test('describeApiError handles other errors and non-errors', () => {
  assert.equal(describeApiError(new Error('fetch failed')), 'fetch failed');
  assert.equal(describeApiError('something'), 'something');
});

test('CliError defaults to exit code 1', () => {
  assert.equal(new CliError('x').exitCode, EXIT_ERROR);
  assert.equal(new CliError('x', 4).exitCode, 4);
});

test('parseTimeout reads seconds, defaulting to 600', () => {
  assert.equal(parseTimeout(undefined), 600_000);
  assert.equal(parseTimeout('1.5'), 1500);

  for (const value of ['0', '-1', 'soon', 'Infinity']) {
    assert.throws(() => parseTimeout(value), CliError);
  }
});

test('apiError maps API errors to exit codes', () => {
  const error = (status: number, name = 'SOMETHING') =>
    new JSONPadError(
      status,
      JSON.stringify({ name, code: 1, message: `${name} happened` }),
      { ...meta, status }
    );

  for (const [status, name, code] of [
    [404, 'LIST_NOT_FOUND', EXIT_NOT_FOUND],
    [401, 'USER_NOT_AUTHENTICATED', EXIT_PERMISSION_DENIED],
    [403, 'TOKEN_PERMISSION_DENIED', EXIT_PERMISSION_DENIED],
    [403, 'MAX_LISTS_EXCEEDED', EXIT_LIMIT_REACHED],
    [403, 'STORAGE_LIMIT_EXCEEDED', EXIT_LIMIT_REACHED],
    [429, 'RATE_LIMIT_EXCEEDED', EXIT_LIMIT_REACHED],
    [429, 'QUOTA_EXCEEDED', EXIT_LIMIT_REACHED],
    [409, 'INDEX_BUILDING', EXIT_ERROR],
    [500, 'INTERNAL', EXIT_ERROR],
  ] as const) {
    const mapped = apiError(error(status, name));

    assert.equal(mapped.exitCode, code, `${status} ${name}`);
    assert.equal(mapped.message, `${name} happened`);
  }
});

test("apiError says which URL it couldn't connect to", () => {
  const error = new TypeError('fetch failed', {
    cause: Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ECONNREFUSED',
    }),
  });

  assert.deepEqual(
    [
      apiError(error, 'http://localhost:3000').message,
      apiError(error, 'http://localhost:3000').exitCode,
    ],
    ["Can't connect to http://localhost:3000 (ECONNREFUSED)", EXIT_ERROR]
  );
});

test('apiError passes CliErrors through', () => {
  const error = new CliError('nope', 5);

  assert.equal(apiError(error), error);
});
