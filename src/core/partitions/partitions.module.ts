import { Module } from '@nestjs/common';
import { MaintainPartitionsHandler } from './maintain-partitions.handler.js';
import './partitions.config.js';
import { PartitionMetrics } from './partitions.metrics.js';

/** Chỉ worker: handler của cron `core.partitions.maintain` (queue `maintenance`) và metric partition. */
@Module({ providers: [PartitionMetrics, MaintainPartitionsHandler] })
export class PartitionsModule {}
