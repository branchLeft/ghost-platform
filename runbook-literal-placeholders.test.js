// A committed runbook must not carry either half of the same defect: an
// unsubstituted placeholder in a copy-pasteable command, or a concrete
// operational value (a fixed host's address) committed as a literal. Both
// break the runbook the same way for a reader who pastes the command as
// written -- one form cannot resolve at all, the other silently drifts once
// the value it copied stops being current. The fix in both directions is
// threading the value through a shell variable a lookup command populates,
// never a hardcoded string and never an unresolved placeholder.
//
// Two checks, not three, over the same fenced blocks:
//
// - `addressPlaceholders` matches any unresolved, address-shaped placeholder
//   token anywhere in a command fence -- an assignment's whole value,
//   `export`ed, `local`, quoted, split across a line continuation, or an
//   argument inside a larger command. Hostname and position are not the
//   property that makes one of these wrong: it reads as an address (its
//   trailing word is ip/ipv4/address/addr) and nothing has substituted it,
//   independent of which host it names, whether it names one at all, or
//   where in the line it sits. A host-name scope and an assignment-shaped
//   scope were both tried and each left a gap the other didn't cover.
// - `fixedHostLiterals` is a genuinely different property and stays
//   separate: it matches only the bare, exact literal value of a specific,
//   known fixed host, never a `/32` or a CIDR, and never a threaded
//   `$VARIABLE` reference.
//
// Deliberately narrower than "no `<...>` anywhere in a fenced block" or "no
// IPv4-shaped token anywhere in a fenced block":
//
// - Only `bash` and `sql` fences count as command blocks in this repo's
//   runbooks -- `text`/`yaml`/`json` fences here hold illustrative sample
//   output, never something pasted and run.
// - The address word must be *trailing*, not merely present, so a
//   per-invocation credential id such as `<db1 backup key id>` is left
//   alone: it is not an address, and this scanner does not track resource
//   ids at all -- a resource looked up fresh by id (rather than hardcoded)
//   is a different, already-correct pattern this scanner has no opinion on.
// - A token that legitimately varies per invocation (`<slug>`, `<tenant>`,
//   `<digest>`, `<run-id>`, `<host>`) is not address-shaped and never
//   matches, whether it is an assignment's whole value or an argument
//   inside a larger command.
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

const COMMAND_FENCE_LANGS = new Set(['bash', 'sql']);
const FENCE_RE = /^```([a-zA-Z0-9_-]*)\s*$/;
const PLACEHOLDER_RE = /<[^<>\n]+>/g;
const ADDRESS_WORD_RE = /(?:^|[^a-z])(?:ip|ipv4|address|addr)$/i;
// Excludes the base address of a CIDR or a `/32` (the lookahead), so this is
// disjoint from anything shaped like a subnet or a single-host mask -- a
// verification block reading real `iptables -S` output renders one back
// that way, and it is not a connection target pasted into a command.
const BARE_IPV4_RE = /\b\d{1,3}(?:\.\d{1,3}){3}\b(?!\/)/g;

// The specific, known literal values a fenced command must not carry. A
// threaded `$VARIABLE` populated by a lookup holds no such literal and is
// never flagged, by construction.
const FIXED_HOST_LITERALS = {
  edge1: '46.225.95.167',
  db1: '10.20.1.20',
  'app1-private': '10.20.1.100',
};
const FIXED_HOST_LITERAL_VALUES = new Set(Object.values(FIXED_HOST_LITERALS));

/**
 * Split a runbook's text into fenced blocks, returning only those whose
 * language is a command language this repo's runbooks use. Malformed input
 * (an unterminated fence) is surfaced by leaving the last block open rather
 * than silently dropping it, so a truncated file cannot pass by accident.
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
  if (current !== null) {
    blocks.push(current);
  }
  return blocks.filter((b) => COMMAND_FENCE_LANGS.has(b.lang));
}

/**
 * Every unresolved, address-shaped placeholder token in `blockText`,
 * wherever it sits -- an assignment's entire value, `export`ed, `local`,
 * quoted, split across a line continuation, or an argument inside a larger
 * command. Hostname and position are not the property that makes one of
 * these wrong: it reads as an address (its trailing word is
 * ip/ipv4/address/addr) and nothing has substituted it.
 */
function addressPlaceholders(blockText) {
  const found = [];
  let match;
  PLACEHOLDER_RE.lastIndex = 0;
  while ((match = PLACEHOLDER_RE.exec(blockText)) !== null) {
    const token = match[0];
    const inner = token.slice(1, -1);
    if (ADDRESS_WORD_RE.test(inner)) {
      found.push(token);
    }
  }
  return found;
}

/**
 * Bare IPv4 literals in `blockText` equal to a specific, known address this
 * file pins in `FIXED_HOST_LITERALS` -- the anti-pattern the placeholder
 * check above exists to catch, committed instead of left unresolved.
 */
function fixedHostLiterals(blockText) {
  const found = [];
  let match;
  BARE_IPV4_RE.lastIndex = 0;
  while ((match = BARE_IPV4_RE.exec(blockText)) !== null) {
    if (FIXED_HOST_LITERAL_VALUES.has(match[0])) {
      found.push(match[0]);
    }
  }
  return found;
}

test('no RUNBOOK-*.md fenced command block contains an unresolved address placeholder or a committed fixed-host literal', () => {
  const violations = [];
  for (const relPath of RUNBOOK_PATHS) {
    const text = readFileSync(path.join(ROOT, relPath), 'utf8');
    for (const block of commandBlocks(text)) {
      const blockText = block.lines.join('\n');
      for (const token of addressPlaceholders(blockText)) {
        violations.push(`${relPath}: unresolved placeholder ${token}`);
      }
      for (const literal of fixedHostLiterals(blockText)) {
        violations.push(`${relPath}: committed literal address ${literal}`);
      }
    }
  }
  assert.deepEqual(
    violations,
    [],
    'found an unresolved address placeholder or a committed fixed-host literal ' +
      'in a fenced command block -- thread the value through a $VARIABLE ' +
      `populated by a lookup instead:\n${violations.join('\n')}`
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

// Self-tests: prove the scanner still draws the distinctions it exists for,
// against synthetic input rather than today's tree, so a coincidentally
// clean tree can't hide a scanner that quietly stopped matching.

test('self-test: the scanner catches a placeholder naming a fixed host', () => {
  const sample = [
    'Some prose that never mentions a fence.',
    '',
    '```bash',
    'JUMP="ssh -i ~/.ssh/id_ed25519_hetzner -W %h:%p root@<edge1-ipv4>"',
    '```',
  ].join('\n');
  const blocks = commandBlocks(sample);
  assert.equal(blocks.length, 1);
  assert.deepEqual(addressPlaceholders(blocks[0].lines.join('\n')), ['<edge1-ipv4>']);
});

