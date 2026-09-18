import type { Port } from "./domain.js";

function toMinutes(hhmm: string): number {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) throw new Error(`窗口时间格式无效: ${hhmm}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 将 occurred_at 换算为口岸夹具时区的当地“分钟 of day”。 */
export function localMinutesInZone(occurredAt: Date, timeZone: string): { minutes: number; local: string } {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = fmt.formatToParts(occurredAt);
  const hour = Number(parts.find((p) => p.type === "hour")?.value);
  const minute = Number(parts.find((p) => p.type === "minute")?.value);
  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  return { minutes: hour * 60 + minute, local: `${hh}:${mm}` };
}

/**
 * 判断 occurred_at 是否落在口岸任一窗口内。
 * 窗口按口岸夹具时区解释；open > close 的窗口跨午夜（如 21:30–02:30）。
 */
export function withinPortWindow(port: Port, occurredAt: Date): { ok: boolean; localTime: string } {
  const { minutes, local } = localMinutesInZone(occurredAt, port.timezone);
  for (const w of port.windows) {
    const open = toMinutes(w.open);
    const close = toMinutes(w.close);
    if (open <= close) {
      if (minutes >= open && minutes < close) return { ok: true, localTime: local };
    } else {
      // 跨午夜：>= open 或 < close 均属窗口内
      if (minutes >= open || minutes < close) return { ok: true, localTime: local };
    }
  }
  return { ok: false, localTime: local };
}
