import { describe, expect, it } from 'vitest';
import { alertKey, claimedBy, describeAdvisory, describeAlert, fixedReports, keysIn, openReports, MAX_OPEN_PRS, parseFixReply, parseSeverity, securityQueue, securityStamp, skipReason, type AdvisoryReport, type CodeScanningAlert, type DependabotAlert, type SecurityPr } from '../src/security.ts';
import { factoryComment } from '../src/groom.ts';
import { securityPrompt } from '../src/prompts.ts';

function dep(number: number, over: Partial<DependabotAlert> = {}): DependabotAlert {
  return {
    kind: 'dependabot', number, severity: 'high', url: `https://github.com/o/r/security/dependabot/${number}`,
    ecosystem: 'npm', package: 'axios', manifest: 'clients/web/package-lock.json', scope: 'runtime',
    ghsa: 'GHSA-aaaa-bbbb-cccc', advisory: 'SSRF via absolute URL', vulnerableRange: '< 1.20.0', patched: '1.20.0',
    ...over,
  };
}

function cs(number: number, over: Partial<CodeScanningAlert> = {}): CodeScanningAlert {
  return {
    kind: 'code-scanning', number, severity: 'high', url: `https://github.com/o/r/security/code-scanning/${number}`,
    tool: 'CodeQL', rule: 'py/path-injection', ruleDescription: 'Uncontrolled data used in path expression',
    path: 'core/cases/case_evidence_service.py', line: 42, message: 'This path depends on a\nuser-provided value.',
    ...over,
  };
}

const HOUR = 3_600_000;
const NOW = Date.parse('2026-10-02T12:00:00Z');

function pr(n: number, claims: string[], state: SecurityPr['state'] = 'OPEN', mergedHoursAgo?: number): SecurityPr {
  return {
    url: `https://github.com/o/r/pull/${n}`,
    state,
    mergedAt: mergedHoursAgo === undefined ? null : new Date(NOW - mergedHoursAgo * HOUR).toISOString(),
    comments: [{ body: 'looks good' }, { body: factoryComment(`${securityStamp(claims)}\n🏭 fix`) }],
  };
}

const offeredKeys = (alerts: Parameters<typeof securityQueue>[0], prs: SecurityPr[] = [], min: Parameters<typeof securityQueue>[2] = 'high') =>
  securityQueue(alerts, prs, min, NOW).offered.map((o) => alertKey(o.alert));

describe('which alerts a fixer is handed', () => {
  it('those at the threshold or above, most severe first', () => {
    expect(offeredKeys([dep(1, { severity: 'medium' }), dep(2), cs(3, { severity: 'critical' }), dep(4, { severity: 'low' })]))
      .toEqual(['code-scanning#3', 'dependabot#2']);
    expect(offeredKeys([dep(1, { severity: 'medium' }), dep(2, { severity: 'low' })], [], 'medium')).toEqual(['dependabot#1']);
  });

  it('not one an open PR is fixing, or one a human declined by closing its PR', () => {
    expect(offeredKeys([dep(1), dep(2), dep(3)], [pr(10, ['dependabot#1']), pr(11, ['dependabot#2'], 'CLOSED')])).toEqual(['dependabot#3']);
  });

  it('a merge gets a day for GitHub to rescan, then the alert comes back naming it — once', () => {
    expect(offeredKeys([dep(1)], [pr(10, ['dependabot#1'], 'MERGED', 2)])).toEqual([]);
    const { offered } = securityQueue([dep(1)], [pr(10, ['dependabot#1'], 'MERGED', 30)], 'high', NOW);
    expect(offered[0]!.priorAttempts).toEqual(['https://github.com/o/r/pull/10']);
    expect(offeredKeys([dep(1)], [pr(10, ['dependabot#1'], 'MERGED', 60), pr(12, ['dependabot#1'], 'MERGED', 30)])).toEqual([]);
  });

  it('a claim is read from the factory\'s stamp, not from prose', () => {
    expect(claimedBy(pr(1, ['dependabot#1', 'code-scanning#22']))).toEqual(['dependabot#1', 'code-scanning#22']);
    expect(claimedBy({ comments: [{ body: 'this fixes dependabot#1' }] })).toEqual([]);
  });

  it('renders every fact it read, on one line', () => {
    expect(describeAlert(dep(1))).toContain('https://github.com/advisories/GHSA-aaaa-bbbb-cccc');
    expect(describeAlert(cs(3))).toContain('`core/cases/case_evidence_service.py:42`: This path depends on a user-provided value.');
  });
});

