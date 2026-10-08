// Run inside a container: `node - HOST PORT < tcpprobe.js`. Exit 0 only if a
// TCP connection opens.
const [host, port] = process.argv.slice(2);
const socket = require('node:net').connect({ host, port: Number(port) });
socket.setTimeout(3000);
socket.on('connect', () => process.exit(0));
socket.on('error', () => process.exit(1));
socket.on('timeout', () => process.exit(1));
