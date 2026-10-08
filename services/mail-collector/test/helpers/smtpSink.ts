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
  /** The SMTP MAIL FROM address (the return path), as opposed to the From header. */
  envelopeFrom: string | false;
  /** The DSN NOTIFY keywords requested for the first recipient, when any were. */
  dsnNotify: string[] | undefined;
  parsed: ParsedMail;
  /** Wall-clock time this sink accepted the message -- lets a test measure spacing between deliveries (e.g. proving a shared rate limit serializes them), not just their count. */
  receivedAt: number;
}

export interface SmtpSink {
  port: number;
  messages: ReceivedMessage[];
  waitForCount(count: number, timeoutMs?: number): Promise<ReceivedMessage[]>;
  close(): Promise<void>;
}

/**
 * A real, local, authenticated SMTP listener standing in for mx1 (HLD §03).
 * Every message the collector's deliveryClient submits goes over this real
 * socket with real AUTH -- nothing about the delivery path is mocked; only
 * the address at the other end is a stand-in, exactly as the issue's own
 * Done criteria ask for.
 */
export function startSmtpSink(authUser: string, authPass: string): Promise<SmtpSink> {
  const messages: ReceivedMessage[] = [];

  const server = new SMTPServer({
    authOptional: false,
    // smtp-server hides the DSN extension by default; mx1 is expected to advertise it.
    hideDSN: false,
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
              envelopeFrom: session.envelope.mailFrom && session.envelope.mailFrom.address,
              dsnNotify: (session.envelope.rcptTo[0] as { dsn?: { notify?: string[] } } | undefined)
                ?.dsn?.notify,
              parsed,
              receivedAt: Date.now(),
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
