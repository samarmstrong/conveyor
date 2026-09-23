import { describe, expect, it } from 'vitest';
import {
  ENV_AGENT_MARK,
  workerSkipReason,
  environmentChangedAt,
  filedIssueBody,
  parseEnvReport,
  recentVerdicts,
  skipReason,
  unreadFactoryPrs,
  withOpenedThisTick,
  type FactoryPr,
  type UnreadPrs,
} from '../src/environment.ts';

const pr = (n: number) => `https://github.com/o/r/pull/${n}`;
const unread = (fresh: string[] = [], stale: string[] = []): UnreadPrs => ({ fresh, stale });

/** A factory PR as GitHub reports it: when it opened, and what has been said on it. */
function factoryPr(n: number, createdAt = '2026-01-02T00:00:00Z', comments: string[] = []): FactoryPr {
  return {
    url: pr(n),
    createdAt,
    comments: comments.map((body, i) => ({ body, url: `${pr(n)}#issuecomment-${i + 1}` })),
  };
}

const verdict = `🏭 ${ENV_AGENT_MARK} It read this PR and opened none.`;
const humanComment = 'LGTM, one nit inline.';

describe('environmentChangedAt', () => {
  it('is null before any environment PR has merged', () => {
    expect(environmentChangedAt([])).toBeNull();
    expect(environmentChangedAt([{ mergedAt: null }])).toBeNull();
  });

  it('takes the latest merge, whatever order GitHub lists them in', () => {
    const older = { mergedAt: '2026-03-01T00:00:00Z' };
    const newer = { mergedAt: '2026-05-01T00:00:00Z' };
    expect(environmentChangedAt([newer, older])).toBe('2026-05-01T00:00:00Z');
    expect(environmentChangedAt([older, newer])).toBe('2026-05-01T00:00:00Z');
  });

  it('ignores an environment PR that was closed unmerged', () => {
    const merged = { mergedAt: '2026-03-01T00:00:00Z' };
    const rejected = { mergedAt: null };
    expect(environmentChangedAt([merged, rejected])).toBe('2026-03-01T00:00:00Z');
  });
});

describe('unreadFactoryPrs', () => {
  it('returns the PRs the agent has not commented on, newest first', () => {
    const prs = [factoryPr(11, '2026-01-01T00:00:00Z'), factoryPr(12, '2026-01-03T00:00:00Z')];
    expect(unreadFactoryPrs(prs, null)).toEqual(unread([pr(12), pr(11)]));
  });

  it('treats the environment agent\'s comment as the read mark', () => {
    const prs = [factoryPr(11), factoryPr(12, '2026-01-03T00:00:00Z', [verdict]), factoryPr(13, '2026-01-04T00:00:00Z', [verdict])];
    expect(unreadFactoryPrs(prs, null).fresh).toEqual([pr(11)]);
  });

  it('does not mistake a human comment, or another factory comment, for the mark', () => {
    const prs = [factoryPr(11, '2026-01-02T00:00:00Z', [humanComment, '🏭 **Factory attempt.** Closed unmerged.'])];
    expect(unreadFactoryPrs(prs, null).fresh).toEqual([pr(11)]);
  });

  it('finds the mark among other comments', () => {
    const prs = [factoryPr(11, '2026-01-02T00:00:00Z', [humanComment, verdict, humanComment])];
    expect(unreadFactoryPrs(prs, null)).toEqual(unread());
  });

  it('re-offers a PR whose pass failed before commenting', () => {
    // A failed pass posts nothing, so nothing marks the PR as read.
    expect(unreadFactoryPrs([factoryPr(11)], null).fresh).toEqual([pr(11)]);
  });

  it('calls a report stale when its PR opened before the environment changed', () => {
    // PR 781's story: the reports were all written on the pre-Docker machine.
    const prs = [factoryPr(765, '2026-08-31T18:48:00Z'), factoryPr(782, '2026-09-01T18:56:00Z')];
    expect(unreadFactoryPrs(prs, '2026-09-01T19:35:51Z')).toEqual(unread([], [pr(782), pr(765)]));
  });

  it('keeps a report from a PR opened after the change', () => {
    const prs = [factoryPr(782, '2026-09-01T18:56:00Z'), factoryPr(790, '2026-09-01T20:00:00Z')];
    expect(unreadFactoryPrs(prs, '2026-09-01T19:35:51Z')).toEqual(unread([pr(790)], [pr(782)]));
  });

  it('treats everything as fresh when no environment PR has ever merged', () => {
    expect(unreadFactoryPrs([factoryPr(765, '2020-01-01T00:00:00Z')], null).fresh).toEqual([pr(765)]);
  });

  it('does not depend on the order GitHub returns PRs in', () => {
    const prs = [factoryPr(12, '2026-01-03T00:00:00Z'), factoryPr(11, '2026-01-01T00:00:00Z'), factoryPr(13, '2026-01-05T00:00:00Z')];
    expect(unreadFactoryPrs(prs, null).fresh).toEqual([pr(13), pr(12), pr(11)]);
  });
});

