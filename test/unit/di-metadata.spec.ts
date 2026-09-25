import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';

@Injectable()
class Dependency {}

@Injectable()
class Consumer {
  constructor(readonly dep: Dependency) {}
}

describe('SWC decorator metadata', () => {
  it('injects constructor dependencies by type', async () => {
    const mod = await Test.createTestingModule({
      providers: [Dependency, Consumer],
    }).compile();
    expect(mod.get(Consumer).dep).toBeInstanceOf(Dependency);
  });
});
