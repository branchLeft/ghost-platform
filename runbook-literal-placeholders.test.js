// A committed runbook must not carry either half of the same defect: an
// unsubstituted placeholder in a copy-pasteable command, or a concrete
// operational value (a fixed host's address) committed as a literal.
// See runbook-literal-placeholders.test.md#placeholder-and-literal-checks.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

const RUNBOOK_PATHS = [
  'RUNBOOK-bucket-fencing.md',
  'RUNBOOK-media-backup-lifecycle.md',
  'RUNBOOK-tenant-onboarding.md',
  'db/RUNBOOK-db.md',
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

// The Teardown section must stop the tenant's containers before removing
// its directory or volumes, since the unit that starts them carries no
// ExecStop. See runbook-literal-placeholders.test.md#teardown-ordering-check.
const TEARDOWN_HEADING_RE = /^##\s+Teardown\s*$/m;
const NEXT_HEADING_RE = /^##\s+\S/m;
// The one correct stop step: `docker ps -q --filter
// label=com.docker.compose.project=<slug>` piped into `xargs -r docker
// stop` -- plain `docker`, so it never touches the Compose file at all.
const LABEL_FILTERED_STOP_RE =
  /docker\s+ps\s+-a?q\b.*--filter\s+label=com\.docker\.compose\.project=<slug>.*\|\s*xargs\s+-r\s+docker\s+stop\b/;
// The regression this check exists to catch: an ad-hoc `docker compose ...
// down` re-interpolates the whole Compose file over a bare SSH session,
// which carries none of the secrets systemd's EnvironmentFile= supplies --
// it fails before it ever reaches the Docker daemon, on every real tenant.
const COMPOSE_DOWN_RE = /docker compose\b.*\bdown\b/;
const RM_TENANT_DIR_RE = /rm\s+-rf\s+\/opt\/branchleft\/<slug>/;
const VOLUME_RM_RE = /docker volume rm\b/;
// The tenant's two content volumes are declared `external: true`
// (infra/tenant/compose.ts), so Compose never labels them -- a label filter
// against them always prints nothing, whether they are gone or still there.
// This is the regression a second review round found in the verification
// this PR added: it must be rejected outright, same treatment as the
// `docker compose ... down` regression above.
const VOLUME_LABEL_FILTER_RE =
  /docker\s+volume\s+ls\b[^\n]*--filter\s+label=com\.docker\.compose\.project=<slug>/;
// The correct form: `docker volume ls` filtered by the volumes' own exact
// names -- the same two names the removal line (`docker volume rm ...`)
// above already uses -- rather than by a label they never carry.
const VOLUME_NAME_CHECK_RE =
  /docker\s+volume\s+ls\b(?=[^\n]*name=\^ghost-<slug>-content\$)(?=[^\n]*name=\^ghost-<slug>-adapters\$)/;

/**
 * The `## Teardown` section's text, from its heading up to (but not
 * including) the next `## ` heading or end of file. Throws if the file has
 * no such heading, so a renamed section fails loudly rather than silently
 * emptying the check below.
 */
function teardownSectionText(fullText) {
  const start = fullText.search(TEARDOWN_HEADING_RE);
  assert.notEqual(start, -1, 'no "## Teardown" heading found');
  const afterHeading = fullText.slice(start + fullText.slice(start).indexOf('\n') + 1);
  const nextHeadingOffset = afterHeading.search(NEXT_HEADING_RE);
  return nextHeadingOffset === -1 ? afterHeading : afterHeading.slice(0, nextHeadingOffset);
}

/**
 * Violations of the teardown order above, found in `sectionText`'s fenced
 * bash/sql blocks. Order is judged across the whole section, concatenating
 * every command block's lines in document order -- a stop step in one
 * fenced block still has to precede a removal step in a later one. A
 * `docker compose ... down` is a violation outright, regardless of where it
 * sits, because it cannot succeed against a real tenant stack at all.
 */
function teardownOrderViolations(sectionText) {
  // Comment lines (explanatory prose, including the one right beside step 2
  // that names the banned form to explain why it's banned) are not commands
  // and must not trip either detector.
  const lines = commandBlocks(sectionText)
    .flatMap((b) => b.lines)
    .filter((l) => !/^\s*#/.test(l));
  const stopIdx = lines.findIndex((l) => LABEL_FILTERED_STOP_RE.test(l));
  const composeDownIdx = lines.findIndex((l) => COMPOSE_DOWN_RE.test(l));
  const rmTenantDirIdx = lines.findIndex((l) => RM_TENANT_DIR_RE.test(l));
  const volumeRmIdx = lines.findIndex((l) => VOLUME_RM_RE.test(l));
  const violations = [];
  if (composeDownIdx !== -1) {
    violations.push(
      '`docker compose ... down` re-interpolates the Compose file and fails against ' +
        'every real tenant stack -- use the label-filtered `docker stop` pattern instead'
    );
  }
  if (stopIdx === -1) {
    violations.push('no label-filtered `docker stop` command in the Teardown section');
  }
  if (rmTenantDirIdx !== -1 && stopIdx !== -1 && stopIdx > rmTenantDirIdx) {
    violations.push(
      'the label-filtered `docker stop` must come before `rm -rf /opt/branchleft/<slug>`'
    );
  }
  if (volumeRmIdx !== -1 && stopIdx !== -1 && stopIdx > volumeRmIdx) {
    violations.push(
      'the label-filtered `docker stop` must come before `docker volume rm` ' +
        '(the containers holding the volumes must be stopped first)'
    );
  }
  if (lines.some((l) => VOLUME_LABEL_FILTER_RE.test(l))) {
    violations.push(
      "a post-removal volume check must not filter by label -- the tenant's " +
        'volumes are `external: true` and Compose never labels them, so the ' +
        'check would print "all clear" whether or not they were actually removed; ' +
        "filter by the volumes' exact name instead"
    );
  }
  if (!lines.some((l) => VOLUME_NAME_CHECK_RE.test(l))) {
    violations.push('no name-filtered check for both tenant volumes in the Teardown section');
  }
  return violations;
}

test('RUNBOOK-tenant-onboarding.md stops the containers before removing the tenant directory or its volumes', () => {
  const text = readFileSync(path.join(ROOT, 'RUNBOOK-tenant-onboarding.md'), 'utf8');
  const violations = teardownOrderViolations(teardownSectionText(text));
  assert.deepEqual(violations, [], violations.join('\n'));
});

test('self-test: the teardown-order check rejects a docker compose ... down even in the right position', () => {
  // This is the exact regression the check exists to catch: correctly
  // ordered, but the command itself cannot succeed against a real tenant.
  const sample = [
    '```bash',
    'docker compose -p <slug> -f /opt/branchleft/<slug>/compose.yml down',
    '```',
    '',
    '```bash',
    'rm -rf /opt/branchleft/<slug>',
    'docker volume rm ghost-<slug>-content ghost-<slug>-adapters',
    '```',
  ].join('\n');
  const violations = teardownOrderViolations(sample);
  assert.ok(
    violations.some((v) => v.includes('docker compose ... down')),
    'expected the compose-down regression to be flagged'
  );
});

test('self-test: the teardown-order check flags a stop step placed after the removals', () => {
  const sample = [
    '```bash',
    'rm -rf /opt/branchleft/<slug>',
    'docker volume rm ghost-<slug>-content ghost-<slug>-adapters',
    'docker ps -q --filter label=com.docker.compose.project=<slug> | xargs -r docker stop',
    '```',
  ].join('\n');
  const violations = teardownOrderViolations(sample);
  assert.ok(violations.length > 0, 'expected the reordered sample to be flagged');
});

test('self-test: the teardown-order check flags a missing stop step', () => {
  const sample = [
    '```bash',
    'rm -rf /opt/branchleft/<slug>',
    'docker volume rm ghost-<slug>-content ghost-<slug>-adapters',
    '```',
  ].join('\n');
  const violations = teardownOrderViolations(sample);
  assert.ok(violations.length > 0, 'expected the missing-stop-step sample to be flagged');
});

test('self-test: the teardown-order check rejects a label-filtered volume check', () => {
  // The regression a second review round found: the tenant's volumes are
  // `external: true`, so Compose never labels them -- a label filter here
  // always prints "all clear", whether or not the volumes are actually gone.
  const sample = [
    '```bash',
    'docker ps -q --filter label=com.docker.compose.project=<slug> | xargs -r docker stop',
    'rm -rf /opt/branchleft/<slug>',
    'docker volume rm ghost-<slug>-content ghost-<slug>-adapters',
    'docker volume ls -q --filter label=com.docker.compose.project=<slug>',
    '```',
  ].join('\n');
  const violations = teardownOrderViolations(sample);
  assert.ok(
    violations.some((v) => v.includes('must not filter by label')),
    'expected the label-filtered volume check to be flagged'
  );
});

test('self-test: the teardown-order check flags a missing name-filtered volume check', () => {
  const sample = [
    '```bash',
    'docker ps -q --filter label=com.docker.compose.project=<slug> | xargs -r docker stop',
    'rm -rf /opt/branchleft/<slug>',
    'docker volume rm ghost-<slug>-content ghost-<slug>-adapters',
    '```',
  ].join('\n');
  const violations = teardownOrderViolations(sample);
  assert.ok(
    violations.some((v) => v.includes('no name-filtered check')),
    'expected the missing volume-name check to be flagged'
  );
});

test('self-test: the teardown-order check ignores a banned command only mentioned in a comment', () => {
  // The runbook's own step-2 comment names the banned form to explain why
  // it's banned -- that explanatory line must not itself be read as the
  // command.
  const sample = [
    '```bash',
    '# Not `docker compose -p <slug> -f .../compose.yml down`: see below.',
    'docker ps -q --filter label=com.docker.compose.project=<slug> | xargs -r docker stop',
    'rm -rf /opt/branchleft/<slug>',
    'docker volume rm ghost-<slug>-content ghost-<slug>-adapters',
    'docker volume ls -q --filter "name=^ghost-<slug>-content$" --filter "name=^ghost-<slug>-adapters$"',
    '```',
  ].join('\n');
  assert.deepEqual(teardownOrderViolations(sample), []);
});

test('self-test: the teardown-order check passes the correct order, even split across blocks', () => {
  const sample = [
    '```bash',
    'docker ps -q --filter label=com.docker.compose.project=<slug> | xargs -r docker stop',
    'docker ps -aq --filter label=com.docker.compose.project=<slug> | xargs -r docker rm',
    '```',
    '',
    'some prose in between',
    '',
    '```bash',
    'rm -rf /opt/branchleft/<slug>',
    'docker volume rm ghost-<slug>-content ghost-<slug>-adapters',
    'docker volume ls -q --filter "name=^ghost-<slug>-content$" --filter "name=^ghost-<slug>-adapters$"',
    '```',
  ].join('\n');
  assert.deepEqual(teardownOrderViolations(sample), []);
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
