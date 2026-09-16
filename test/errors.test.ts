import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CliError, describeApiError, EXIT_ERROR } from '../src/errors.ts';
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
