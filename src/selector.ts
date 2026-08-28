// Selection is an agent flow, not a formula: the selector agent reads the open
// issues and picks the most well-scoped one. The only mechanical parts are
// filtering out issues the factory has already claimed and parsing the
// handoff line from the selector's reply.

import type { Task } from './types.ts';

export function filterClaimed(tasks: Task[], inProgressLabel: string): Task[] {
  return tasks.filter((t) => !t.labels.includes(inProgressLabel));
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
