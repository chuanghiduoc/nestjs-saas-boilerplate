import type { EventActor } from '../../core/events/index.js';

/**
 * Hằng của feature mẫu (spec SP7 §7.1, §10.1, §10.3). Migration `…_example_projects` viết cứng 100/1000 vì không import code;
 * EX-I7 so `pg_get_constraintdef` với hai hằng này.
 */
export const EXAMPLE_PROJECT_NAME_MAX_LENGTH = 100;
export const EXAMPLE_PROJECT_DESCRIPTION_MAX_LENGTH = 1000;
/** `aggregate.type` của năm event `example.project.*`. */
export const EXAMPLE_PROJECT_AGGREGATE = 'example_project';
/** Registry order của participant xoá cứng org (R-X5, addendum 3D §A4): sau entitlements (100), trước tenancy core (1000). */
export const EXAMPLE_PURGE_ORDER = 200;
/** Actor của job xoá project đã lưu trữ quá retention (spec §10.1). */
export const EXAMPLE_PURGE_ACTOR: EventActor = {
  type: 'system',
  id: 'example.projects.purge',
};
