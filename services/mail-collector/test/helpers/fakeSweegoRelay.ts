import { createServer } from 'node:net';
import { SMTPServer, type SMTPServerSession } from 'smtp-server';
import { simpleParser, type ParsedMail } from 'mailparser';

/**
 * What the fake relay does at each step. A reply code makes that step answer
 * with it; every refusal's text deliberately echoes the address and the login
 * it was given, so a test can prove none of that text reaches the client's
 * errors or the collector's logs.
 */
export interface RelayBehaviour {
  authReply?: number;
  mailFromReply?: number;
  rcptReply?: number;
  /** Refuse the DATA command itself, before any content is sent. */
  dataCommandReply?: number;
  /** Refuse at the end of DATA, after the content was sent. */
  dataReply?: number;
  /** Take the message body and never answer the end of DATA. */
  hangAfterData?: boolean;
}

export interface FakeRelay {
  port: number;
  behaviour: RelayBehaviour;
  /** Messages the relay accepted, parsed. */
  accepted: ParsedMail[];
  /** Every login the relay saw, accepted or not. */
  logins: Array<{ user: string; pass: string }>;
  close(): Promise<void>;
}

/** The slice of smtp-server's connection the DATA wrapper uses; the package ships no type for it. */
interface DataHandlerHolder {
  handler_DATA(command: unknown, callback: () => void): void;
  send(code: number, text: string): void;
  session: SMTPServerSession;
}

interface ServerInternals {
  connect(socket: unknown, socketOptions: unknown): void;
  connections: Set<unknown>;
}

function refusal(code: number, text: string): Error {
  return Object.assign(new Error(text), { responseCode: code });
}

/** A local SMTP listener standing in for the Sweego relay. No network beyond 127.0.0.1. */
export function startFakeSweegoRelay(user: string, pass: string): Promise<FakeRelay> {
  const relay: FakeRelay = {
    port: 0,
    behaviour: {},
    accepted: [],
    logins: [],
    close: () => Promise.resolve(),
  };

  const server = new SMTPServer({
    authOptional: false,
    disabledCommands: ['STARTTLS'],
    onAuth(auth, _session, callback) {
      relay.logins.push({ user: auth.username ?? '', pass: auth.password ?? '' });
      if (relay.behaviour.authReply !== undefined) {
        callback(
          refusal(relay.behaviour.authReply, `login refused for ${auth.username} ${auth.password}`)
        );
      } else if (auth.username === user && auth.password === pass) {
        callback(null, { user });
      } else {
        callback(refusal(535, `bad login for ${auth.username} ${auth.password}`));
      }
    },
    onMailFrom(address, _session, callback) {
      callback(
        relay.behaviour.mailFromReply === undefined
          ? null
          : refusal(relay.behaviour.mailFromReply, `sender ${address.address} refused`)
      );
    },
    onRcptTo(address, _session, callback) {
      callback(
        relay.behaviour.rcptReply === undefined
          ? null
          : refusal(relay.behaviour.rcptReply, `no such mailbox ${address.address}`)
      );
    },
    onData(stream, session: SMTPServerSession, callback) {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => {
        if (relay.behaviour.hangAfterData) {
          return;
        }
        if (relay.behaviour.dataReply !== undefined) {
          callback(
            refusal(
              relay.behaviour.dataReply,
              `content refused for ${session.envelope.rcptTo.map((r) => r.address).join(',')}`
            )
          );
          return;
        }
        simpleParser(Buffer.concat(chunks))
          .then((parsed) => {
            relay.accepted.push(parsed);
            callback();
          })
          .catch((err: Error) => callback(err));
      });
    },
  });

  // smtp-server has no hook for the reply to the DATA command, so wrap the
  // handler of each connection it opens.
  const internals = server as unknown as ServerInternals;
  const connect = internals.connect.bind(server);
  internals.connect = (socket, socketOptions) => {
    connect(socket, socketOptions);
    const connection = [...internals.connections].at(-1) as DataHandlerHolder;
    const handler = connection.handler_DATA.bind(connection);
    connection.handler_DATA = (command, callback) => {
      const reply = relay.behaviour.dataCommandReply;
      if (reply === undefined) {
        return handler(command, callback);
      }
      connection.send(reply, `data refused for ${connection.session.envelope.rcptTo[0]?.address}`);
      return callback();
    };
  };

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to bind fake relay'));
        return;
      }
      relay.port = address.port;
      relay.close = () => new Promise((done) => server.close(() => done()));
      resolve(relay);
    });
  });
}

/** A loopback port nothing listens on, for a refused connection. */
export function closedLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to find a free port'));
        return;
      }
      probe.close(() => resolve(address.port));
    });
  });
}
