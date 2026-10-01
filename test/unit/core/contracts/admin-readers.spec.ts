import { Injectable, Module, Optional } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import {
  FileUsageReader,
  WebhookStatsReader,
} from '../../../../src/core/contracts/admin-readers.js';

/** Như dịch vụ org của admin (6D): hai số liệu tuỳ chọn, vắng module thì `null` (R-X16, S6-A52). */
@Injectable()
class Consumer {
  constructor(
    @Optional() readonly files?: FileUsageReader,
    @Optional() readonly hooks?: WebhookStatsReader,
  ) {}
  async stats() {
    return {
      storageUsedBytes: this.files ? await this.files.storageUsedBytes() : null,
      webhookEndpoints: this.hooks ? await this.hooks.endpointCount() : null,
    };
  }
}
/** Số byte giả của provider fixture. */
const FAKE_BYTES = 1024;
@Injectable()
class FakeFiles extends FileUsageReader {
  async storageUsedBytes() {
    return FAKE_BYTES;
  }
}
@Module({
  providers: [FakeFiles, { provide: FileUsageReader, useExisting: FakeFiles }],
  exports: [FileUsageReader],
})
class FilesPorts {}

describe('core/contracts admin readers (R-X16)', () => {
  it('are abstract DI tokens: no provider → the optional field is null; a provider → its value', async () => {
    const without = await Test.createTestingModule({
      providers: [Consumer],
    }).compile();
    expect(await without.get(Consumer).stats()).toEqual({
      storageUsedBytes: null,
      webhookEndpoints: null,
    });
    const withFiles = await Test.createTestingModule({
      imports: [FilesPorts],
      providers: [Consumer],
    }).compile();
    expect(await withFiles.get(Consumer).stats()).toEqual({
      storageUsedBytes: FAKE_BYTES,
      webhookEndpoints: null,
    });
  });
});
