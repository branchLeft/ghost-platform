import { runProvision } from './provisionPortal.js';

process.exitCode = await runProvision(process.env, process.argv.slice(2), {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
});
