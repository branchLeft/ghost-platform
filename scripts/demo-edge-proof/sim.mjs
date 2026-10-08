// Stand-ins for one demo slot's two colours and its health router, for
// scripts/test-demo-edge.sh. Colour a answers on 9300, colour b on 9301;
// the health port answers 200 for a colour only while /drain/<a|b> does not
// exist, which is how the proof drains the serving colour.
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';

const COLOURS = { '127.0.0.1:9300': 'a', '127.0.0.1:9301': 'b' };

for (const [port, colour] of [
  [9300, 'a'],
  [9301, 'b'],
]) {
  createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`colour-${colour} ${req.method} ${req.url}`);
  }).listen(port, '127.0.0.1');
}

createServer((req, res) => {
  const colour = COLOURS[req.headers['x-colour-upstream']];
  const healthy = req.url === '/healthz' && colour !== undefined && !existsSync(`/drain/${colour}`);
  res.writeHead(healthy ? 200 : 503);
  res.end();
}).listen(9100, '127.0.0.1');
