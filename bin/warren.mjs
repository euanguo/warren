#!/usr/bin/env node
import { parseCliFlags } from './commands.mjs';
import { runCli } from './cli.mjs';
import { formatCliError } from './formatters.mjs';

const argv = process.argv.slice(2);
const asJson = Boolean(parseCliFlags(argv).flags.json);

process.on('unhandledRejection', (reason) => {
  formatCliError(reason, asJson);
  process.exit(1);
});

try {
  const code = await runCli(argv);
  if (code !== 0) process.exit(code);
} catch (error) {
  formatCliError(error, asJson);
  process.exit(1);
}