describe('when the phase does not run', () => {
  it('off, on a local worker, with too many PRs awaiting a merge, or with nothing due', () => {
    expect(skipReason(false, 'cursor')).toMatch(/disabled/);
    expect(skipReason(true, 'claude-code')).toMatch(/worker.containers is off/);
    expect(skipReason(true, 'claude-code', true, [], { offered: 1, held: 0 })).toBeNull();
    const open = Array.from({ length: MAX_OPEN_PRS }, (_, i) => ({ url: `u${i}` }));
    expect(skipReason(true, 'cursor', false, open)).toMatch(/awaiting a merge/);
    expect(skipReason(true, 'cursor', false, [], { offered: 0, held: 4 })).toMatch(/claimed/);
    expect(skipReason(true, 'cursor', false, [], { offered: 0, held: 0 })).toMatch(/no open alerts/);
    expect(skipReason(true, 'cursor', false, [], { offered: 2, held: 0 })).toBeNull();
  });

  it('takes "moderate" for medium, and refuses what is not a severity', () => {
    expect(parseSeverity('Moderate')).toBe('medium');
    expect(() => parseSeverity('urgent')).toThrow(/minSeverity/);
  });
});

describe('the fixer\'s reply', () => {
  const offered = ['dependabot#1', 'dependabot#2', 'code-scanning#3', 'code-scanning#4'];

  it('claims the offered alerts its ALERTS lines name, once each', () => {
    const { fixed } = parseFixReply('Done.\nALERTS: dependabot#1, dependabot#2 dependabot#99\nalerts: dependabot#1', offered);
    expect(fixed).toEqual(['dependabot#1', 'dependabot#2']);
  });

  it('dismisses a code scanning finding with its reason, never a dependency alert', () => {
    const { fixed, dismiss } = parseFixReply(
      'ALERTS: code-scanning#3\nFALSE POSITIVE: code-scanning#4 — the path is a constant\nFalse positive: dependabot#2 — unused',
      offered);
    expect(fixed).toEqual(['code-scanning#3']);
    expect(dismiss).toEqual([{ key: 'code-scanning#4', reason: 'the path is a constant' }]);
  });

  it('a finding both fixed and dismissed is dismissed, not claimed', () => {
    const { fixed, dismiss } = parseFixReply('FALSE POSITIVE: code-scanning#3 — test fixture\nALERTS: code-scanning#3 dependabot#1', offered);
    expect(fixed).toEqual(['dependabot#1']);
    expect(dismiss.map((d) => d.key)).toEqual(['code-scanning#3']);
  });

  it('the prompt names the budget and the alerts, and lists the open security PRs', () => {
    const prompt = securityPrompt({ alerts: ['dependabot#1 …'], openPrs: ['https://github.com/o/r/pull/10'], budget: { maxRunMinutes: 90 } });
    expect(prompt).toContain('about 90 minutes');
    expect(prompt).toContain('- dependabot#1 …');
    expect(prompt).toContain('https://github.com/o/r/pull/10');
    expect(prompt).toContain('**Verification**');
  });
});