test('self-test: the scanner catches an inline placeholder naming no host', () => {
  // <host-ipv4> is inline as an ssh target rather than an assignment's
  // whole value, and names no fixed host by name.
  const sample = ['```bash', 'ssh -i ~/.ssh/id_ed25519_hetzner root@<host-ipv4>', '```'].join('\n');
  const blocks = commandBlocks(sample);
  assert.deepEqual(addressPlaceholders(blocks[0].lines.join('\n')), ['<host-ipv4>']);
});

test('self-test: the scanner catches an export assignment', () => {
  const sample = ['```bash', "export HOST_IPV4=<this host's public address>", '```'].join('\n');
  const blocks = commandBlocks(sample);
  assert.deepEqual(addressPlaceholders(blocks[0].lines.join('\n')), [
    "<this host's public address>",
  ]);
});

test('self-test: the scanner catches a local assignment', () => {
  const sample = ['```bash', "local HOST_IPV4=<this host's public address>", '```'].join('\n');
  const blocks = commandBlocks(sample);
  assert.deepEqual(addressPlaceholders(blocks[0].lines.join('\n')), [
    "<this host's public address>",
  ]);
});

test('self-test: the scanner catches a quoted assignment', () => {
  // The apostrophe and spaces in the placeholder text are exactly what
  // would push an author to quote it.
  const sample = ['```bash', `HOST_IPV4="<this host's public address>"`, '```'].join('\n');
  const blocks = commandBlocks(sample);
  assert.deepEqual(addressPlaceholders(blocks[0].lines.join('\n')), [
    "<this host's public address>",
  ]);
});

test('self-test: the scanner catches a placeholder after a line continuation', () => {
  const sample = ['```bash', 'HOST_IPV4=\\', "  <this host's public address>", '```'].join('\n');
  const blocks = commandBlocks(sample);
  assert.deepEqual(addressPlaceholders(blocks[0].lines.join('\n')), [
    "<this host's public address>",
  ]);
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
  assert.deepEqual(addressPlaceholders(blocks[0].lines.join('\n')), []);
});

test('self-test: the scanner leaves a legitimate per-invocation placeholder alone', () => {
  const sample = [
    '```bash',
    'git clone https://github.com/branchLeft/ghost-tenant-<slug>.git',
    '```',
  ].join('\n');
  const blocks = commandBlocks(sample);
  assert.deepEqual(addressPlaceholders(blocks[0].lines.join('\n')), []);
});

test('self-test: the scanner leaves a bare per-invocation assignment alone', () => {
  // <host> is the entire value here, but it is not address-shaped -- must
  // not be confused with the HOST_IPV4 regression above.
  const sample = ['```bash', 'HOST=<host>', '```'].join('\n');
  const blocks = commandBlocks(sample);
  assert.deepEqual(addressPlaceholders(blocks[0].lines.join('\n')), []);
});

