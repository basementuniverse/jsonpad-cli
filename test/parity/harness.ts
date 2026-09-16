import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

export type ApiRequest = {
  method: string;
  path: string;
  query: Record<string, string[]>;
  body: unknown;
};

export type ApiResponse = {
  status: number;

  /**
   * Sent as JSON
   */
  body?: unknown;

  /**
   * Sent as it is, instead of body
   */
  text?: string;
};

export type Scenario = {
  name: string;
  args: string[];

  /**
   * Files to create in the working directory before running
   */
  files?: Record<string, string>;

  /**
   * Files to read from the working directory after running
   */
  outputs?: string[];

  /**
   * Leave JSONPAD_TOKEN unset
   */
  noToken?: boolean;

  /**
   * Respond to a request. The count is how many requests came before it
   */
  api?: (request: ApiRequest, count: number) => ApiResponse;

  /**
   * What must match the legacy command. Help, the version and argument errors
   * come from commander now, so only their exit codes are compared
   */
  compare?: 'all' | 'exitCode';
};

export type Result = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  requests: ApiRequest[];
  files: Record<string, string | null>;
};

export const ROOT = path.resolve(import.meta.dirname, '../..');
export const CLI_BIN = path.join(ROOT, 'build/cli.js');
export const GOLDEN_DIR = path.join(import.meta.dirname, 'golden');

function readBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => (body += chunk));
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

/**
 * Run a jsonpad command (the given bin) for a scenario, against a fake API
 */
export async function runScenario(
  bin: string,
  scenario: Scenario,
  args: string[] = scenario.args
): Promise<Result> {
  const requests: ApiRequest[] = [];
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url!, 'http://localhost');
    const text = await readBody(request);
    const apiRequest: ApiRequest = {
      method: request.method!,
      path: url.pathname,
      query: {},
      body: text ? JSON.parse(text) : null,
    };
    for (const [key, value] of url.searchParams) {
      (apiRequest.query[key] ??= []).push(value);
    }

    const reply = scenario.api?.(apiRequest, requests.length) ?? {
      status: 404,
      body: { name: 'NOT_FOUND', code: 0, message: 'Not found' },
    };
    requests.push(apiRequest);

    response.writeHead(reply.status, {
      'content-type':
        reply.text !== undefined ? 'text/plain' : 'application/json',
    });
    response.end(reply.text ?? JSON.stringify(reply.body ?? null));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonpad-cli-parity-'));
  for (const [name, content] of Object.entries(scenario.files ?? {})) {
    fs.writeFileSync(path.join(cwd, name), content);
  }

  try {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd,
      env: {
        PATH: process.env.PATH,
        ...(scenario.noToken ? {} : { JSONPAD_TOKEN: 'test-token' }),
        JSONPAD_API_URL: `http://127.0.0.1:${port}`,
        // Keeps the legacy command's deprecation notice out of recordings
        JSONPAD_NO_DEPRECATION: '1',
      },
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => (stdout += chunk));
    child.stderr.on('data', chunk => (stderr += chunk));
    const exitCode = await new Promise<number | null>(resolve =>
      child.on('close', resolve)
    );

    const files: Record<string, string | null> = {};
    for (const name of scenario.outputs ?? []) {
      const file = path.join(cwd, name);
      files[name] = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    }

    return { exitCode, stdout, stderr, requests, files };
  } finally {
    server.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

export function goldenPath(scenario: Scenario): string {
  return path.join(GOLDEN_DIR, `${scenario.name}.json`);
}
