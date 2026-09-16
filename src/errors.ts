import { JSONPadError } from './sdk.ts';

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_REBUILD_NOT_ALLOWED = 2;
export const EXIT_BUILD_FAILED = 3;
export const EXIT_DESTRUCTIVE_NOT_ALLOWED = 4;

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
