/**
 * Đọc một số ở `path` trong giá trị config đã parse nhưng chưa có kiểu (tham số `c` của `defineConfigRule`, vd.
 * `RESILIENCE_OVERRIDES`): trả `undefined` khi thiếu nhánh nào hoặc giá trị không phải số, không ném.
 */
export const numberAt = (v: unknown, ...path: string[]): number | undefined => {
  let cur: unknown = v;
  for (const k of path)
    cur =
      typeof cur === 'object' && cur !== null && k in cur
        ? Reflect.get(cur, k)
        : undefined;
  return typeof cur === 'number' ? cur : undefined;
};
