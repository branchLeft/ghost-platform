// A placeholder standing in for an address-shaped, permanently fixed host
// (e.g. `<edge1-ipv4>`) pasted into a fenced command silently breaks every
// command proxied through it: db1 is private-only, so every remote command
// in these runbooks hops through edge1 to reach it, and a placeholder that
// cannot resolve fails each of them identically rather than loudly on the
// first. This guards against that defect class, not against every
// angle-bracket token in a runbook.
//
// Scope, deliberately narrower than "no <...> anywhere in a fenced block":
//
// - Only *fenced command blocks* count. A runbook's prose regularly names a
//   placeholder while explaining what it stands for (e.g. "`<edge1-ipv4>` is
//   edge1's public address, from the Hetzner Cloud Console.") -- that sentence
//   is documentation, not a command someone pastes, and must not fail this
//   test or the test becomes noise someone deletes.
// - Only `bash` and `sql` fences count as command blocks in this repo's
//   runbooks -- `text`/`yaml` fences here hold illustrative sample
//   output/config, never something to paste and run (infra/platform/
//   RUNBOOK-bootstrap.md's four `text` fences are all captured error/lookup
//   output).
// - Only placeholders for a *known, single-valued, permanently fixed* host
//   address are flagged: currently edge1 (`46.225.95.167`) and db1
//   (`10.20.1.20`), both documented as literal addresses -- never "run a
//   command to find out" -- in RUNBOOK-tenant-onboarding.md's own address
//   table. A runbook that re-runs for a different tenant, host, digest or
//   run each time legitimately parameterises on tokens like `<slug>`,
//   `<digest>`, `<run-id>`, `<tenant>` -- those have no single right answer
//   for this test to demand. app1's address is deliberately excluded even
//   though it is also in that table: its *private* address is fixed
//   (`10.20.1.100`) but its *public* one is not -- the table's own app1 row
//   says to resolve it with `pulumi stack output app1PublicIpv4`, because
//   unlike edge1 and db1 it can change on a host rebuild -- and both
//   addresses share the "app1" name, so a name-based check cannot tell them
//   apart without reintroducing exactly the false positives this scoping
//   exists to avoid.
//
// A token that legitimately varies per invocation is not this bug. A token
// standing in for a fact this repo already knows and has written down
// elsewhere is.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

const RUNBOOK_PATHS = [
  'RUNBOOK-bucket-fencing.md',
  'RUNBOOK-tenant-onboarding.md',
  'db/RUNBOOK-db.md',
  'infra/platform/RUNBOOK-bootstrap.md',
];

// The permanently fixed hosts, and the fence languages this repo's runbooks
// actually use for commands the operator pastes and runs.
const FIXED_HOSTS = ['edge1', 'db1'];
const COMMAND_FENCE_LANGS = new Set(['bash', 'sql']);

