import { Global, Module } from '@nestjs/common';
import { OrgSweepRunner } from './org-sweep.runner.js';

/** Chỉ worker: handler quét của module (khai trong `forWorker()`) inject `OrgSweepRunner`. */
@Global()
@Module({ providers: [OrgSweepRunner], exports: [OrgSweepRunner] })
export class SweepModule {}