describe('reported advisories', () => {
  const report = (ghsa: string, over: Partial<AdvisoryReport> = {}): AdvisoryReport => ({
    kind: 'advisory', ghsa, state: 'triage', severity: 'high', url: `https://github.com/o/r/security/advisories/${ghsa}`,
    summary: 'Role permissions are not enforced', description: '**Affected:** main\n\nA Viewer can `POST /api/config`.\n\n```\ncurl …\n```',
    cwes: ['CWE-862 Missing Authorization'], reporter: 'reporter-one', createdAt: '2026-10-03T16:37:18Z', cvss: null, affected: ['<= 0.6'],
    ...over,
  });
  const r1 = report('GHSA-2cfg-3hjm-4pqr');

  it('is named with a prefix, and found in prose, stamps, and replies however it is cased', () => {
    expect(alertKey(r1)).toBe('advisory#GHSA-2cfg-3hjm-4pqr');
    expect(keysIn('fixes advisory#GHSA-2CFG-3HJM-4PQR and dependabot#4, not GHSA-aaaa-bbbb-cccc')).toEqual(['advisory#GHSA-2cfg-3hjm-4pqr', 'dependabot#4']);
    expect(claimedBy(pr(1, ['advisory#GHSA-2cfg-3hjm-4pqr']))).toEqual(['advisory#GHSA-2cfg-3hjm-4pqr']);
  });

  it('is offered at any severity, ranked by the reported one, unrated as medium, oldest first', () => {
    const low = report('GHSA-1111-1111-1111', { severity: 'low', createdAt: '2026-10-02T20:29:42Z' });
    const unrated = report('GHSA-aaaa-bbbb-cccc', { severity: null, createdAt: '2026-10-01T00:00:00Z' });
    const older = report('GHSA-5555-5555-5555', { createdAt: '2026-09-28T16:27:25Z' });
    expect(offeredKeys([low, dep(1), r1, unrated, dep(2, { severity: 'critical' }), older]))
      .toEqual(['dependabot#2', 'dependabot#1', 'advisory#GHSA-5555-5555-5555', 'advisory#GHSA-2cfg-3hjm-4pqr', 'advisory#GHSA-aaaa-bbbb-cccc', 'advisory#GHSA-1111-1111-1111']);
  });

  it('is held by any PR that claims it, merged however long ago — GitHub closes no report on a merge', () => {
    expect(offeredKeys([r1], [pr(10, ['advisory#GHSA-2cfg-3hjm-4pqr'])])).toEqual([]);
    expect(offeredKeys([r1], [pr(10, ['advisory#GHSA-2cfg-3hjm-4pqr'], 'MERGED', 60)])).toEqual([]);
    expect(securityQueue([r1], [pr(10, ['advisory#GHSA-2cfg-3hjm-4pqr'], 'CLOSED')], 'high', NOW).held).toBe(1);
  });

  it('reaches the agent whole: the facts on a line, the description quoted', () => {
    const text = describeAdvisory(r1, ['https://github.com/o/r/pull/9']);
    expect(text).toContain('### advisory#GHSA-2cfg-3hjm-4pqr — Role permissions are not enforced');
    expect(text).toContain('reported **high** by @reporter-one on 2026-10-03 as CWE-862 Missing Authorization affecting <= 0.6.');
    expect(text).toContain('Still in triage after https://github.com/o/r/pull/9 merged.');
    expect(text).toContain('> A Viewer can `POST /api/config`.\n> \n> ```\n> curl …\n> ```');
    expect(describeAdvisory(report('GHSA-aaaa-bbbb-cccc', { severity: null, reporter: null, cwes: [], affected: [] }))).toContain('reported **unrated** on 2026-10-03.');
  });

  it('the reply closes a report as a false positive, re-rates one, or fixes one — and a re-rating rides along with any of them', () => {
    const offered = ['advisory#GHSA-2cfg-3hjm-4pqr', 'advisory#GHSA-1111-1111-1111', 'advisory#GHSA-5555-5555-5555', 'dependabot#1'];
    const reply = parseFixReply([
      'ALERTS: advisory#GHSA-2cfg-3hjm-4pqr dependabot#1',
      'FALSE POSITIVE: advisory#GHSA-1111-1111-1111 — the credentials column is encrypted at rest since #1402',
      'SEVERITY: advisory#GHSA-2cfg-3hjm-4pqr critical — any signed-in user, no interaction',
      'SEVERITY: advisory#GHSA-5555-5555-5555 Moderate — needs an operator-configured Elastic source and an analyst role',
      'SEVERITY: advisory#GHSA-5555-5555-5555 low — repeated, ignored',
      'SEVERITY: advisory#GHSA-zzzz-zzzz-zzzz high — not offered',
      'FALSE POSITIVE: dependabot#1 — never a false positive',
    ].join('\n'), offered);
    expect(reply.fixed).toEqual(['advisory#GHSA-2cfg-3hjm-4pqr', 'dependabot#1']);
    expect(reply.dismiss).toEqual([{ key: 'advisory#GHSA-1111-1111-1111', reason: 'the credentials column is encrypted at rest since #1402' }]);
    expect(reply.rerate).toEqual([
      { key: 'advisory#GHSA-2cfg-3hjm-4pqr', severity: 'critical', reason: 'any signed-in user, no interaction' },
      { key: 'advisory#GHSA-5555-5555-5555', severity: 'medium', reason: 'needs an operator-configured Elastic source and an analyst role' },
    ]);
  });

  it('the prompt carries the reports in their own section with their own rules, and no empty alerts section', () => {
    const prompt = securityPrompt({ alerts: [], advisories: [describeAdvisory(r1)], openPrs: [], budget: { maxRunMinutes: 90 } });
    expect(prompt).toContain('## Reported advisories');
    expect(prompt).toContain('### advisory#GHSA-2cfg-3hjm-4pqr');
    expect(prompt).toContain('SEVERITY: advisory#GHSA-<id>');
    expect(prompt).toContain('FALSE POSITIVE: advisory#GHSA-<id>');
    expect(prompt).not.toContain('## Alerts');
    const alertsOnly = securityPrompt({ alerts: ['dependabot#1 …'], openPrs: [], budget: { maxRunMinutes: 90 } });
    expect(alertsOnly).toContain('## Alerts');
    expect(alertsOnly).not.toContain('Reported advisories');
    expect(alertsOnly).not.toContain('SEVERITY:');
  });

  it('the skip reason says both are empty', () => {
    expect(skipReason(true, 'cursor', false, [], { offered: 0, held: 0 })).toMatch(/no reports in triage/);
  });
});

