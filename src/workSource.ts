import type { GroomVerdict, Task, WorkSource } from './types.ts';
import type { FactoryConfig } from './config.ts';
import { repoSlug } from './config.ts';
import {
  addIssueLabels, commentOnIssue, editIssueBody, ensureLabel, listOpenIssues, removeIssueLabels,
} from './github.ts';
import { stampBody } from './groom.ts';

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
      labels: i.labels.map((l) => l.name),
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
   * The stamped body is the machine-readable record; the labels mirror it for
   * humans browsing the issue list, and the code always re-derives state from
   * the body, so a hand-edited label cannot make the factory act wrongly.
   */
  async recordGroom(
    task: Task,
    reply: { verdict: GroomVerdict; notes: string | undefined; reasoning: string },
  ): Promise<void> {
    await editIssueBody(this.repo, task.issueNumber, stampBody(task.body, reply.verdict, reply.notes));

    const { groomed, needsWork } = this.config.labels;
    const [add, remove] = reply.verdict === 'groomed' ? [groomed, needsWork] : [needsWork, groomed];
    await ensureLabel(this.repo, groomed, '0E8A16', 'Vetted by the factory; eligible for an agent to implement');
    await ensureLabel(this.repo, needsWork, 'D93F0B', 'Not ready for the factory as written; edit the description to have it re-reviewed');
    await addIssueLabels(this.repo, task.issueNumber, [add]);
    await removeIssueLabels(this.repo, task.issueNumber, [remove]).catch(() => {});

    // needs-work is advice, not a verdict on the underlying problem, so it goes
    // in the open where the author can argue with it. A pass stays silent: the
    // stamped body already says everything.
    if (reply.verdict === 'needs-work') {
      await commentOnIssue(
        this.repo,
        task.issueNumber,
        `🏭 The factory reviewed this issue and is **not** picking it up as written.\n\n${reply.reasoning}\n\n---\nEdit the description and the factory will review it again on a later tick.`,
      );
    }
  }
}
