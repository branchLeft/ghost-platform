import { describe, expect, it } from 'vitest';
import { BundleReadError, BundleRefusedError } from '../../src/bundleReader.js';
import {
  DestinationNotFreshError,
  ImportStepError,
  ImportVerificationError,
  runPromotionImport,
} from '../../src/promotionImport.js';
import {
  bundleTar,
  FakeTarget,
  SOURCE_TIERS,
  type BundleOptions,
  type FakeTargetOptions,
} from '../helpers/promotionBundle.js';

function run(options: { bundle?: BundleOptions; target?: FakeTargetOptions } = {}) {
  const target = new FakeTarget({ sourceTiers: SOURCE_TIERS, ...options.target });
  const archive = bundleTar(options.bundle);
  return {
    target,
    result: runPromotionImport({ openArchive: () => Promise.resolve(archive), target }),
  };
}

describe('runPromotionImport', () => {
  it('imports posts, pages and members into a fresh tenant and reports the counts before and after', async () => {
    const { target, result } = run();
    await expect(result).resolves.toEqual({
      before: { posts: 1, pages: 0, members: 0 },
      bundle: { posts: 4, pages: 2, members: 3 },
      after: { posts: 5, pages: 2, members: 3 },
      tierMembersVerified: 2,
    });
    expect(target.calls).toEqual([
      'count',
      'importContent',
      'importMembersCsv',
      'count',
      'listMembers',
    ]);
  });

  it('counts a tenant that already holds posts and pages by what the import added, not by the total', async () => {
    const { result } = run({ target: { initial: { posts: 7, pages: 3, members: 0 } } });
    await expect(result).resolves.toMatchObject({ after: { posts: 11, pages: 5, members: 3 } });
  });

  it('skips the tier read when no member is on a tier', async () => {
    const { target, result } = run({
      bundle: { members: [{ email: 'a@example.test' }, { email: 'b@example.test' }] },
    });
    await expect(result).resolves.toMatchObject({ tierMembersVerified: 0 });
    expect(target.calls).not.toContain('listMembers');
  });

  describe('control case: a broken import reports itself incomplete', () => {
    it('refuses when the content import silently drops the posts and pages', async () => {
      const { result } = run({ target: { dropContent: true } });
      const error = await result.catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ImportVerificationError);
      expect((error as ImportVerificationError).mismatches).toEqual([
        'posts: expected 5 after import, found 1',
        'pages: expected 2 after import, found 0',
      ]);
    });

    it('refuses when the members import silently drops the members', async () => {
      const { result } = run({ target: { dropMembers: true } });
      const error = await result.catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ImportVerificationError);
      expect((error as ImportVerificationError).mismatches).toEqual([
        'members: expected 3 after import, found 0',
      ]);
    });

    it('refuses, with the figures, when the destination ends up with more than it should', async () => {
      const { target, result } = run();
      const real = target.importContent.bind(target);
      target.importContent = async (bytes) => {
        await real(bytes);
        await real(bytes);
      };
      const error = (await result.catch((e: unknown) => e)) as ImportVerificationError;
      expect(error).toBeInstanceOf(ImportVerificationError);
      expect(error.before).toEqual({ posts: 1, pages: 0, members: 0 });
      expect(error.expected).toEqual({ posts: 5, pages: 2, members: 3 });
      expect(error.after).toEqual({ posts: 9, pages: 4, members: 3 });
    });

    it('names the step when Ghost refuses an import, and never reads past it', async () => {
      const { target, result } = run({ target: { failContent: true } });
      const error = (await result.catch((e: unknown) => e)) as ImportStepError;
      expect(error).toBeInstanceOf(ImportStepError);
      expect(error.step).toBe('import-content');
      expect(error.cause).toBeInstanceOf(Error);
      expect(target.calls).toEqual(['count', 'importContent']);
    });

    it('names the step when the destination cannot be counted', async () => {
      const { result } = run({ target: { failCount: true } });
      await expect(result).rejects.toMatchObject({ step: 'count-before' });
    });

    it('names the step when the member import or a later read throws', async () => {
      const target = new FakeTarget();
      target.importMembersCsv = () => Promise.reject('refused');
      const archive = bundleTar();
      await expect(
        runPromotionImport({ openArchive: () => Promise.resolve(archive), target })
      ).rejects.toMatchObject({ step: 'import-members' });
      const second = new FakeTarget({ sourceTiers: SOURCE_TIERS });
      const realCount = second.count.bind(second);
      let counts = 0;
      second.count = () => (++counts === 2 ? Promise.reject(new Error('down')) : realCount());
      await expect(
        runPromotionImport({ openArchive: () => Promise.resolve(archive), target: second })
      ).rejects.toMatchObject({ step: 'count-after' });
      const third = new FakeTarget({ sourceTiers: SOURCE_TIERS });
      third.listMembers = () => Promise.reject(new Error('down'));
      await expect(
        runPromotionImport({ openArchive: () => Promise.resolve(archive), target: third })
      ).rejects.toMatchObject({ step: 'list-members' });
    });
  });

  describe('member tiers', () => {
    it('refuses when members arrive without the tiers they were on, naming a count and no address', async () => {
      const { result } = run({ target: { loseTiers: true } });
      const error = (await result.catch((e: unknown) => e)) as ImportVerificationError;
      expect(error).toBeInstanceOf(ImportVerificationError);
      expect(error.mismatches).toEqual(['2 of 2 members on a tier are not on it after import']);
      expect(error.message).not.toContain('example.test');
    });

    it('refuses when only one of two tier members keeps the tier, and when a tier member is absent', async () => {
      const partial = run({
        target: { sourceTiers: { 'member-one@example.test': ['TIER_SLUG_PAID'] } },
      });
      await expect(partial.result).rejects.toThrow(/1 of 2 members on a tier/);
      const wrongTier = run({
        target: { sourceTiers: { ...SOURCE_TIERS, 'member-one@example.test': ['OTHER'] } },
      });
      await expect(wrongTier.result).rejects.toThrow(/1 of 2 members on a tier/);
    });

    it('matches addresses case-insensitively', async () => {
      const { target, result } = run();
      target.listMembers = () =>
        Promise.resolve([
          { email: 'MEMBER-ONE@example.test', tierSlugs: ['TIER_SLUG_PAID'] },
          { email: 'Member-Three@example.test', tierSlugs: ['TIER_SLUG_PAID'] },
        ]);
      await expect(result).resolves.toMatchObject({ tierMembersVerified: 2 });
    });
  });

  describe('refuses before copying anything', () => {
    it('refuses a destination that already holds members, touching nothing', async () => {
      const { target, result } = run({ target: { initial: { posts: 1, pages: 0, members: 2 } } });
      await expect(result).rejects.toBeInstanceOf(DestinationNotFreshError);
      expect(target.calls).toEqual(['count']);
    });

    it('refuses a bundle that does not agree with itself, without counting the destination', async () => {
      const { target, result } = run({ bundle: { manifestMembers: { status: 'partial' } } });
      await expect(result).rejects.toBeInstanceOf(BundleRefusedError);
      expect(target.calls).toEqual([]);
    });

    it('refuses an archive that is not a tar, without counting the destination', async () => {
      const target = new FakeTarget();
      await expect(
        runPromotionImport({ openArchive: () => Promise.resolve(Buffer.from('nope')), target })
      ).rejects.toBeInstanceOf(BundleReadError);
      expect(target.calls).toEqual([]);
    });
  });
});
