import { describe, expect, it, vi } from 'vitest';
import { GitDiffProvider } from '../../src/diff/git-diff.provider';
import { RefType, Status, type Change, type Repository } from '../../src/git';
import { reviewKey, type ChangedFile } from '../../src/diff/diff.model';

const committedChange = change('/workspace/src/shared.ts', Status.INDEX_MODIFIED);
const workingChange = change('/workspace/src/shared.ts', Status.UNTRACKED);

describe('GitDiffProvider comparisons', () => {
  it('keeps committed branch changes separate from current changes', async () => {
    const diffBetween = vi.fn(async (_base: string, _target: string, file?: string) =>
      file ? '@@ -1 +1 @@\n-old\n+new' : [committedChange],
    );
    const repo = {
      rootUri: { fsPath: '/workspace' },
      state: {
        HEAD: { name: 'feature', upstream: { remote: 'origin', name: 'origin/feature' } },
        remotes: [{ name: 'origin' }],
        indexChanges: [],
        workingTreeChanges: [],
        untrackedChanges: [workingChange],
        mergeChanges: [],
        onDidChange: vi.fn(),
      },
      getBranchBase: vi.fn(async () => ({ name: 'origin/feature' })),
      getBranches: vi.fn(async ({ remote }: { remote?: boolean }) =>
        remote ? [{ name: 'origin/main' }] : [{ name: 'feature' }, { name: 'main' }],
      ),
      getMergeBase: vi.fn(async () => 'base-sha'),
      diffBetween,
      diffWithHEAD: vi.fn(async () => ''),
      getCommit: vi.fn(async (ref: string) => ({ hash: `${ref}-sha` })),
      show: vi.fn(async () => 'new'),
    } as unknown as Repository;

    const provider = new GitDiffProvider(repo);
    const files = await provider.getChangedFiles();

    expect(files.map(file => [file.relativePath, file.source?.label])).toEqual([
      ['src/shared.ts', 'Committed on this branch'],
      ['src/shared.ts', 'Current changes'],
    ]);
    expect(reviewKey(files[0]!)).not.toBe(reviewKey(files[1]!));
    // The file on disk holds the current changes, so the committed one is not it.
    expect(files[0]!.targetMatchesDisk).toBeUndefined();
    expect(diffBetween).toHaveBeenCalledWith('base-sha', 'HEAD');

    diffBetween.mockClear();
    await provider.setComparison('release...feature');
    await provider.getChangedFiles();
    expect(provider.getSources()[0]!.description).toBe('release...feature');
    expect(diffBetween).toHaveBeenCalledWith('base-sha', 'feature');
  });
});

describe('GitDiffProvider custom comparisons', () => {
  it('follows the target branch on every refresh while keeping its documents stable', async () => {
    let featureTip = 'tip-1';
    const repo = fakeRepo({
      getCommit: vi.fn(async (ref: string) => ({ hash: ref === 'feature' ? featureTip : `${ref}-sha` })),
      getMergeBase: vi.fn(async (_base: string, target: string) => `merge-base-of-${target}`),
    });
    const provider = new GitDiffProvider(repo);

    await provider.setComparison('main...feature');
    await provider.getChangedFiles();
    expect(repo.diffBetween).toHaveBeenLastCalledWith('merge-base-of-tip-1', 'feature');

    // A commit on `feature` moves the merge base it is compared from...
    featureTip = 'tip-2';
    await provider.getChangedFiles();
    expect(repo.diffBetween).toHaveBeenLastCalledWith('merge-base-of-tip-2', 'feature');
    // ...but the target stays the ref name, so open diff documents keep their annotations.
    expect(provider.getSources()[0]).toMatchObject({ id: 'compare:main...feature', targetRef: 'feature' });
  });

  it('drops the custom comparison when going back to the branch comparison', async () => {
    const repo = fakeRepo({ getBranches: vi.fn(async () => [{ name: 'feature' }]) });
    const provider = new GitDiffProvider(repo);
    await provider.setComparison('v1.0...v2.0');
    await provider.getChangedFiles();

    provider.useBranchComparison();
    vi.mocked(repo.diffBetween).mockClear();
    const files = await provider.getChangedFiles();

    // No base branch exists, so the section is empty rather than still showing v1.0...v2.0.
    expect(provider.getSources()[0]).toMatchObject({
      label: 'Committed on this branch',
      description: 'Choose a base for feature',
      baseRef: 'HEAD',
      targetRef: 'HEAD',
    });
    expect(repo.diffBetween).not.toHaveBeenCalled();
    expect(files.filter(file => file.source?.id !== 'working-tree')).toEqual([]);
  });

  it('shows an empty section instead of failing when a chosen ref disappears', async () => {
    let branchExists = true;
    const repo = fakeRepo({
      getCommit: vi.fn(async (ref: string) => {
        if (ref === 'gone' && !branchExists) throw new Error('unknown revision gone');
        return { hash: `${ref}-sha` };
      }),
    });
    const provider = new GitDiffProvider(repo);
    await provider.setComparison('main...gone');

    branchExists = false;
    const files = await provider.getChangedFiles();

    expect(provider.getSources()[0]!.description).toBe('Cannot resolve main...gone');
    expect(files.filter(file => file.source?.id !== 'working-tree')).toEqual([]);
  });

  it('rejects refs that cannot be resolved when the comparison is chosen', async () => {
    const repo = fakeRepo({
      getCommit: vi.fn(async (ref: string) => {
        if (ref === 'typo') throw new Error('unknown revision typo');
        return { hash: `${ref}-sha` };
      }),
    });
    const provider = new GitDiffProvider(repo);

    await expect(provider.setComparison('typo...feature')).rejects.toThrow('unknown revision typo');
    await provider.getChangedFiles();
    expect(provider.getComparison().mode).toBe('branch');
  });

  it('reports the refs behind the committed section for both modes', async () => {
    const provider = new GitDiffProvider(fakeRepo());

    await provider.getChangedFiles();
    expect(provider.getComparison()).toEqual({
      mode: 'branch', base: 'origin/main', target: 'feature', separator: '...',
    });

    await provider.setComparison('v1.0..feature');
    await provider.getChangedFiles();
    expect(provider.getComparison()).toEqual({
      mode: 'custom', base: 'v1.0', target: 'feature', separator: '..',
    });

    provider.useBranchComparison();
    await provider.getChangedFiles();
    expect(provider.getComparison().mode).toBe('branch');
  });

  it('lists refs most recently committed first, with the current branch on top', async () => {
    const repo = fakeRepo({
      getRefs: vi.fn(async () => [
        { type: RefType.Head, name: 'main' },
        { type: RefType.Head, name: 'feature' },
      ]),
    });
    const provider = new GitDiffProvider(repo);

    const refs = await provider.listRefs();

    expect(repo.getRefs).toHaveBeenCalledWith({ sort: 'committerdate' });
    expect(refs.map(ref => ref.name)).toEqual(['feature', 'main']);
  });
});

