// The safety service's side of a pinned TLS channel, as far as a test needs:
// it dials a host end that has a certificate no authority signed, takes
// whatever certificate it is shown, and reports the pin of it. Nothing is
// enforced here; the point is to see what a client would see.
import crypto from 'node:crypto';
import https from 'node:https';

export function pinOfPeerCertificate(socket) {
  const certificate = socket.getPeerX509Certificate();
  return crypto
    .createHash('sha256')
    .update(certificate.publicKey.export({ type: 'spki', format: 'der' }))
    .digest('hex');
}

export function tlsRequest({
  port,
  path,
  method = 'GET',
  headers = {},
  body,
  tlsOptions = {},
  host = '127.0.0.1',
}) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host,
        port,
        path,
        method,
        headers,
        agent: false,
        rejectUnauthorized: false,
        ...tlsOptions,
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
