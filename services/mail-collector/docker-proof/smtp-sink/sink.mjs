// A real, local, authenticated SMTP listener standing in for mx1 (HLD §03),
// for the docker-proof only. Records every accepted delivery to a file so
// run-drain-proof.sh can poll a count without grepping container logs --
// the same shape as services/mailgun-shim/docker-proof/delivery-stub.mjs,
// just speaking real SMTP instead of a bare HTTP POST.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { SMTPServer } from 'smtp-server';
import { simpleParser } from 'mailparser';

const LOG_PATH = '/data/deliveries.ndjson';
if (!existsSync(LOG_PATH)) {
  writeFileSync(LOG_PATH, '');
}

const AUTH_USER = process.env.SINK_SMTP_USER;
const AUTH_PASS = process.env.SINK_SMTP_PASS;
if (!AUTH_USER || !AUTH_PASS) {
  throw new Error('SINK_SMTP_USER and SINK_SMTP_PASS are required');
}

const server = new SMTPServer({
  authOptional: false,
  disabledCommands: ['STARTTLS'],
  onAuth(auth, _session, callback) {
    if (auth.username === AUTH_USER && auth.password === AUTH_PASS) {
      callback(null, { user: AUTH_USER });
    } else {
      callback(new Error('Invalid credentials'));
    }
  },
  onData(stream, session, callback) {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => {
      simpleParser(Buffer.concat(chunks))
        .then((parsed) => {
          appendFileSync(
            LOG_PATH,
            JSON.stringify({
              envelopeTo: session.envelope.rcptTo.map((r) => r.address),
              subject: parsed.subject,
            }) + '\n'
          );
          callback();
        })
        .catch((err) => callback(err));
    });
  },
});

server.listen(2525, '0.0.0.0', () => {
  console.log('smtp-sink listening on 2525');
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
