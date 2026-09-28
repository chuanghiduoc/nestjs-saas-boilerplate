import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { httpConfig, jsonBodyParser } from '../../../../src/core/http/index.js';
import { lingerUnreadBody } from '../../../../src/core/http/unread-body.js';

const LINGER_MS = 100;
const cfg = httpConfig.schema.parse({ bodyLimitLingerMs: LINGER_MS });
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function fixture() {
  const socket = new Socket();
  const req = new IncomingMessage(socket);
  req.headers['transfer-encoding'] = 'chunked';
  const res = new ServerResponse(req);
  const destroy = vi.spyOn(socket, 'destroy');
  return { socket, req, res, destroy };
}
describe('unread body timing', () => {
  it.each(['GET', 'HEAD'])(
    '%s gets a full linger grace after a slow handler finishes',
    (method) => {
      vi.useFakeTimers();
      const { socket, req, res, destroy } = fixture();
      try {
        req.method = method;
        jsonBodyParser(cfg)(req, res, () => undefined);
        vi.advanceTimersByTime(LINGER_MS * 2);
        res.emit('finish');
        expect(destroy).not.toHaveBeenCalled();
        vi.advanceTimersByTime(LINGER_MS - 1);
        expect(destroy).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(destroy).toHaveBeenCalledOnce();
        expect(req.listenerCount('data')).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        socket.destroy();
      }
    },
  );
  it('keeps the 413 deadline anchored at the rejection decision', () => {
    vi.useFakeTimers();
    const { socket, req, res, destroy } = fixture();
    try {
      lingerUnreadBody(req, res, cfg, undefined);
      vi.advanceTimersByTime(LINGER_MS);
      expect(destroy).not.toHaveBeenCalled();
      res.emit('finish');
      expect(destroy).toHaveBeenCalledOnce();
    } finally {
      socket.destroy();
    }
  });
  it('cleans up a disconnected slow request before sending a response', () => {
    vi.useFakeTimers();
    const { socket, req, res } = fixture();
    req.method = 'GET';
    jsonBodyParser(cfg)(req, res, () => undefined);
    socket.emit('close');
    expect(res.listenerCount('finish')).toBe(0);
    expect(req.listenerCount('data')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    socket.destroy();
  });
});