test('self-test: the scanner leaves a placeholder that is only part of the value alone', () => {
  const sample = ['```bash', 'KEY_FILE=~/.ssh/id_ed25519_slot_<stack>', '```'].join('\n');
  const blocks = commandBlocks(sample);
  assert.deepEqual(addressPlaceholders(blocks[0].lines.join('\n')), []);
});

test('self-test: the scanner leaves the corrected lookup form alone', () => {
  // The form this fix actually uses -- <host> is an argument to hcloud, not
  // the assignment's value, and is not itself an address. Must not
  // self-trip.
  const sample = [
    '```bash',
    'HOST_IPV4=$(hcloud server describe <host> -o json | python3 -c "import json, sys; ' +
      "print(json.load(sys.stdin)['public_net']['ipv4']['ip'])\")",
    '```',
  ].join('\n');
  const blocks = commandBlocks(sample);
  assert.deepEqual(addressPlaceholders(blocks[0].lines.join('\n')), []);
});

test('self-test: the scanner does not scan a non-command fence language', () => {
  const sample = ['```text', 'root@<edge1-ipv4>', '```'].join('\n');
  assert.deepEqual(commandBlocks(sample), []);
});

test('self-test: the scanner leaves a non-address placeholder that merely names a fixed host alone', () => {
  const sample = [
    '```bash',
    "hcloud storage-box grant --workload-access-key '<db1 backup key id>'",
    '```',
  ].join('\n');
  const blocks = commandBlocks(sample);
  assert.deepEqual(addressPlaceholders(blocks[0].lines.join('\n')), []);
});

test('self-test: the scanner leaves a resource-id placeholder alone', () => {
  // A Hetzner resource id, looked up fresh so a destructive delete never
  // runs against a guess -- ends in "-id", not an address word.
  const sample = ['```bash', 'hcloud primary-ip delete <edge1-ipv4-id>', '```'].join('\n');
  const blocks = commandBlocks(sample);
  assert.deepEqual(addressPlaceholders(blocks[0].lines.join('\n')), []);
});

test('self-test: the scanner leaves a CIDR placeholder alone', () => {
  const sample = ['```bash', 'ip route add <subnet-cidr> via <gateway>', '```'].join('\n');
  const blocks = commandBlocks(sample);
  assert.deepEqual(addressPlaceholders(blocks[0].lines.join('\n')), []);
});

test('self-test: the scanner catches a fixed-host literal in a bash fence', () => {
  const sample = [
    '```bash',
    'JUMP="ssh -i ~/.ssh/id_ed25519_hetzner -W %h:%p root@46.225.95.167"',
    '```',
  ].join('\n');
  const blocks = commandBlocks(sample);
  assert.equal(blocks.length, 1);
  assert.deepEqual(fixedHostLiterals(blocks[0].lines.join('\n')), ['46.225.95.167']);
});

test('self-test: the scanner ignores the same literal mentioned in prose', () => {
  const sample = [
    '`edge1` is reachable at `46.225.95.167`.',
    '',
    '```bash',
    'echo "no literal in this command"',
    '```',
  ].join('\n');
  const blocks = commandBlocks(sample);
  assert.equal(blocks.length, 1);
  assert.deepEqual(fixedHostLiterals(blocks[0].lines.join('\n')), []);
});

test('self-test: the scanner ignores a threaded variable for the same host', () => {
  const sample = [
    '```bash',
    'EDGE1_IPV4=$(hcloud server describe edge1 -o json | python3 -c "import json, sys; ' +
      "print(json.load(sys.stdin)['public_net']['ipv4']['ip'])\")",
    'JUMP="ssh -i ~/.ssh/id_ed25519_hetzner -W %h:%p root@$EDGE1_IPV4"',
    '```',
  ].join('\n');
  const blocks = commandBlocks(sample);
  assert.deepEqual(fixedHostLiterals(blocks[0].lines.join('\n')), []);
});

test('self-test: the scanner leaves an unlisted host real address alone', () => {
  // A scratch host's real, current address -- not a fixed host this
  // scanner tracks, and genuinely a different literal from any of the
  // three it does.
  const sample = ['```bash', "ssh -i ~/.ssh/id_ed25519_hetzner root@192.0.2.10 'true'", '```'].join(
    '\n'
  );
  const blocks = commandBlocks(sample);
  assert.deepEqual(fixedHostLiterals(blocks[0].lines.join('\n')), []);
});

test('self-test: the scanner leaves the verification slash-32 form alone', () => {
  // iptables -S renders an unmasked -d <addr> back with a /32 -- a
  // verification block reading real remote state, not a connection target
  // pasted into the command.
  const sample = [
    '```bash',
    'iptables -t filter -S DOCKER-USER | grep -- "-d 10.20.1.20/32 -j ACCEPT"',
    '```',
  ].join('\n');
  const blocks = commandBlocks(sample);
  assert.deepEqual(fixedHostLiterals(blocks[0].lines.join('\n')), []);
});
