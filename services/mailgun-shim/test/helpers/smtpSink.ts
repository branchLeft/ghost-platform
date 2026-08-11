import {
  SMTPServer,
  type SMTPServerAuthentication,
  type SMTPServerAuthenticationResponse,
  type SMTPServerDataStream,
  type SMTPServerSession,
} from 'smtp-server';
import { simpleParser, type ParsedMail } from 'mailparser';

export interface ReceivedMessage {
  envelopeTo: string[];
  parsed: ParsedMail;
}

export interface SmtpSink {
  port: number;
  messages: ReceivedMessage[];
  waitForCount(count: number, timeoutMs?: number): Promise<ReceivedMessage[]>;
  close(): Promise<void>;
}

/**
 * An in-process SMTP AUTH listener standing in for the delivery host (doc
 * 13 §2.2) — this is what "no deployment in this story" makes acceptable:
 * the shim's job is proven against the real SMTP protocol without needing
 * a real Hetzner box or a Docker-based MailHog/smtp4dev container in CI.
 */
export function startSmtpSink(authUser: string, authPass: string): Promise<SmtpSink> {
  const messages: ReceivedMessage[] = [];

  const server = new SMTPServer({
    authOptional: false,
    disabledCommands: ['STARTTLS'],
    onAuth(
      auth: SMTPServerAuthentication,
      _session: SMTPServerSession,
      callback: (err: Error | null | undefined, response?: SMTPServerAuthenticationResponse) => void
    ) {
      if (auth.username === authUser && auth.password === authPass) {
        callback(null, { user: authUser });
      } else {
        callback(new Error('Invalid credentials'));
      }
    },
    onData(
      stream: SMTPServerDataStream,
      session: SMTPServerSession,
      callback: (err?: Error | null) => void
    ) {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => {
        simpleParser(Buffer.concat(chunks))
          .then((parsed) => {
            messages.push({
              envelopeTo: session.envelope.rcptTo.map((r) => r.address),
              parsed,
            });
            callback();
          })
          .catch((err: Error) => callback(err));
      });
    },
  });

  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to bind SMTP sink'));
        return;
      }

      resolve({
        port: address.port,
        messages,
        async waitForCount(count, timeoutMs = 5000) {
          const start = Date.now();
          while (messages.length < count) {
            if (Date.now() - start > timeoutMs) {
              throw new Error(
                `Timed out waiting for ${count} message(s) at the SMTP sink, got ${messages.length}`
              );
            }
            await new Promise((r) => setTimeout(r, 25));
          }
          return messages;
        },
        close() {
          return new Promise((res) => server.close(() => res()));
        },
      });
    });
    server.on('error', reject);
  });
}
