// Stands in for mx1: the "real system" the collector delivers to. Records
// every delivery to a file on a named volume (so `docker compose exec` can
// read it back after the fact) rather than only to stdout, and answers
// /deliveries so the proof script can poll for a count without grepping logs.
import { createServer } from 'node:http';
import { appendFileSync, readFileSync, existsSync, writeFileSync } from 'node:fs';

const LOG_PATH = '/data/deliveries.ndjson';
if (!existsSync(LOG_PATH)) {
  writeFileSync(LOG_PATH, '');
}

const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    if (req.method === 'POST' && req.url === '/deliver') {
      const body = Buffer.concat(chunks).toString('utf8');
      appendFileSync(LOG_PATH, body + '\n');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === 'GET' && req.url === '/deliveries') {
      const lines = readFileSync(LOG_PATH, 'utf8').split('\n').filter(Boolean);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(lines.map((l) => JSON.parse(l))));
      return;
    }
    res.writeHead(404);
    res.end();
  });
});

server.listen(3000, '0.0.0.0', () => {
  console.log('delivery stub listening on 3000');
});
