import { describe, expect, it } from 'vitest';
import {
  PROJECT_STATUSES,
  transition,
  type ProjectCommand,
} from '../../../../src/features/example/domain/project.js';
import { ExampleErrors } from '../../../../src/features/example/errors.js';
import { defineConstraintErrors } from '../../../../src/core/database/index.js';

const COMMANDS: readonly ProjectCommand[] = [
  'ARCHIVE',
  'UNARCHIVE',
  'UPDATE',
  'REMOVE',
  'PURGE',
];
const ok = (next: string) => ({ kind: 'OK', next });
const no = (code: unknown) => ({ kind: 'REJECTED', code });

describe('Project state machine (spec SP7 §8.1, EX-U1)', () => {
  const table = {
    ACTIVE: {
      ARCHIVE: ok('ARCHIVED'),
      UNARCHIVE: no(ExampleErrors.EXAMPLE_PROJECT_NOT_ARCHIVED),
      UPDATE: ok('ACTIVE'),
      REMOVE: ok('DELETED'),
      PURGE: no(ExampleErrors.EXAMPLE_PROJECT_NOT_ARCHIVED),
    },
    ARCHIVED: {
      ARCHIVE: no(ExampleErrors.EXAMPLE_PROJECT_NOT_ACTIVE),
      UNARCHIVE: ok('ACTIVE'),
      UPDATE: no(ExampleErrors.EXAMPLE_PROJECT_NOT_ACTIVE),
      REMOVE: ok('DELETED'),
      PURGE: ok('DELETED'),
    },
  } as const;
  it.each(
    PROJECT_STATUSES.flatMap((s) => COMMANDS.map((c) => [s, c] as const)),
  )('%s × %s follows table 8.1', (status, command) => {
    expect(transition(status, command)).toEqual(table[status][command]);
  });
  it('an unknown status from a cast fails loud (never-check at runtime)', () => {
    expect(() => transition('DELETED' as never, 'ARCHIVE')).toThrow(
      /unknown project status/,
    );
  });
  it('the 23505 mapping of example_projects_name_uq is registered (a second registration throws)', () => {
    expect(() =>
      defineConstraintErrors({
        example_projects_name_uq: ExampleErrors.EXAMPLE_PROJECT_NAME_TAKEN,
      }),
    ).toThrow('Constraint "example_projects_name_uq" already mapped');
  });
  it('error codes carry the feature prefix (D7-2)', () => {
    expect(Object.values(ExampleErrors).map((e) => [e.code, e.status])).toEqual(
      [
        ['example_project_name_taken', 409],
        ['example_project_not_active', 409],
        ['example_project_not_archived', 409],
      ],
    );
  });
});