describe('recentVerdicts', () => {
  it('links the agent\'s comments, newest PR first, up to the limit', () => {
    const prs = [
      factoryPr(11, '2026-01-01T00:00:00Z', [verdict]),
      factoryPr(12, '2026-01-02T00:00:00Z', [humanComment]),
      factoryPr(13, '2026-01-03T00:00:00Z', [humanComment, verdict]),
      factoryPr(14, '2026-01-04T00:00:00Z'),
    ];
    expect(recentVerdicts(prs, 5)).toEqual([`${pr(13)}#issuecomment-2`, `${pr(11)}#issuecomment-1`]);
    expect(recentVerdicts(prs, 1)).toEqual([`${pr(13)}#issuecomment-2`]);
  });

  it('keeps one verdict per PR when a pass was repeated on it', () => {
    const prs = [factoryPr(11, '2026-01-01T00:00:00Z', [verdict, humanComment, verdict])];
    expect(recentVerdicts(prs, 5)).toEqual([`${pr(11)}#issuecomment-3`]);
  });

  it('is empty before the agent has ever spoken', () => {
    expect(recentVerdicts([factoryPr(11), factoryPr(12, '2026-01-03T00:00:00Z', [humanComment])], 5)).toEqual([]);
  });
});

describe('skipReason', () => {
  it('runs when enabled, nothing is open, and there is a fresh report', () => {
    expect(skipReason(true, [], unread([pr(11)]))).toBeNull();
  });

  it('skips when disabled', () => {
    expect(skipReason(false, [], unread([pr(11)]))).toMatch(/disabled/);
  });

  it('skips while an environment PR is still awaiting a human, naming it', () => {
    const reason = skipReason(true, [{ url: pr(20) }], unread([pr(11)]));
    expect(reason).toMatch(/already awaiting a human/);
    expect(reason).toContain(pr(20));
  });

  it('skips when every factory PR has already been read', () => {
    expect(skipReason(true, [], unread())).toMatch(/not already read/);
  });

  it('skips, naming the cutoff, when the only unread reports predate the change', () => {
    const reason = skipReason(true, [], unread([], [pr(782), pr(765)]), '2026-09-01T19:35:51Z');
    expect(reason).toMatch(/2 unread factory PR\(s\)/);
    expect(reason).toContain('2026-09-01T19:35:51Z');
  });

  it('runs on the fresh reports even when stale ones are also pending', () => {
    expect(skipReason(true, [], unread([pr(790)], [pr(782)]), '2026-09-01T19:35:51Z')).toBeNull();
  });

  it('reports the open PR before anything else when both apply', () => {
    expect(skipReason(true, [{ url: pr(20) }], unread())).toMatch(/already awaiting a human/);
  });
});

describe('workerSkipReason', () => {
  it('lets the cursor worker run the phase', () => {
    expect(workerSkipReason('cursor')).toBeNull();
  });

  it('skips it for the claude-code worker, saying why', () => {
    expect(workerSkipReason('claude-code')).toMatch(/only applies to the cursor worker/);
  });
});

// A "Blocked by the machine" item that is really the repo's defect is the one
// thing the environment agent cannot close itself. It writes it as a fenced
// issue block; the factory files it and posts the rest of the report.
describe('parseEnvReport', () => {
  const reply = `No environment gap; the image is fine.

\`\`\`issue
CSRF middleware rejects the agent layer's /internal calls with env.example's settings
With \`APP_CSRF_REPORT_ONLY="false"\` every POST /internal/tools/invoke answers 403.
\`\`\`

The database start is the same as on #56.`;

  it('lifts each issue block out, title first line and body the rest', () => {
    const { report, issues } = parseEnvReport(reply);
    expect(issues).toEqual([{
      title: "CSRF middleware rejects the agent layer's /internal calls with env.example's settings",
      body: 'With `APP_CSRF_REPORT_ONLY="false"` every POST /internal/tools/invoke answers 403.',
    }]);
    expect(report).toContain('No environment gap');
    expect(report).toContain('same as on #56');
    expect(report).not.toContain('```issue');
    expect(report).not.toContain('answers 403');
  });

  it('a report with no block files nothing and is posted whole', () => {
    expect(parseEnvReport('Nothing to add this week.')).toEqual({ report: 'Nothing to add this week.', issues: [] });
  });

  it('a block with no title is not an issue', () => {
    expect(parseEnvReport('```issue\n\n```').issues).toEqual([]);
  });
});

describe('filedIssueBody', () => {
  const draft = { title: 't', body: 'The body.' };

  it('opens with where the report came from, then the write-up', () => {
    const body = filedIssueBody(draft, [pr(1067)]);
    expect(body.startsWith(`Reported by the implementer of ${pr(1067)} under **Blocked by the machine**`)).toBe(true);
    expect(body).toContain('a defect in the repo, not the machine');
    expect(body.trimEnd().endsWith('The body.')).toBe(true);
  });

  it('names every PR the pass read', () => {
    const body = filedIssueBody(draft, [pr(1067), pr(1066)]);
    expect(body).toContain(`implementers of ${pr(1067)}, ${pr(1066)}`);
  });
});

// GitHub's label index lags a label write by seconds, and the pass lists by
// label seconds after the implementers labelled their PRs. The tick vouches
// for what it opened.
describe('withOpenedThisTick', () => {
  it('puts a PR GitHub has not listed yet in front of the fresh ones', () => {
    expect(withOpenedThisTick(unread([pr(1070), pr(1067)]), [pr(1071)])).toEqual(unread([pr(1071), pr(1070), pr(1067)]));
  });

  it('does not repeat a PR GitHub already listed, fresh or stale', () => {
    const u = unread([pr(1070)], [pr(900)]);
    expect(withOpenedThisTick(u, [pr(1070), pr(900)])).toBe(u);
    expect(withOpenedThisTick(u, [pr(1071), pr(1071)])).toEqual(unread([pr(1071), pr(1070)], [pr(900)]));
  });

  it('is a no-op when nothing was opened', () => {
    const u = unread([pr(1070)]);
    expect(withOpenedThisTick(u, [])).toBe(u);
  });
});
