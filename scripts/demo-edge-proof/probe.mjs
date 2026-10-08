// One request through the edge: node probe.mjs <host> <method> <path> [cookie|-] [form-body]
// Prints the status line, then the response headers as JSON, then the body.
import { readFileSync } from 'node:fs';
import { request } from 'node:https';

const [host, method, path, cookieArg, formBody] = process.argv.slice(2);
const cookie = cookieArg === '-' ? undefined : cookieArg;

// The edge's own local root, copied out of Caddy by the caller. Verification
// is never switched off: with no CA given there is nothing to trust, so stop.
const caFile = process.env.PROBE_CA_FILE;
if (!caFile) {
  console.error('PROBE_CA_FILE is required: the proof trusts the local CA explicitly');
  process.exit(2);
}
const ca = readFileSync(caFile);
const req = request(
  {
    host: '127.0.0.1',
    port: 443,
    servername: host,
    method,
    path,
    ca,
    headers: {
      host,
      ...(cookie ? { cookie } : {}),
      ...(formBody
        ? {
            'content-type': 'application/x-www-form-urlencoded',
            'content-length': Buffer.byteLength(formBody),
          }
        : {}),
    },
  },
  (res) => {
    let body = '';
    res.on('data', (chunk) => (body += chunk));
    res.on('end', () => {
      console.log(res.statusCode);
      console.log(JSON.stringify(res.headers));
      console.log(body);
    });
  }
);
req.on('error', (error) => {
  console.log('0');
  console.log('{}');
  console.log(String(error));
});
req.end(formBody);
