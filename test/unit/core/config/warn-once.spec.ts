import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { warnOnce } from '../../../../src/core/config/warn-once.js';

describe('warnOnce', () => {
  it('prints a single structured JSON line to stderr, once per (namespace, message)', () => {
    const write = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    try {
      warnOnce('ns-a', 'first message');
      warnOnce('ns-a', 'first message');
      warnOnce('ns-a', 'first message');
      expect(write).toHaveBeenCalledTimes(1);
      const line: unknown = JSON.parse(String(write.mock.calls[0]?.[0]));
      // N8: `level` là số pino (40 = warn), không phải chuỗi "warn" — pipeline lọc `level >= 40` không bỏ sót dòng này.
      expect(line).toMatchObject({
        level: pino.levels.values.warn,
        namespace: 'ns-a',
        msg: 'first message',
      });
      expect(typeof (line as { level: unknown }).level).toBe('number');
      expect((line as { time: unknown }).time).toEqual(expect.any(Number));
    } finally {
      write.mockRestore();
    }
  });

  it('treats a different message, or a different namespace, as a separate warning', () => {
    const write = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    try {
      warnOnce('ns-b', 'message one');
      warnOnce('ns-b', 'message two');
      warnOnce('ns-c', 'message one');
      expect(write).toHaveBeenCalledTimes(3);
    } finally {
      write.mockRestore();
    }
  });
});
