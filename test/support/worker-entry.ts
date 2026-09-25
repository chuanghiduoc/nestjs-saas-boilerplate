/**
 * Worker trong process con thật (test/support/spawn-worker.ts): đúng đường khởi động
 * (`bootstrapWorker`) và tắt (`installShutdown`) của production, cộng job fixture.
 *
 * Windows không giao được SIGTERM cho handler của Node (`child.kill('SIGTERM')` gọi
 * TerminateProcess, process chết ngay). Trên Windows process cha gửi `{ signal: 'SIGTERM' }` qua
 * IPC và entry này phát lại bằng `process.emit`, để vẫn chạy đúng handler của `installShutdown`.
 * Trên Linux/macOS process cha gửi SIGTERM thật; nhánh IPC không được dùng.
 */
import { Module } from '@nestjs/common';
import { AppWorkerModule } from '../../src/app-worker.module.js';
import { bootstrapWorker } from '../../src/main.worker.js';
import { installShutdown } from '../../src/shutdown.js';
import { ProcessJobsModule } from '../fixtures/process.jobs.js';
import { isSignalRelay } from './spawn-worker.js';

@Module({ imports: [AppWorkerModule, ProcessJobsModule] })
class TestWorkerModule {}

const ctx = await bootstrapWorker(TestWorkerModule);
installShutdown(ctx);
process.on('message', (m: unknown) => {
  if (isSignalRelay(m)) process.emit(m.signal, m.signal);
});
process.send?.({ ready: true });
