import { DiscoveryService } from '@nestjs/core';
import type { JobContext } from './job-context.js';
import type { JobDef } from './job-definition.js';

/** Decorator có kiểu của Nest Discovery: WorkerHost đọc lại JobDef qua `getMetadataByDecorator`, không cần cast metadata. */
export const JobHandlerMarker = DiscoveryService.createDecorator<JobDef>();

export const JobHandler = (job: JobDef): ClassDecorator =>
  JobHandlerMarker(job);

export interface JobHandlerInstance {
  handle(ctx: JobContext<unknown>): Promise<void>;
}

export const isJobHandlerInstance = (v: unknown): v is JobHandlerInstance =>
  typeof v === 'object' &&
  v !== null &&
  'handle' in v &&
  typeof v.handle === 'function';
