// One request through the edge: node probe.mjs <host> <method> <path> [cookie|-] [form-body]
// Prints the status line, then the response headers as JSON, then the body.
import { request } from 'node:https';

const [host, method, path, cookieArg, formBody] = process.argv.slice(2);
const cookie = cookieArg === '-' ? undefined : cookieArg;
const req = request(
  {
    host: '127.0.0.1',
    port: 443,
    servername: host,
    method,
    path,
    rejectUnauthorized: false, // the edge's own local CA; the proof is of routing, not of trust
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