const FENCE_RE = /^```([a-zA-Z0-9_-]*)\s*$/;

/**
 * Split a runbook's text into fenced blocks, returning only those whose
 * language is a command language this repo uses. Malformed input (an
 * unterminated fence) is surfaced by leaving the last block open rather than
 * silently dropping it, so a truncated file cannot pass by accident.
 */
function commandBlocks(text) {
  const lines = text.split('\n');
  const blocks = [];
  let current = null;
  for (const line of lines) {
    const fenceMatch = line.match(FENCE_RE);
    if (fenceMatch) {
      if (current === null) {
        current = { lang: fenceMatch[1].toLowerCase(), lines: [] };
      } else {
        blocks.push(current);
        current = null;
      }
      continue;
    }
    if (current !== null) {
      current.lines.push(line);
    }
  }
  // An unterminated fence still gets scanned: if a runbook is malformed
  // enough to lose its closing fence, that is exactly when a placeholder
  // needs catching most, not a reason to skip it.
  if (current !== null) {
    blocks.push(current);
  }
  return blocks.filter((b) => COMMAND_FENCE_LANGS.has(b.lang));
}

// A bare mention of a fixed host's name is not itself the bug -- db/
// RUNBOOK-db.md legitimately writes `<db1 backup key id>`, a per-invocation
// credential id that happens to name db1, not an address. The defect this
// test targets is specifically an *address* standing in for the host, so a
// placeholder only counts when it names the host AND reads as an address
// (ip/ipv4/address/addr as a whole word, not a substring of something else).
const ADDRESS_WORD_RE = /(?:^|[^a-z])(?:ip|ipv4|address|addr)(?:[^a-z]|$)/i;

/**
 * For each fixed host, an address-shaped placeholder token that names it --
 * `<edge1-ipv4>`, `<edge1_ip>`, `<db1-address>`, and so on.
 */
function findFixedHostPlaceholders(blockText) {
  const found = [];
  const tokenRe = /<[^<>\n]+>/g;
  let match;
  while ((match = tokenRe.exec(blockText)) !== null) {
    const token = match[0];
    const lower = token.toLowerCase();
    if (!ADDRESS_WORD_RE.test(lower)) continue;
    for (const host of FIXED_HOSTS) {
      if (lower.includes(host)) {
        found.push(token);
        break;
      }
    }
  }
  return found;
}

test('no RUNBOOK-*.md fenced command block contains a placeholder for a permanently fixed host address', () => {
  const violations = [];
  for (const relPath of RUNBOOK_PATHS) {
    const text = readFileSync(path.join(ROOT, relPath), 'utf8');
    for (const block of commandBlocks(text)) {
      for (const token of findFixedHostPlaceholders(block.lines.join('\n'))) {
        violations.push(`${relPath}: ${token}`);
      }
    }
  }
  assert.deepEqual(
    violations,
    [],
    `found unresolved fixed-host placeholder(s) in a fenced command block:\n${violations.join('\n')}`
  );
});

test('every RUNBOOK-*.md this repo ships is covered by the scan above', () => {
  // A hardcoded file list is exactly the kind of thing that silently stops
  // covering what it once did -- this proves the list still matches the
  // tree rather than trusting it forever.
  const found = [];
  function walk(dir) {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      const full = path.join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
      } else if (/^RUNBOOK.*\.md$/.test(entry)) {
        found.push(path.relative(ROOT, full));
      }
    }
  }
  walk(ROOT);
  assert.deepEqual(found.sort(), [...RUNBOOK_PATHS].sort());
});

// Self-test: a scanner that has quietly stopped matching passes every file.
// Prove both halves of the distinction this test exists to draw -- a fenced
// command is caught, the same token in prose is not -- against synthetic
// input, not against today's tree, so a coincidental clean tree can't hide a
// broken scanner.
test('self-test: the scanner catches a fixed-host placeholder inside a fenced bash block', () => {
  const sample = [
    'Some prose that never mentions a fence.',
    '',
    '```bash',
    'JUMP="ssh -i ~/.ssh/id_ed25519_hetzner -W %h:%p root@<edge1-ipv4>"',
    '```',
  ].join('\n');
  const blocks = commandBlocks(sample);
  assert.equal(blocks.length, 1);
  const violations = findFixedHostPlaceholders(blocks[0].lines.join('\n'));
  assert.deepEqual(violations, ['<edge1-ipv4>']);
});

test('self-test: the scanner ignores the same placeholder mentioned in prose, outside a fence', () => {
  const sample = [
    '`<edge1-ipv4>` is edge1’s public address, from the Hetzner Cloud',
    'Console -- substitute it below.',
    '',
    '```bash',
    'echo "no placeholder in this command"',
    '```',
  ].join('\n');
  const blocks = commandBlocks(sample);
  assert.equal(blocks.length, 1);
  const violations = findFixedHostPlaceholders(blocks[0].lines.join('\n'));
  assert.deepEqual(violations, []);
});

// Self-test: a legitimate per-invocation placeholder (a tenant slug, here)
// must never be flagged -- proves the scan is scoped to fixed hosts, not to
// every bracketed token.
test('self-test: the scanner leaves a legitimate per-invocation placeholder alone', () => {
  const sample = [
    '```bash',
    'git clone https://github.com/branchLeft/ghost-tenant-<slug>.git',
    '```',
  ].join('\n');
  const blocks = commandBlocks(sample);
  const violations = findFixedHostPlaceholders(blocks[0].lines.join('\n'));
  assert.deepEqual(violations, []);
});

// Self-test: a `text`/`yaml` fence (illustrative output, not a command) must
// never be scanned, even if it happens to contain a matching token.
test('self-test: the scanner does not scan a non-command fence language', () => {
  const sample = ['```text', 'root@<edge1-ipv4>', '```'].join('\n');
  const blocks = commandBlocks(sample);
  assert.deepEqual(blocks, []);
});

// Self-test: a per-invocation credential id that merely names a fixed host
// -- db/RUNBOOK-db.md's `<db1 backup key id>` -- is not an address and must
// not be flagged.
test('self-test: the scanner leaves a non-address placeholder that merely names a fixed host alone', () => {
  const sample = [
    '```bash',
    "hcloud storage-box grant --workload-access-key '<db1 backup key id>'",
    '```',
  ].join('\n');
  const blocks = commandBlocks(sample);
  const violations = findFixedHostPlaceholders(blocks[0].lines.join('\n'));
  assert.deepEqual(violations, []);
});
