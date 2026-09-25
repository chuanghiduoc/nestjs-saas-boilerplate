import { CronExpressionParser, type CronExpression } from 'cron-parser';

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 1440;
const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;
const MS_PER_DAY = 86_400_000;
/** Số ngày phía trước được quét để tìm lần đổi offset (DST) của timezone. */
const DST_LOOKAHEAD_DAYS = 366;
/**
 * Cửa sổ quanh mỗi lần đổi offset, tính bằng số lần chạy thật mỗi phía (cron-parser `prev()` /
 * `next()`). Chỉ cặp lần chạy vắt qua lần đổi có khoảng cách thật khác khoảng cách đồng hồ; lấy
 * dư vài lần mỗi phía để phủ cả giờ bị lặp khi fall-back. Chi phí cố định, không phụ thuộc độ
 * dày của cron (quét cả năm `*\/5` tốn ~105k lần `next()`, ~1s).
 */
const DST_RUNS_EACH_SIDE = 4;
/** Độ chính xác khi tìm thời điểm đổi offset bằng chia đôi. */
const TRANSITION_PRECISION_MS = MS_PER_SECOND;
const UTC = 'UTC';
/** Cron tĩnh trong config: 5 trường, hoặc 6 khi có trường giây. */
const CRON_FIELD_COUNTS = [5, 6];

/**
 * Timezone để lưu và gửi cho BullMQ, hoặc `undefined` nếu không phải tên IANA. Hợp lệ khi tên
 * chuẩn Intl của nó là `UTC` hoặc có trong `Intl.supportedValuesOf('timeZone')` (chặn dạng
 * offset `+07:00`). Giữ NGUYÊN tên người dùng nhập, chỉ sửa chữ hoa/thường khi tên chuẩn là
 * cùng một chuỗi: ICU có thể đổi sang tên cũ (`Asia/Ho_Chi_Minh` → `Asia/Saigon`), nên không
 * dùng tên chuẩn để lưu.
 */