describe('GitDiffProvider committed files on disk', () => {
  const unchanged = change('/workspace/src/unchanged.ts', Status.MODIFIED);
  const edited = change('/workspace/src/edited.ts', Status.MODIFIED);
  const renamedAway = change('/workspace/src/renamed.ts', Status.MODIFIED);
  const removed = change('/workspace/src/removed.ts', Status.DELETED);
  const committed = [unchanged, edited, renamedAway, removed];

  function repoWithLocalChanges(): Repository {
    const repo = fakeRepo({ diffBetween: vi.fn(async () => committed) });
    Object.assign(repo.state, {
      workingTreeChanges: [change('/workspace/src/edited.ts', Status.MODIFIED)],
      indexChanges: [{
        uri: { fsPath: '/workspace/src/moved.ts' },
        originalUri: { fsPath: '/workspace/src/renamed.ts' },
        renameUri: undefined,
        status: Status.INDEX_RENAMED,
      }],
    });
    return repo;
  }

  function filesOnDisk(files: readonly ChangedFile[]): string[] {
    return files
      .filter(file => file.source?.id !== 'working-tree' && file.targetMatchesDisk)
      .map(file => file.relativePath);
  }

  it('opens branch changes as the real file when it has no local changes', async () => {
    const files = await new GitDiffProvider(repoWithLocalChanges()).getChangedFiles();

    expect(filesOnDisk(files)).toEqual(['src/unchanged.ts']);
  });

  it('opens a comparison against the checked-out branch as the real file', async () => {
    const provider = new GitDiffProvider(repoWithLocalChanges());

    await provider.setComparison('main...feature');
    expect(filesOnDisk(await provider.getChangedFiles())).toEqual(['src/unchanged.ts']);

    await provider.setComparison('main...release');
    expect(filesOnDisk(await provider.getChangedFiles())).toEqual([]);
  });
});

function fakeRepo(overrides: Partial<Record<keyof Repository, unknown>> = {}): Repository {
  return {
    rootUri: { fsPath: '/workspace' },
    state: {
      HEAD: { name: 'feature', upstream: { remote: 'origin', name: 'origin/feature' } },
      remotes: [{ name: 'origin' }],
      indexChanges: [],
      workingTreeChanges: [],
      untrackedChanges: [],
      mergeChanges: [],
      onDidChange: vi.fn(),
    },
    getBranchBase: vi.fn(async () => undefined),
    getBranches: vi.fn(async () => [{ name: 'feature' }, { name: 'origin/main' }]),
    getRefs: vi.fn(async () => []),
    getMergeBase: vi.fn(async () => 'base-sha'),
    diffBetween: vi.fn(async (_base: string, _target: string, file?: string) => file ? '' : [committedChange]),
    diffWithHEAD: vi.fn(async () => ''),
    getCommit: vi.fn(async (ref: string) => ({ hash: `${ref}-sha` })),
    show: vi.fn(async () => ''),
    ...overrides,
  } as unknown as Repository;
}

function change(fsPath: string, status: Status): Change {
  const uri = { fsPath } as Change['uri'];
  return { uri, originalUri: uri, renameUri: undefined, status };
}
