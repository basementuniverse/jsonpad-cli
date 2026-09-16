import { JSONPadError } from './sdk.ts';

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_REBUILD_NOT_ALLOWED = 2;
export const EXIT_BUILD_FAILED = 3;
export const EXIT_DESTRUCTIVE_NOT_ALLOWED = 4;
export const EXIT_CONFIRMATION_NEEDED = 5;
export const EXIT_NOT_FOUND = 6;
export const EXIT_PERMISSION_DENIED = 7;
export const EXIT_LIMIT_REACHED = 8;
export const EXIT_INTERRUPTED = 130;

/**
 * API errors (403s) that mean a plan limit was reached, rather than that the
 * token isn't allowed to do something
 */
const PLAN_LIMIT_ERRORS = new Set([
  'MAX_LISTS_EXCEEDED',
  'MAX_ITEMS_EXCEEDED',
  'MAX_INDEXES_EXCEEDED',
  'MAX_TOKENS_EXCEEDED',
  'MAX_IDENTITIES_EXCEEDED',
  'STORAGE_LIMIT_EXCEEDED',
]);

/**
 * An error with a message for the user, and the exit code to finish with
 */
export class CliError extends Error {
  public readonly exitCode: number;

  public constructor(message: string, exitCode: number = EXIT_ERROR) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

/**
 * Get the message to show for an error thrown by the SDK
 */
export function describeApiError(error: unknown): string {
  if (error instanceof JSONPadError) {
    try {
      return JSON.parse(error.message).message || error.message;
    } catch {
      return `The API responded with status ${error.status}`;
    }
  }

  return error instanceof Error && error.message
    ? error.message
    : String(error);
}

/**
 * Turn an error thrown by the SDK into a CliError, with an exit code that says
 * what kind of failure it was
 *
 * The commands ported from the SDK's jsonpad command don't use this: they
 * exit with 1 for every API error, as they always have
 */
export function apiError(error: unknown, apiUrl?: string): CliError {
  if (error instanceof CliError) {
    return error;
  }

  // fetch rejects with a TypeError when it can't reach the server, with the
  // reason (e.g. ECONNREFUSED) as its cause
  if (error instanceof TypeError && error.message === 'fetch failed') {
    const cause = error.cause as
      { code?: string; message?: string } | undefined;
    const reason = cause?.code || cause?.message || error.message;

    return new CliError(
      `Can't connect to ${apiUrl ?? 'the API'} (${reason})`,
      EXIT_ERROR
    );
  }

  return new CliError(describeApiError(error), apiErrorExitCode(error));
}

export function apiErrorExitCode(error: unknown): number {
  if (!(error instanceof JSONPadError)) {
    return EXIT_ERROR;
  }

  switch (error.status) {
    case 404:
      return EXIT_NOT_FOUND;
    case 401:
      return EXIT_PERMISSION_DENIED;
    case 403:
      return error.errorName && PLAN_LIMIT_ERRORS.has(error.errorName)
        ? EXIT_LIMIT_REACHED
        : EXIT_PERMISSION_DENIED;
    case 429:
      return EXIT_LIMIT_REACHED;
    default:
      return EXIT_ERROR;
  }
}
