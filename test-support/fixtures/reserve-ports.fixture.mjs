// Run as a child process by the harness self-test. Reserves COUNT ports with
// reservePort, prints them as one JSON line, then holds them until stdin
// closes, so every child holds its claims while the others are reserving.
import { reservePort } from '../image-harness.mjs';

const count = Number(process.argv[2]);
const ports = [];
for (let i = 0; i < count; i += 1) ports.push(await reservePort());
process.stdout.write(`${JSON.stringify(ports)}\n`);
process.stdin.resume();
await new Promise((resolve) => process.stdin.once('end', resolve));
