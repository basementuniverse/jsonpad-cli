#!/usr/bin/env node
import { createContext } from './context.ts';
import { run } from './program.ts';

// When output is piped to something that stops reading early (e.g. head),
// there's nothing more to do
process.stdout.on('error', error => {
  if ((error as NodeJS.ErrnoException).code === 'EPIPE') {
    process.exit(process.exitCode ?? 0);
  }
  throw error;
});

process.exitCode = await run(process.argv.slice(2), createContext());