describe('fixedReports', () => {
  const accepted = (ghsa: string, description: string) => ({ ghsa, description });
  const pr = (url: string, state: 'OPEN' | 'MERGED' | 'CLOSED') => ({ url, state });
  const fixUrl = 'https://github.com/o/r/pull/1766';
  const acceptedNote = `### Summary\nViewer can write settings.\n\n---\n\n🏭 **Factory assessment**, 2026-10-06.\n\n**Severity high** (reported critical): needs a session.\n\n**Fix in ${fixUrl}.** Accepted as a draft advisory by the software factory, which closes it once the fix merges.\n`;

  it('closes an accepted report once the PR its note names has merged', () => {
    const out = fixedReports([accepted('GHSA-2cfg-3hjm-4pqr', acceptedNote)], [pr(fixUrl, 'MERGED')]);
    expect(out.map((o) => [o.report.ghsa, o.prUrl])).toEqual([['GHSA-2cfg-3hjm-4pqr', fixUrl]]);
  });

  it('waits while the PR is open, and leaves a closed-unmerged PR alone', () => {
    expect(fixedReports([accepted('GHSA-2cfg-3hjm-4pqr', acceptedNote)], [pr(fixUrl, 'OPEN')])).toEqual([]);
    expect(fixedReports([accepted('GHSA-2cfg-3hjm-4pqr', acceptedNote)], [pr(fixUrl, 'CLOSED')])).toEqual([]);
  });

  it('never touches a draft a maintainer wrote themselves', () => {
    const human = accepted('GHSA-3333-3333-3333', `### Summary\nAdmin routes check sign-in only. Fixed in ${fixUrl} I think.`);
    expect(fixedReports([human], [pr(fixUrl, 'MERGED')])).toEqual([]);
  });

  it('leaves a report a human reopened after the factory closed it', () => {
    const reopened = accepted('GHSA-2cfg-3hjm-4pqr', `${acceptedNote}\n---\n\n🏭 **Closed by the software factory**, 2026-10-07: the fix in ${fixUrl} merged. A maintainer can reopen it.\n`);
    expect(fixedReports([reopened], [pr(fixUrl, 'MERGED')])).toEqual([]);
  });

  it('takes the latest acceptance when a report was accepted twice', () => {
    const again = accepted('GHSA-2cfg-3hjm-4pqr', `${acceptedNote}\n---\n\n🏭 **Closed by the software factory**, 2026-10-07: the fix in ${fixUrl} merged.\n\n---\n\n🏭 **Factory assessment**, 2026-10-08.\n\n**Fix in https://github.com/o/r/pull/1900.** Accepted as a draft advisory by the software factory, which closes it once the fix merges.\n`);
    expect(fixedReports([again], [pr(fixUrl, 'MERGED'), pr('https://github.com/o/r/pull/1900', 'OPEN')])).toEqual([]);
    expect(fixedReports([again], [pr('https://github.com/o/r/pull/1900', 'MERGED')]).map((o) => o.prUrl)).toEqual(['https://github.com/o/r/pull/1900']);
  });
});

