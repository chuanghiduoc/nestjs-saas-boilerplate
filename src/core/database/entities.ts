import type { EntitySchema } from '@mikro-orm/core';

const schemas: EntitySchema[] = [];

/** Module đăng ký entity lúc import (trước khi DatabaseModule.forRoot khởi tạo ORM). */
export function registerEntities(...list: EntitySchema[]): void {
  for (const s of list) if (!schemas.includes(s)) schemas.push(s);
}
export const allEntities = (): EntitySchema[] => [...schemas];
