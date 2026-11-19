// WHAT: The cockpit's entrypoint — binds the loopback socket and prints the boot banner.
// WHY: Everything this process does on a request lives in router.mjs. Owning the socket
//      here, and nothing else, is what lets a test import the handler without a server
//      appearing on port 4310 as a side effect of the import (assessment finding F6).
import { createServer } from 'node:http';
import { config, configSummary } from './lib/config.mjs';
import { handleRequest } from './router.mjs';

const server = createServer(handleRequest);

// A second cockpit on 4310 is the likely cause and a routine mistake; an unhandled
// 'error' event turns that into a stack trace that buries the one useful word.
server.on('error', (err) => {
  console.error(`Cannot bind ${config.server.host}:${config.server.port} — ${err.code ?? err.message}`);
  if (err.code === 'EADDRINUSE') console.error('  a cockpit is probably already running.');
  process.exit(1);
});

server.listen(config.server.port, config.server.host, () => {
  const summary = configSummary();
  console.log(`StudyDeck cockpit → http://${config.server.host}:${config.server.port}`);
  console.log(`  topics: ${summary.topics.join(', ')}`);
  console.log(`  open notebook password: ${summary.onPassword}`);
  console.log(`  grader model: ${summary.ollamaModel}`);
  console.log(`  claude api key: ${summary.claudeKey} (roles model: ${summary.claudeModel})`);
  console.log(`  tailnet: ${summary.tailnet}`);
});
