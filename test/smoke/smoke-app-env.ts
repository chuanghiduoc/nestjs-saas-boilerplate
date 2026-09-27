/**
 * Config production bổ sung của module cho container app (plan SP2: Task 43 thêm identity + notifications,
 * Task 46 thêm dashboard). Giá trị test, không phải default của app.
 */
export const smokeAppEnv = (_s: {
  secret: (bytes?: number) => string;
}): Record<string, string> => ({});
