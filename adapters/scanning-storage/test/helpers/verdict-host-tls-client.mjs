// The safety service's side of a pinned TLS channel, as far as a test needs:
// it dials a host end that has a certificate no authority signed, takes
// whatever certificate it is shown, and reports the pin of it. Nothing is
// enforced here; the point is to see what a client would see.
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';

function pinOfCertificate(certificate) {
  return crypto
    .createHash('sha256')
    .update(certificate.publicKey.export({ type: 'spki', format: 'der' }))
    .digest('hex');
}

export function pinOfPeerCertificate(socket) {
  return pinOfCertificate(socket.getPeerX509Certificate());
}

// Verification is the client's own: the host's self-signed certificate is the
// only trust anchor (`ca`), chain and validity checks stay on, and the
// hostname check is replaced by the pin check, since the certificate names no
// host. A certificate that is not the pinned one is refused by the TLS client.
export function tlsRequest({
  port,
  path,
  method = 'GET',
  headers = {},
  body,
  tlsOptions = {},
  host = '127.0.0.1',
  certFile,
  pin,
}) {
  return new Promise((resolve, reject) => {
    if (typeof certFile !== 'string' || typeof pin !== 'string') {
      reject(new Error('tlsRequest needs the certificate file and the expected pin'));
      return;
    }
    const req = https.request(
      {
        ...tlsOptions,
        host,
        port,
        path,
        method,
        headers,
        agent: false,
        ca: fs.readFileSync(certFile),
        rejectUnauthorized: true,
        checkServerIdentity: (_name, peer) =>
          pinOfCertificate(new crypto.X509Certificate(peer.raw)) === pin
            ? undefined
            : new Error('the certificate shown is not the pinned identity'),
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            text: Buffer.concat(chunks).toString('utf8'),
            protocol: res.socket.getProtocol(),
            pin: pinOfPeerCertificate(res.socket),
          })
        );
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}
