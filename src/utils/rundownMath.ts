import { addMinutes, format } from "date-fns";
import type { RundownItem } from "../types";

export const RUN_START = new Date("2026-10-08T08:00:00");

/** 解析 "HH:mm" 为分钟数 */
export function parseAnchor(hhmm?: string): number | null {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

export function anchorToDate(hhmm: string, start: Date = RUN_START): Date {
  const minutes = parseAnchor(hhmm)!;
  const date = new Date(start);
  date.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return date;
}

/** 备用中的内容按备用源时长计，其余按原时长 */
export function effectiveDuration(item: RundownItem): number {
  return item.signalStatus === "备用中" && item.backupDuration ? item.backupDuration : item.duration;
}

export interface TimelineEntry {
  item: RundownItem;
  /** 预计播出时间 HH:mm */
  at: string;
  /** 硬时间锚点条目（整点新闻、签约广告），时段固定不动 */
  fixed: boolean;
  /** 按备用源时长重算后赶不上下一个硬时间锚点 */
  risk: boolean;
  end: Date;
}

/**
 * 时间线重算：
 * - 硬时间锚点（整点新闻、签约广告）钉死在 hardStart，时段不动；
 * - 锚点之间的未播内容按顺序浮动，备用中的条目按备用源时长重算；
 * - 浮动内容超出下一个锚点即标记 risk（赶不上，点名）。
 */
export function computeTimeline(items: RundownItem[], start: Date = RUN_START): TimelineEntry[] {
  const nextAnchorAfter: (number | null)[] = new Array(items.length).fill(null);
  let next: number | null = null;
  for (let i = items.length - 1; i >= 0; i--) {
    nextAnchorAfter[i] = next;
    const anchor = parseAnchor(items[i].hardStart);
    if (anchor !== null) next = anchor;
  }

  let cursor = start;
  return items.map((item, i) => {
    // 已进补播清单或已取消的内容不占在线时长
    if (item.signalStatus === "补播" || item.status === "已跳过") {
      return { item, at: format(cursor, "HH:mm"), fixed: false, risk: false, end: cursor };
    }
    const anchor = parseAnchor(item.hardStart);
    if (anchor !== null) {
      cursor = anchorToDate(item.hardStart!, start);
      return { item, at: item.hardStart!, fixed: true, risk: false, end: cursor };
    }
    const at = cursor;
    const end = addMinutes(cursor, effectiveDuration(item));
    const nextAnchor = nextAnchorAfter[i];
    const risk = nextAnchor !== null && end.getHours() * 60 + end.getMinutes() > nextAnchor;
    cursor = end;
    return { item, at: format(at, "HH:mm"), fixed: false, risk, end };
  });
}

/** 重算后赶不上硬时间锚点的条目标题（点名用） */
export function riskTitles(items: RundownItem[]): string[] {
  return computeTimeline(items).filter((entry) => entry.risk).map((entry) => entry.item.title);
}
