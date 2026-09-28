import { Controller, Get } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { HealthController } from '../../../../src/core/health/health.controller.js';
import { PUBLIC_ROUTE, PublicRoute } from '../../../../src/core/http/index.js';

@Controller('x')
class X {
  @PublicRoute()
  @Get('open')
  open(this: void) {
    return 1;
  }
  @Get('closed')
  closed(this: void) {
    return 2;
  }
}

describe('@PublicRoute()', () => {
  const r = new Reflector();
  it('marks methods and classes', () => {
    expect(r.getAllAndOverride(PUBLIC_ROUTE, [X.prototype.open, X])).toBe(true);
    expect(
      r.getAllAndOverride(PUBLIC_ROUTE, [X.prototype.closed, X]),
    ).toBeUndefined();
  });
  it('health probes are public (the default-deny AuthGuard must never touch them)', () => {
    expect(r.get(PUBLIC_ROUTE, HealthController)).toBe(true);
  });
});
