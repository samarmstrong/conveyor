import { describe, expect, it } from 'vitest';
import {
  fingerprint, groomState, humanBody, isGroomed, needsGroom, parseGroomReply, readStamp, stampBody,
} from '../src/groom.ts';
import type { Task } from '../src/types.ts';

function task(issueNumber: number, body: string, labels: string[] = []): Task {
  return {
    id: `o/r#${issueNumber}`,
    issueNumber,
    title: `task ${issueNumber}`,
    body,
    labels,
    url: `https://github.com/o/r/issues/${issueNumber}`,
  };
}

const original = 'The llm-worker should validate Settings at startup.\n\nSee services/worker.';

describe('stamping and fingerprinting', () => {
  it('appends a block without touching the human text', () => {
    const stamped = stampBody(original, 'groomed', 'Stay inside services/worker; do not touch callers.');
    expect(stamped.startsWith(original)).toBe(true);
    expect(humanBody(stamped).trim()).toBe(original);
    expect(stamped).toContain('## Factory grooming notes');
  });

  it('reads back the verdict it wrote', () => {
    const stamped = stampBody(original, 'needs-work');
    expect(readStamp(stamped)).toMatchObject({ verdict: 'needs-work' });
  });

  it('treats an unstamped body as never groomed', () => {
    expect(groomState(original)).toEqual({ kind: 'ungroomed' });
  });

  it('does not re-groom an issue it just stamped', () => {
    const stamped = stampBody(original, 'groomed', 'notes here');
    expect(groomState(stamped).kind).toBe('current');
  });

  it('is idempotent: re-stamping replaces the block rather than nesting one', () => {
    const once = stampBody(original, 'groomed', 'first');
    const twice = stampBody(once, 'groomed', 'second');
    expect(twice.match(/factory-groom:start/g)).toHaveLength(1);
    expect(twice).toContain('second');
    expect(twice).not.toContain('first');
    expect(groomState(twice).kind).toBe('current');
  });

  it('goes stale when a human edits the description', () => {
    const stamped = stampBody(original, 'groomed', 'notes');
    const edited = stamped.replace('validate Settings at startup', 'validate Settings at every call site');
    const state = groomState(edited);
    expect(state.kind).toBe('stale');
    expect(state).toMatchObject({ previous: { verdict: 'groomed' } });
  });

  it('re-reviews a needs-work issue once its description changes', () => {
    const rejected = stampBody(original, 'needs-work');
    expect(needsGroom([task(1, rejected)])).toHaveLength(0);
    expect(needsGroom([task(1, `${rejected}\n\nRescoped: only the worker boundary.`)])).toHaveLength(1);
  });

  it('fingerprints the human part only, however the block is formatted', () => {
    const stamped = stampBody(original, 'groomed', 'notes');
    expect(fingerprint(stamped)).toBe(fingerprint(original));
    expect(fingerprint(`${original}\n`)).toBe(fingerprint(original));
  });
});

describe('backlog filters', () => {
  const groomed = task(10, stampBody('a', 'groomed'));
  const rejected = task(11, stampBody('b', 'needs-work'));
  const fresh = task(12, 'c');
  const stale = task(9, stampBody('d', 'groomed').replace('d', 'd rewritten'));

  it('grooms the ungroomed and the stale, newest first', () => {
    expect(needsGroom([groomed, rejected, fresh, stale]).map((t) => t.issueNumber)).toEqual([12, 9]);
  });

  it('offers only currently-groomed issues for implementation', () => {
    expect([groomed, rejected, fresh, stale].filter(isGroomed).map((t) => t.issueNumber)).toEqual([10]);
  });
});

describe('parseGroomReply', () => {
  it('parses a verdict with notes', () => {
    const reply = [
      'This is worth doing, but the issue asks for a new config layer we do not need.',
      '',
      '```notes',
      'Reuse Settings in core/platform/config.py. Do not add a second validator.',
      '```',
      '',
      'VERDICT: groomed',
    ].join('\n');
    const parsed = parseGroomReply(reply);
    expect(parsed).toMatchObject({ verdict: 'groomed' });
    expect(parsed!.notes).toBe('Reuse Settings in core/platform/config.py. Do not add a second validator.');
    expect(parsed!.reasoning).toContain('new config layer');
    expect(parsed!.reasoning).not.toContain('VERDICT:');
    expect(parsed!.reasoning).not.toContain('Reuse Settings');
  });

  it('parses a bare verdict with no notes', () => {
    const parsed = parseGroomReply('Clear and well-scoped as written.\n\nVERDICT: groomed');
    expect(parsed).toMatchObject({ verdict: 'groomed', notes: undefined });
  });

  it('accepts needs-work spelling variants', () => {
    for (const line of ['VERDICT: needs-work', 'verdict: needs work', 'VERDICT: needs_work']) {
      expect(parseGroomReply(`why\n\n${line}`)).toMatchObject({ verdict: 'needs-work' });
    }
  });

  it('uses the last verdict when the reply deliberates', () => {
    const parsed = parseGroomReply('At first glance:\nVERDICT: groomed\n\nOn reflection, no.\nVERDICT: needs-work');
    expect(parsed).toMatchObject({ verdict: 'needs-work' });
  });

  it('returns null rather than guessing when there is no verdict', () => {
    expect(parseGroomReply('I read the issue and had some thoughts about it.')).toBeNull();
  });

  it('does not mistake prose about a verdict for the verdict line', () => {
    expect(parseGroomReply('I would say VERDICT: groomed is arguable here, but see below.')).toBeNull();
  });
});

describe('force re-grooming', () => {
  const groomed = task(10, stampBody('a', 'groomed'));
  const rejected = task(11, stampBody('b', 'needs-work'));
  const fresh = task(12, 'c');

  it('normally leaves current verdicts alone', () => {
    expect(needsGroom([groomed, rejected, fresh]).map((t) => t.issueNumber)).toEqual([12]);
  });

  it('revisits current verdicts under force — the stamp does not track the principles', () => {
    expect(needsGroom([groomed, rejected, fresh], true).map((t) => t.issueNumber)).toEqual([12, 11, 10]);
  });
});
