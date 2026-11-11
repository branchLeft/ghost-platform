// The shape checks for an image publish workflow that follows the
// drain-sidecar route: a `build` job that proves and saves the image, and a
// `push` job that loads exactly that image and publishes it. One home, used
// by workflow-drain-sidecar-publish.test.js and workflow-demo-edge-image.test.js.
// Node built-ins only. See publish-job-checks.md.

// Whole-line comments and trailing ones (a `#` after whitespace) both go, so
// text inside a comment can never satisfy a check.
export const withoutComments = (text) => text.replace(/^\s*#.*$/gm, '').replace(/\s+#.*$/gm, '');

export const GUARD =
  "github.ref == 'refs/heads/main' && (github.event_name == 'workflow_dispatch' || github.event_name == 'push')";
export const normalise = (condition) =>
  condition
    .replace(/^\s*if:\s*\|?-?/, '')
    .replace(/\s+/g, ' ')
    .trim();

// A job is the block under `jobs:` at two spaces of indent. Its own keys sit
// at four spaces, so a step-level `if:` (eight or more) is never mistaken for
// the job's own.
export function parseJobs(source, strip = true) {
  const lines = (strip ? withoutComments(source) : source).split('\n');
  const jobs = {};
  let current = null;
  for (const line of lines.slice(lines.indexOf('jobs:') + 1)) {
    const header = /^ {2}([a-z][a-z-]*):\s*$/.exec(line);
    if (header) {
      current = { lines: [], condition: '' };
      jobs[header[1]] = current;
    } else if (current) {
      current.lines.push(line);
    }
  }
  for (const job of Object.values(jobs)) {
    job.text = job.lines.join('\n');
    const at = job.lines.findIndex((l) => /^ {4}if:/.test(l));
    if (at >= 0) {
      const rest = job.lines.slice(at + 1);
      const end = rest.findIndex((l) => /^ {4}\S/.test(l));
      job.condition = [job.lines[at], ...(end < 0 ? rest : rest.slice(0, end))].join('\n');
    }
  }
  return jobs;
}

export function problems(source) {
  const found = [];
  const { build, push } = parseJobs(source);
  if (!build || !push) return ['build and push jobs both exist'];
  const top = withoutComments(source).split(/^jobs:\n/m)[0];
  const grantsWrite = /:\s*write(-all)?\s*$|^\s*permissions:\s*write-all/m;
  if (grantsWrite.test(top)) found.push('top-level permissions grant a write scope');
  for (const [name, job] of Object.entries(parseJobs(source))) {
    // The attest job holds the signing and registry-bundle grants, and runs
    // only after the push and the scan jobs have succeeded.
    if (!['push', 'attest'].includes(name) && grantsWrite.test(job.text)) {
      found.push(`job ${name} holds a write permission; only push and attest may`);
    }
  }
  if (!/packages:\s*write/.test(push.text)) found.push('push job lacks packages: write');
  if (!/^ {4}needs: build$/m.test(push.text)) found.push('push job does not wait on the proof job');
  if (normalise(push.condition) !== GUARD) {
    found.push('push job has no job-level guard that is exactly the main-only expression');
  }
  if (!/docker push "\$IMAGE:\$IMAGE_TAG"/.test(push.text)) found.push('push job never pushes');
  // Scanned unstripped: a `#` inside a `run: |` body is shell text, not a
  // YAML comment, and must not be able to hide a build behind it.
  const rawPush = parseJobs(source, false).push.text;
  if (/\bdocker\b[^\n]*\bbuild\b|build-push-action/.test(rawPush)) {
    found.push('push job rebuilds the image instead of publishing the proven one');
  }
  if (!/needs\.build\.outputs\.image-id/.test(push.text)) {
    found.push("push job does not consume the proof job's image ID");
  }
  if (!/docker load\b/.test(push.text)) found.push('push job does not load the proven image');
  if (!/image-id=.*docker image inspect/.test(build.text) || !/docker save\b/.test(build.text)) {
    found.push('proof job does not save the proven image and output its ID');
  }
  if (!/\^sha256:\[0-9a-f\]\{64\}\$/.test(push.text) || !/exit 1/.test(push.text)) {
    found.push('push job does not refuse a malformed digest');
  }
  if (!/image: \$\{\{ steps\.digest\.outputs\.image \}\}/.test(push.text)) {
    found.push('push job does not output the pinned reference');
  }
  if (/:latest/.test(push.text)) found.push('push job tags latest');
  return found;
}
