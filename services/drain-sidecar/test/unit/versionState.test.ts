import { describe, expect, it } from 'vitest';
import { deriveVersionState } from '../../src/versionState.js';

// The three cases per-tenant health and version reading has to get right.
describe('deriveVersionState() -- the three cases', () => {
  it('steady: undrained, reported equals intended -- matches', () => {
    const state = deriveVersionState({ intended: '6.55.0', rawReported: '6.55.0', drained: false });
    expect(state).toEqual({ intended: '6.55.0', reported: '6.55.0', matches: true });
  });

  it('overlap: drained (the retiring colour) still on the old version while intent has already moved -- not reported at all, not a mismatch', () => {
    // The retiring colour really is still on the old build and the
    // descriptor already intends the new one -- a real disagreement, and
    // the expected state during any overlap. `matches` must stay null,
    // not false: a false here is exactly the "pages on every successful
    // upgrade" trap the issue names.
    const state = deriveVersionState({ intended: '6.56.0', rawReported: '6.55.0', drained: true });
    expect(state).toEqual({ intended: '6.56.0', reported: null, matches: null });
  });

  it('reverted: undrained, but this (the serving) colour is still on the old version -- a real, reportable mismatch', () => {
    // The case the issue calls "worth building": a tenant reverted after a
    // failed bump is undrained -- it is serving readers -- and its version
    // genuinely disagrees with what the descriptor intends.
    const state = deriveVersionState({ intended: '6.56.0', rawReported: '6.55.0', drained: false });
    expect(state).toEqual({ intended: '6.56.0', reported: '6.55.0', matches: false });
  });
});

describe('deriveVersionState() -- other arms', () => {
  it('is unknown, not false, when nothing has told this process the intended version yet', () => {
    const state = deriveVersionState({ intended: null, rawReported: '6.55.0', drained: false });
    expect(state).toEqual({ intended: null, reported: '6.55.0', matches: null });
  });

  it('is unknown, not false, when the probe itself came back empty on the undrained colour', () => {
    const state = deriveVersionState({ intended: '6.55.0', rawReported: null, drained: false });
    expect(state).toEqual({ intended: '6.55.0', reported: null, matches: null });
  });

  it('never reports a version for a drained colour even when the caller has one to give it', () => {
    const state = deriveVersionState({ intended: '6.55.0', rawReported: '6.55.0', drained: true });
    expect(state.reported).toBeNull();
    expect(state.matches).toBeNull();
  });
});
