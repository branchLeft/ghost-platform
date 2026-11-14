import { describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../../src/cli.js';
import type { DomainLookup } from '../../src/checkList.js';

// Fabricated fixtures only: reserved domains (example.com, example.org, .test).
const MEMBERS: Array<[string, string]> = [
  ['Ada Lovelace', 'ada@example.com'],
  ['Grace Hopper', 'Grace.Hopper@example.com'],
  ['Broken Row', 'not-an-address'],
  ['Nobody Here', 'nobody@nodomain.test'],
  ['Slow Lookup', 'slow@timeout.test'],
  ['Alan Turing', 'alan@example.org'],
];
const SUPPRESSION: string[] = ['grace.hopper@EXAMPLE.com'];
const FIXTURE_ADDRESSES = [...MEMBERS.map(([, address]) => address), ...SUPPRESSION];

const DOMAINS: Record<string, DomainLookup> = {
  'example.com': 'deliverable',
  'example.org': 'deliverable',
  'nodomain.test': 'undeliverable',
};

function fakeIo(files: Record<string, string>) {
  const written: Record<string, string> = {};
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CliIo = {
    readText: async (path) => files[path],
    writeText: async (path, text) => {
      written[path] = text;
    },
    lookupDomain: async (domain) => {
      if (domain === 'timeout.test') {
        throw new Error('ETIMEOUT');
      }
      return DOMAINS[domain] ?? 'undeliverable';
    },
    now: () => new Date('2026-11-11T12:00:00Z'),
    out: (line) => {
      stdout.push(line);
    },
    err: (line) => {
      stderr.push(line);
    },
  };
  return { io, written, stdout, stderr };
}

function standardFiles(consent: string | undefined): Record<string, string> {
  const list =
    ['name,email', ...MEMBERS.map(([name, address]) => `${name},${address}`)].join('\n') + '\n';
  const suppression = ['email', ...SUPPRESSION].join('\n') + '\n';
  const files: Record<string, string> = {
    '/in/list.csv': list,
    '/in/suppression.csv': suppression,
  };
  if (consent !== undefined) {
    files['/in/consent.json'] = consent;
  }
  return files;
}

const CHECK_ARGS = [
  'check',
  '--in',
  '/in/list.csv',
  '--suppression',
  '/in/suppression.csv',
  '--consent',
  '/in/consent.json',
  '--out',
  '/out/clean.csv',
  '--report',
  '/out/report.json',
];
const VALID_CONSENT = JSON.stringify({
  where: 'Sign-up form on the demo site',
  when: '2026-10-01',
});

describe('import-hygiene check', () => {
  it('writes the clean list with only the kept rows and keeps the original columns', async () => {
    const { io, written } = fakeIo(standardFiles(VALID_CONSENT));
    expect(await runCli(CHECK_ARGS, io)).toBe(0);
    expect(written['/out/clean.csv']).toBe(
      [
        'name,email',
        'Ada Lovelace,ada@example.com',
        'Slow Lookup,slow@timeout.test',
        'Alan Turing,alan@example.org',
        '',
      ].join('\n')
    );
  });

  it('writes a report of counts, reasons and row numbers', async () => {
    const { io, written } = fakeIo(standardFiles(VALID_CONSENT));
    await runCli(CHECK_ARGS, io);
    const report = JSON.parse(written['/out/report.json'] ?? '{}');
    expect(report.rowsIn).toBe(6);
    expect(report.kept).toBe(3);
    expect(report.dropped.syntax).toEqual({ count: 1, rows: [3] });
    expect(report.dropped.suppressed).toEqual({ count: 1, rows: [2] });
    expect(report.dropped['no-mx-or-address']).toEqual({ count: 1, rows: [4] });
    expect(report.unknownLookup).toEqual({ count: 1, rows: [5] });
  });

  it('records a re-confirmation need when the consent record is absent', async () => {
    const { io, written } = fakeIo(standardFiles(undefined));
    expect(await runCli(CHECK_ARGS, io)).toBe(0);
    const report = JSON.parse(written['/out/report.json'] ?? '{}');
    expect(report.consent).toEqual({ needsReconfirmation: true, problem: 'absent' });
  });

  it('records a re-confirmation need when the consent file is not JSON', async () => {
    const { io, written } = fakeIo(standardFiles('{not json'));
    await runCli(CHECK_ARGS, io);
    const report = JSON.parse(written['/out/report.json'] ?? '{}');
    expect(report.consent).toEqual({ needsReconfirmation: true, problem: 'invalid-shape' });
  });

  it('keeps the consent free text out of the report', async () => {
    const { io, written } = fakeIo(standardFiles(VALID_CONSENT));
    await runCli(CHECK_ARGS, io);
    expect(written['/out/report.json']).not.toContain('Sign-up form');
  });

  it('refuses a missing suppression list rather than passing suppressed addresses silently', async () => {
    const files = standardFiles(VALID_CONSENT);
    delete files['/in/suppression.csv'];
    const { io, stderr } = fakeIo(files);
    expect(await runCli(CHECK_ARGS, io)).toBe(1);
    expect(stderr.length).toBeGreaterThan(0);
  });

  it('refuses a list with no email column', async () => {
    const files = standardFiles(VALID_CONSENT);
    files['/in/list.csv'] = 'name,mail\nAda,ada@example.com\n';
    const { io, stderr } = fakeIo(files);
    expect(await runCli(CHECK_ARGS, io)).toBe(1);
    expect(stderr.join('\n')).toContain('email');
  });

  it('refuses a missing flag with a usage line', async () => {
    const { io, stderr } = fakeIo(standardFiles(VALID_CONSENT));
    expect(await runCli(['check', '--in', '/in/list.csv'], io)).toBe(2);
    expect(stderr.join('\n')).toContain('usage: import-hygiene check');
  });

  it('refuses an unknown command', async () => {
    const { io } = fakeIo(standardFiles(VALID_CONSENT));
    expect(await runCli(['send', ...CHECK_ARGS.slice(1)], io)).toBe(2);
  });

  // Privacy: every string a run produces (stdout, stderr and the report) must be
  // free of every fixture address. The clean list is the one output that is
  // supposed to hold addresses, so it is excluded from the scan.
  it('never prints or reports an address in any output of a run', async () => {
    const { io, written, stdout, stderr } = fakeIo(standardFiles(VALID_CONSENT));
    await runCli(CHECK_ARGS, io);
    const scanned = [...stdout, ...stderr, written['/out/report.json'] ?? '']
      .join('\n')
      .toLowerCase();
    for (const address of FIXTURE_ADDRESSES) {
      expect(scanned).not.toContain(address.toLowerCase());
    }
  });

  it('prints a counts-only summary line', async () => {
    const { io, stdout } = fakeIo(standardFiles(VALID_CONSENT));
    await runCli(CHECK_ARGS, io);
    expect(stdout.join('\n')).toBe('rows in 6, kept 3, dropped 3, unknown lookup 1');
  });
});