describe('openReports', () => {
  const r = (state: 'triage' | 'draft', description: string) => ({ state, description });
  const fix = 'https://github.com/o/r/pull/1766';
  const accepted = `### Summary\nx\n\n---\n\n🏭 **Factory assessment**, 2026-10-06.\n\n**Fix in ${fix}.** Accepted as a draft advisory by the software factory, which closes it once the fix merges.\n`;
  const rerated = `### Summary\nx\n\n---\n\n🏭 **Factory assessment**, 2026-10-06.\n\n**Severity low** (reported high): needs an admin.\n`;

  it('offers a triage report until it leaves triage, re-rated or not', () => {
    expect(openReports([r('triage', '### Summary\nx'), r('triage', rerated)])).toHaveLength(2);
  });

  it('offers a draft a maintainer wrote, and not one the factory has written on', () => {
    const human = r('draft', '### Summary\nAdmin routes check sign-in only.');
    expect(openReports([human, r('draft', accepted), r('draft', `${accepted}\n---\n\n🏭 **Closed by the software factory**, 2026-10-07: the fix in ${fix} merged.\n`)])).toEqual([human]);
  });

});

describe('a report asking for private handling', () => {
  it('is described as a maintainer\'s when a draft, and the agent is told to fix it in the open', () => {
    const draft: AdvisoryReport = {
      kind: 'advisory', ghsa: 'GHSA-4444-4444-4444', state: 'draft', severity: 'critical', url: 'https://github.com/o/r/security/advisories/GHSA-4444-4444-4444',
      summary: 'Audit: confidential fixes', description: 'Please do not merge into the public repository before coordinated release.', cwes: [], reporter: 'reporter-two', createdAt: '2026-09-23T10:00:00Z', cvss: null, affected: [],
    };
    const text = describeAdvisory(draft);
    expect(text).toContain('filed as a draft by a maintainer, so it never passed through triage');
    const prompt = securityPrompt({ alerts: [], advisories: [text], openPrs: [], budget: { maxRunMinutes: 90 } });
    expect(prompt).toContain('not the maintainers\' wish');
    expect(prompt).not.toContain('HELD');
  });
});
