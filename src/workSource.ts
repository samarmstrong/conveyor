import type { Task, WorkSource } from './types.ts';
import type { FactoryConfig } from './config.ts';
import { repoSlug } from './config.ts';
import {
  addIssueLabels, commentOnIssue, createIssue, editIssueBody, ensureLabel, listOpenIssues, removeIssueLabels,
} from './github.ts';
import {
  childrenFiledComment, failedAttemptComment, groomComment, hasLegacyBlock, isEpic, stripLegacyBlock,
  type ChildDraft, type GroomReply, type StampExtras,
} from './groom.ts';

export class GitHubIssueSource implements WorkSource {
  constructor(private readonly config: FactoryConfig) {}

  private get repo(): string {
    return repoSlug(this.config);
  }

  async eligibleTasks(): Promise<Task[]> {
    const issues = await listOpenIssues(this.repo, this.config.selector.maxCandidates);
    return issues.map((i) => ({
      id: `${this.repo}#${i.number}`,
      issueNumber: i.number,
      title: i.title,
      body: i.body ?? '',
      comments: (i.comments ?? []).map((c) => ({ body: c.body ?? '' })),
      labels: i.labels.map((l) => l.name),
      assignees: (i.assignees ?? []).map((a) => a.login),
      url: i.url,
    }));
  }

  async markStarted(task: Task): Promise<void> {
    await ensureLabel(
      this.repo,
      this.config.labels.issueInProgress,
      '1D76DB',
      'Claimed by the software factory; a PR is in flight',
    );
    await addIssueLabels(this.repo, task.issueNumber, [this.config.labels.issueInProgress]);
  }

  async markFinished(task: Task): Promise<void> {
    await removeIssueLabels(this.repo, task.issueNumber, [this.config.labels.issueInProgress]).catch(() => {});
  }

  /**
   * Grooming is the only judge of whether an issue is one PR, and an attempt is
   * the only test of that judgment. When the attempt fails the verdict is
   * retracted here — label flipped, reason posted — rather than left standing
   * for the next selector to pick and the next implementer to fail on.
   *
   * The comment is a plain factory comment, not a new groom stamp, so the
   * fingerprint still points at the human content the groom read: the issue is
   * groomed again only when a human replies or edits, and that groom sees this
   * report among the comments.
   */
  async recordFailedAttempt(task: Task, report: string): Promise<void> {
    await commentOnIssue(this.repo, task.issueNumber, failedAttemptComment(report));
    const { groomed, needsWork } = this.config.labels;
    await ensureLabel(this.repo, needsWork, 'D93F0B', 'Not ready for the factory as written; edit the issue to have it re-reviewed');
    await addIssueLabels(this.repo, task.issueNumber, [needsWork]);
    await removeIssueLabels(this.repo, task.issueNumber, [groomed]).catch(() => {});
  }

  /**
   * A verdict is a comment plus a label, never an edit: both outcomes are the
   * factory's own words, signed and timestamped as such, and nothing a human
   * wrote is touched.
   *
   * The comment goes first because it carries the fingerprint the label is read
   * against. Either half failing therefore leaves the issue looking ungroomed or
   * stale — it gets groomed again next tick, which is the safe way to fail.
   */
  async recordGroom(task: Task, reply: GroomReply, extras: StampExtras = {}): Promise<void> {
    await commentOnIssue(this.repo, task.issueNumber, groomComment(task, reply, isEpic(task, this.config.labels), extras));

    const { groomed, needsWork } = this.config.labels;
    const [add, remove] = reply.verdict === 'groomed' ? [groomed, needsWork] : [needsWork, groomed];
    await ensureLabel(this.repo, groomed, '0E8A16', 'Vetted by the factory; eligible for an agent to implement');
    await ensureLabel(this.repo, needsWork, 'D93F0B', 'Not ready for the factory as written; edit the issue to have it re-reviewed');
    // The label is the verdict of record: remove one by hand and the issue is groomed again.
    await addIssueLabels(this.repo, task.issueNumber, [add]);
    await removeIssueLabels(this.repo, task.issueNumber, [remove]).catch(() => {});

    // Migration: verdicts used to be stamped into the description. Now that this
    // issue's verdict lives in a comment, give the author their description back.
    if (hasLegacyBlock(task.body)) {
      await editIssueBody(this.repo, task.issueNumber, `${stripLegacyBlock(task.body).trimEnd()}\n`).catch(() => {});
    }
  }

  /**
   * The children a groomed epic's groomer wrote. Each opens with a line naming
   * the epic — that is the only structure the factory adds, and it is what a
   * later groom follows to find the premise. They inherit the epic's labels,
   * minus the epic label itself and anything the factory owns, so an epic
   * filed under `area:agents` yields children filed under `area:agents`.
   * Filed one at a time so a failure leaves a legible partial list, which is
   * then noted on the epic.
   */
  async fileChildren(epic: Task, children: ChildDraft[]): Promise<{ number: number; url: string }[]> {
    const factoryOwned = new Set(Object.values(this.config.labels));
    const labels = epic.labels.filter((l) => !factoryOwned.has(l));
    const filed: { number: number; url: string }[] = [];
    try {
      for (const child of children) {
        filed.push(await createIssue(this.repo, child.title, `Part of #${epic.issueNumber}\n\n${child.body}`, labels));
      }
    } finally {
      if (filed.length > 0) {
        await commentOnIssue(this.repo, epic.issueNumber, childrenFiledComment(filed)).catch(() => {});
      }
    }
    return filed;
  }
}
