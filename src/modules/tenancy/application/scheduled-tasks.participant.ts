import { Injectable } from '@nestjs/common';
import { ScheduledTaskService } from '../../../core/scheduler/index.js';
import { SCHEDULED_TASKS_PURGE_ORDER } from '../constants.js';
import { OrgPurgeParticipant } from '../ports/org-purge-participant.js';
import { OrgPurgeParticipantContributor } from './org-purge-participant.registry.js';

/** `scheduled_tasks` (core) có FK RESTRICT tới org (Task 16): xoá dòng trong transaction purge; Redis gỡ sau commit. */
@Injectable()
@OrgPurgeParticipantContributor({
  key: 'core.scheduled-tasks',
  order: SCHEDULED_TASKS_PURGE_ORDER,
})
export class ScheduledTasksPurgeParticipant extends OrgPurgeParticipant {
  constructor(private readonly schedules: ScheduledTaskService) {
    super();
  }
  async purge(): Promise<void> {
    await this.schedules.removeAllForCurrentOrg();
  }
}
