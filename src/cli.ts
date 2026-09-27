#!/usr/bin/env node
import { setup } from './setup.js';
import { startServer } from './server.js';

try {
  const command = process.argv[2] ?? 'serve';
  if (command === 'setup') await setup();
  else if (command === 'serve') await startServer();
  else if (command === '--help' || command === 'help') {
    console.log('mailmcp setup   Select Mail accounts, Trash mailboxes, tools and harnesses\nmailmcp serve   Start the MCP server over stdio (default)\n\nSet MAILMCP_CONFIG to use another configuration file.');
  } else throw new Error(`Unknown command: ${command}. Use mailmcp --help.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
