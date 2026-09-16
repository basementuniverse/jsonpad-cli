import { createContext, type Context } from '../src/context.ts';

export type TestContext = Context & {
  output: { stdout: string; stderr: string };
};

/**
 * A context that captures output instead of writing it
 */
export function createTestContext(
  options: { env?: Record<string, string>; isTTY?: boolean } = {}
): TestContext {
  const output = { stdout: '', stderr: '' };
  const context = createContext({
    env: options.env ?? {},
    cwd: process.cwd(),
    stdout: {
      isTTY: options.isTTY ?? false,
      write: (text: string) => (output.stdout += text),
    },
    stderr: { write: (text: string) => (output.stderr += text) },
  });

  return Object.assign(context, { output });
}