export function normalizeTimezone(tz: string): string | undefined {
  let canonical: string;
  try {
    canonical = new Intl.DateTimeFormat('en', {
      timeZone: tz,
    }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
  if (
    canonical !== UTC &&
    !Intl.supportedValuesOf('timeZone').includes(canonical)
  )
    return undefined;
  return canonical.toLowerCase() === tz.toLowerCase() ? canonical : tz;
}

/**
 * cron-parser không tính được lịch chạy quanh một lần đổi offset (ví dụ ném "loop limit
 * exceeded" ở Pacific/Chatham, Australia/Lord_Howe, hoặc trả thời điểm không tăng dần).
 */
export class ScheduleComputationError extends Error {
  constructor(
    readonly tz: string,
    cause: unknown,
  ) {
    super(
      `cron-parser cannot compute runs around a UTC-offset change in "${tz}"`,
      { cause },
    );
    this.name = 'ScheduleComputationError';
  }
}

/** Cron (5 hoặc 6 trường) mà cron-parser — cũng là parser của BullMQ — chấp nhận. */
export function isValidCron(cron: string): boolean {
  if (!CRON_FIELD_COUNTS.includes(cron.trim().split(/\s+/).length))
    return false;
  try {
    CronExpressionParser.parse(cron);
    return true;
  } catch {
    return false;
  }
}

/**
 * Cận dưới của khoảng cách giữa hai lần chạy theo giờ đồng hồ, trên lưới giờ×phút trong ngày,
 * kể cả qua nửa đêm (bảo thủ: giả định hai ngày liên tiếp đều chạy). Bỏ qua trường ngày nên
 * `L`, `#`, dom/dow chỉ làm khoảng cách thật lớn hơn.
 */
function gridMinGapSec(expr: CronExpression): number {
  const { hour, minute } = expr.fields;
  const times = hour.values
    .flatMap((h) => minute.values.map((m) => h * MINUTES_PER_HOUR + m))
    .sort((a, b) => a - b);
  const first = times[0];
  const last = times.at(-1);
  if (first === undefined || last === undefined)
    throw new Error('cron expression has no hour/minute values');
  let gap = MINUTES_PER_DAY - last + first;
  for (let i = 1; i < times.length; i++) {
    const prev = times[i - 1];
    const cur = times[i];
    if (prev !== undefined && cur !== undefined)
      gap = Math.min(gap, cur - prev);
  }
  return gap * SECONDS_PER_MINUTE;
}

/** Các thời điểm (ms, chính xác tới `TRANSITION_PRECISION_MS`) `tz` đổi offset trong `DST_LOOKAHEAD_DAYS` tới. */
function offsetTransitions(tz: string, from: number): number[] {
  const fmt = new Intl.DateTimeFormat('en', {
    timeZone: tz,
    timeZoneName: 'longOffset',
  });
  const offsetAt = (ms: number) =>
    fmt.formatToParts(ms).find((p) => p.type === 'timeZoneName')?.value;
  const out: number[] = [];
  let prev = offsetAt(from);
  for (let d = 1; d <= DST_LOOKAHEAD_DAYS; d++) {
    let hi = from + d * MS_PER_DAY;
    const cur = offsetAt(hi);
    if (cur !== prev) {
      // Chia đôi trong ngày vừa đổi: `lo` còn offset cũ, `hi` đã có offset mới.
      let lo = hi - MS_PER_DAY;
      while (hi - lo > TRANSITION_PRECISION_MS) {
        const mid = Math.floor((lo + hi) / 2);
        if (offsetAt(mid) === prev) lo = mid;
        else hi = mid;
      }
      out.push(hi);
    }
    prev = cur;
  }
  return out;
}

/** Khoảng cách thật nhỏ nhất giữa các lần chạy quanh mỗi lần đổi offset (DST), lặp bằng cron-parser. */
function dstMinGapSec(cron: string, tz: string, from: number): number {
  let gap = Infinity;
  for (const t of offsetTransitions(tz, from)) {
    // `t` sai số tới `TRANSITION_PRECISION_MS` và prev()/next() loại chính mốc bắt đầu: hai
    // cửa sổ gối lên nhau để lần chạy đúng tại thời điểm đổi không bị bỏ sót; trùng được lọc dưới.
    const before = CronExpressionParser.parse(cron, {
      tz,
      currentDate: t + TRANSITION_PRECISION_MS,
    });
    const after = CronExpressionParser.parse(cron, {
      tz,
      currentDate: t - 2 * TRANSITION_PRECISION_MS,
    });
    const earlier: number[] = [];
    const later: number[] = [];
    try {
      for (let i = 0; i < DST_RUNS_EACH_SIDE; i++) {
        earlier.push(before.prev().getTime());
        later.push(after.next().getTime());
      }
    } catch (err) {
      throw new ScheduleComputationError(tz, err);
    }
    // prev() phải giảm dần, next() phải tăng dần; sai thì kết quả không đáng tin.
    if (
      earlier.some((v, i) => i > 0 && v >= (earlier[i - 1] ?? v)) ||
      later.some((v, i) => i > 0 && v <= (later[i - 1] ?? v))
    )
      throw new ScheduleComputationError(
        tz,
        new Error('cron-parser returned non-monotonic run times'),
      );
    const runs = [...earlier, ...later].sort((a, b) => a - b);
    for (let i = 1; i < runs.length; i++) {
      const prev = runs[i - 1];
      const cur = runs[i];
      if (prev !== undefined && cur !== undefined && cur > prev)
        gap = Math.min(gap, (cur - prev) / MS_PER_SECOND);
    }
  }
  return gap;
}

/**
 * Khoảng cách nhỏ nhất giữa hai lần chạy (giây). Lưới giờ×phút là đường nhanh; thêm vào đó các
 * lần chạy thật quanh mỗi lần đổi DST trong năm tới, vì spring-forward làm hai lần chạy ở hai
 * bên giờ bị bỏ qua sát nhau (`0,59 1,3 * * *` ở New York: cách 60s). Lý do không quét cả năm
 * bằng cron-parser: xem ADR 0006.
 *
 * Ném `ScheduleComputationError` khi cron-parser không tính được lịch quanh một lần đổi offset.
 */
export function minGapSec(
  cron: string,
  tz: string,
  from: number = Date.now(),
): number {
  const grid = gridMinGapSec(CronExpressionParser.parse(cron, { tz }));
  return Math.min(grid, dstMinGapSec(cron, tz, from));
}
