import type { BackupUse, RundownItem, SignalSource } from "../types";

/** 整点新闻、签约广告等带 hardStart 的条目就是硬时间锚点，时段钉死不动 */
export function isAnchor(item: RundownItem): boolean {
  return Boolean(item.hardStart);
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + (m ?? 0);
}

export function hardMinutes(item: RundownItem): number | undefined {
  return item.hardStart ? toMinutes(item.hardStart) : undefined;
}

/**
 * 未播内容按备用源实际覆盖时长重算：
 *  - 已跳过 / 排队补播（等不到备用源）：占位 0，不再把后面的时间往后顶
 *  - 备播中：只占备用源真正顶上的时长，覆盖不全的缺口计入风险
 *  - 已播出：按原时长（历史已发生）
 */
export function effectiveDuration(item: RundownItem): number {
  if (item.status === "已跳过" || item.status === "排队补播") return 0;
  if (item.status === "备播中") return item.backupCovered ?? item.duration;
  return item.duration;
}

export interface ScheduledRow {
  item: RundownItem;
  /** 排程开始时间 HH:mm */
  at: string;
  /** 相对 08:00 的开播分钟数 */
  atMinutes: number;
  /** 实际播完时超出下一个硬锚点多少分钟 */
  riskMinutes: number;
  atRisk: boolean;
}

function fmt(minutes: number): string {
  const wrapped = ((minutes % (24 * 60)) + 24 * 60) % (24 * 60);
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * 硬锚点分段排程：
 * 锚点钉在自己的 hardStart；两个锚点之间的弹性内容从前一锚点开始顺序排，
 * 排不进下一锚点的条目逐条点名为硬时间风险；跳过/补播不占时间，后面整体前移。
 */
export function computeSchedule(items: RundownItem[]): ScheduledRow[] {
  const base = toMinutes("08:00");

  // 切段：[start, end) 弹性内容 + 其后锚点 anchorIndex（-1 表示没有下一锚点）
  const regions: Array<{ start: number; end: number; anchorIndex: number }> = [];
  let i = 0;
  while (i < items.length) {
    if (isAnchor(items[i])) {
      regions.push({ start: i, end: i, anchorIndex: i });
      i += 1;
      continue;
    }
    const start = i;
    while (i < items.length && !isAnchor(items[i])) i += 1;
    regions.push({ start, end: i, anchorIndex: i < items.length ? i : -1 });
    if (i < items.length) i += 1; // 跳过已归入本段的锚点
  }

  const rows: ScheduledRow[] = [];
  let cursor = base;
  for (const region of regions) {
    if (region.anchorIndex === region.start) {
      const item = items[region.anchorIndex];
      const at = hardMinutes(item)!;
      rows.push({ item, at: fmt(at), atMinutes: at, riskMinutes: 0, atRisk: false });
      cursor = at + item.duration;
      continue;
    }

    const endAt = region.anchorIndex >= 0 ? hardMinutes(items[region.anchorIndex])! : Infinity;
    let run = cursor;
    for (let k = region.start; k < region.end; k += 1) {
      const item = items[k];
      const d = effectiveDuration(item);
      const finish = run + d;
      const over = d > 0 && isFinite(endAt) && finish > endAt ? finish - endAt : 0;
      rows.push({ item, at: fmt(run), atMinutes: run, riskMinutes: over, atRisk: over > 0 });
      run = finish;
    }
    if (region.anchorIndex >= 0) {
      const anchor = items[region.anchorIndex];
      const at = hardMinutes(anchor)!;
      rows.push({ item: anchor, at: fmt(at), atMinutes: at, riskMinutes: 0, atRisk: false });
      cursor = at + anchor.duration;
    } else {
      cursor = run;
    }
  }

  return rows;
}

/** 备用源剩余容量（分钟）：总容量 - 已登记占用 */
export function remainingCapacity(source: SignalSource, uses: BackupUse[]): number {
  const used = uses.filter((u) => u.sourceId === source.id).reduce((sum, u) => sum + u.minutes, 0);
  return Math.max(0, source.capacity - used);
}

export interface BackupAssignment {
  uses: Array<Omit<BackupUse, "id" | "itemId" | "at">>;
  /** 备用源合计覆盖分钟数 */
  covered: number;
}

/**
 * 备用源容量分配（贪心，按剩余容量从大到小）：
 * 容量占满前尽量顶；占满后的缺口交给调用方排队进补播清单。
 */
export function planBackup(
  sources: SignalSource[],
  uses: BackupUse[],
  needed: number
): BackupAssignment {
  const pool = sources
    .filter((s) => s.kind === "backup" && s.signal !== "断")
    .map((s) => ({ source: s, remaining: remainingCapacity(s, uses) }))
    .filter((s) => s.remaining > 0)
    .sort((a, b) => b.remaining - a.remaining);

  const assigned: BackupAssignment["uses"] = [];
  let left = needed;
  for (const { source, remaining } of pool) {
    if (left <= 0) break;
    const take = Math.min(remaining, left);
    assigned.push({ sourceId: source.id, minutes: take, reason: "信号中断备用顶播" });
    left -= take;
  }
  return { uses: assigned, covered: needed - left };
}

/** 两条切换是否争用同一条连线或同一个目标信号源 */
export function switchConflicts(
  a: { itemId: string; targetSourceId: string },
  b: { itemId: string; targetSourceId: string }
): boolean {
  return a.itemId === b.itemId || a.targetSourceId === b.targetSourceId;
}

export function describeRisk(row: ScheduledRow): string {
  return `「${row.item.title}」赶不上硬时间锚点，延误约 ${row.riskMinutes} 分钟`;
}
