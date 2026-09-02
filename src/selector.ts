// Selection is an agent flow, not a formula: the selector agent reads the open
// issues and picks the most well-scoped one. The only mechanical parts are
// filtering out issues someone has already claimed — the factory itself, via
// the wip label, or a human, via an assignee — and parsing the handoff line
// from the selector's reply.

import type { Task } from './types.ts';

export function filterClaimed(tasks: Task[], inProgressLabel: string): Task[] {
  return tasks.filter((t) => !t.labels.includes(inProgressLabel));
}

/**
 * Issues no human has taken. An assignee is a claim in exactly the way
 * `factory:wip` is — someone intends to do this — and the factory has no way to
 * tell "assigned and untouched" from "assigned and half-written locally". Which
 * phases respect it is `assignedIssues` in the config.
 */
export function filterAssigned(tasks: Task[]): Task[] {
  return tasks.filter((t) => t.assignees.length === 0);
}

export type Selection =
  | { kind: 'picked'; task: Task }
  | { kind: 'none' }
  | { kind: 'unparseable' };

export function parseSelection(text: string, tasks: Task[]): Selection {
  const markers = [...text.matchAll(/SELECTED:\s*(?:#\s*(\d+)|none)/gi)];
  const last = markers.at(-1);
  if (last) {
    if (!last[1]) return { kind: 'none' };
    const task = tasks.find((t) => t.issueNumber === Number(last[1]));
    return task ? { kind: 'picked', task } : { kind: 'unparseable' };
  }
  // Fallback: the last issue reference in the reply that matches a candidate.
  const mentions = [...text.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
  for (let i = mentions.length - 1; i >= 0; i--) {
    const task = tasks.find((t) => t.issueNumber === mentions[i]);
    if (task) return { kind: 'picked', task };
  }
  return { kind: 'unparseable' };
}
