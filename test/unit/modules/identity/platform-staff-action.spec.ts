import { Controller, Get, SetMetadata } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as identity from '../../../../src/modules/identity/index.js';
import {
  PLATFORM_STAFF_ACTION,
  PlatformStaffAction,
  hasPlatformStaffAction,
} from '../../../../src/modules/identity/http/platform-staff-action.decorator.js';

@Controller('v1/admin/m')
class OnMethod {
  @PlatformStaffAction()
  @Get()
  a(this: void) {
    return 1;
  }
  @Get('b')
  b(this: void) {
    return 1;
  }
}
@PlatformStaffAction()
@Controller('v1/admin/c')
class OnClass {
  @Get()
  c(this: void) {
    return 1;
  }
}
@Controller('v1/admin/raw')
class RawMetadata {
  @SetMetadata(PLATFORM_STAFF_ACTION, true)
  @Get()
  r(this: void) {
    return 1;
  }
}

describe('@PlatformStaffAction metadata (addendum A1.1, A2; PSA-2, PSA-9)', () => {
  it('handler, class, none; a raw SetMetadata without the guard still reads true (inventory of 6B checks the guard)', () => {
    expect(hasPlatformStaffAction(OnMethod, OnMethod.prototype.a)).toBe(true);
    expect(hasPlatformStaffAction(OnMethod, OnMethod.prototype.b)).toBe(false);
    expect(hasPlatformStaffAction(OnClass, OnClass.prototype.c)).toBe(true);
    expect(hasPlatformStaffAction(RawMetadata, RawMetadata.prototype.r)).toBe(
      true,
    );
  });
  it('PSA-9: identity/index.ts exports the six names of A1.1', () => {
    for (const name of [
      'PlatformStaffAction',
      'PLATFORM_STAFF_ACTION',
      'hasPlatformStaffAction',
      'PlatformAccessAudit',
      'NoopPlatformAccessAudit',
    ] as const)
      expect(identity[name], name).toBeDefined();
    // `PlatformAccessEntry` là kiểu: kiểm bằng nguồn của index (không tồn tại lúc chạy).
    expect(readFileSync('src/modules/identity/index.ts', 'utf8')).toMatch(
      /type PlatformAccessEntry/,
    );
  });
});
