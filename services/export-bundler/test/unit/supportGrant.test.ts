import { describe, expect, it } from 'vitest';
import {
  assertIsSupportRole,
  assertNoSendInFlight,
  NewsletterSendInFlightError,
  NotTheSupportAccountError,
  assertSupportAccountActive,
  GHOST_ACTIVE_STATES,
  NoSupportGrantError,
  parseSupportGrant,
  SupportAccountNotActiveError,
} from '../../src/supportGrant.js';

describe('parseSupportGrant', () => {
  it.each([['consented'], ['incident']])('accepts the %s lane with a reference', (lane) => {
    expect(parseSupportGrant(lane, 'staff-log 2026-09-27T10:00Z')).toEqual({
      lane,
      reference: 'staff-log 2026-09-27T10:00Z',
    });
  });

  it.each([
    [undefined, 'ref'],
    ['', 'ref'],
    ['automated', 'ref'],
    ['Consented', 'ref'],
    ['consented', undefined],
    ['consented', ''],
    ['consented', ' leading-space'],
    ['consented', 'two\nlines'],
    ['consented', 'tab\there'],
    ['consented', 'x'.repeat(201)],
  ])('refuses lane %j with reference %j as NoSupportGrantError', (lane, reference) => {
    expect(() => parseSupportGrant(lane, reference)).toThrow(NoSupportGrantError);
  });

  it('says nothing was started', () => {
    expect(() => parseSupportGrant(undefined, undefined)).toThrow(/nothing was started/);
  });
});

describe('assertSupportAccountActive', () => {
  it.each(GHOST_ACTIVE_STATES.map((s) => [s]))("passes Ghost's active state %s", (status) => {
    expect(() => assertSupportAccountActive('support@x.test', status)).not.toThrow();
  });

  it.each([['inactive'], ['locked'], [''], ['ACTIVE'], ['something-new']])(
    'refuses the status %j',
    (status) => {
      let caught: unknown;
      try {
        assertSupportAccountActive('support@x.test', status);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(SupportAccountNotActiveError);
      expect((caught as SupportAccountNotActiveError).status).toBe(status);
      expect((caught as Error).message).toMatch(/never by this tool; nothing was started/);
    }
  );

  it('refuses an account that does not exist', () => {
    expect(() => assertSupportAccountActive('support@x.test', null)).toThrow(/does not exist/);
  });
});

describe('assertIsSupportRole', () => {
  it('passes an account holding exactly the Administrator role', () => {
    expect(() => assertIsSupportRole('support@x.test', ['Administrator'])).not.toThrow();
  });

  it.each([
    [['Owner']],
    [['Owner', 'Administrator']],
    [['Administrator', 'Owner']],
    [['Editor']],
    [['Author']],
    [['Contributor']],
    [['Super Editor']],
    [[]],
  ])('refuses the roles %j as NotTheSupportAccountError', (roles) => {
    let caught: unknown;
    try {
      assertIsSupportRole('owner@x.test', roles);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NotTheSupportAccountError);
    expect((caught as NotTheSupportAccountError).roles).toEqual(roles);
    expect((caught as Error).message).toMatch(/nothing was started/);
  });
});

describe('assertNoSendInFlight', () => {
  it('passes when no newsletter is mid-send', () => {
    expect(() => assertNoSendInFlight(0)).not.toThrow();
  });

  it.each([[1], [2], [40]])('refuses %i in-flight send(s) as NewsletterSendInFlightError', (n) => {
    let caught: unknown;
    try {
      assertNoSendInFlight(n);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NewsletterSendInFlightError);
    expect((caught as NewsletterSendInFlightError).count).toBe(n);
    expect((caught as Error).message).toMatch(/Nothing was started/);
  });
});
