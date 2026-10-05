import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Button, Tag, Tooltip } from "antd";
import type { RundownItem } from "../types";

interface Props {
  item: RundownItem;
  cumulative: string;
  riskMinutes: number;
  atRisk: boolean;
  riskAcked: boolean;
  locked: boolean;
  canDirect: boolean;
  onStatus: () => void;
  onSkip: () => void;
  onDuration: (delta: number) => void;
  onSignalLost: () => void;
  onRestore: () => void;
  onSwitch: () => void;
  onAckRisk: () => void;
}

const signalColor: Record<string, string> = { 正常: "green", 断: "red", 备播: "orange", 恢复: "blue" };

export function SortableItem({ item, cumulative, riskMinutes, atRisk, riskAcked, locked, canDirect, onStatus, onSkip, onDuration, onSignalLost, onRestore, onSwitch, onAckRisk }: Props) {
  const anchor = Boolean(item.hardStart);
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: item.id, disabled: item.status === "已播出" || anchor });
  const ended = item.status === "已播出" || item.status === "已跳过";
  return (
    <article ref={setNodeRef} className={`rundown-row status-${item.status} ${atRisk ? "risk-row" : ""}`} style={{ transform: CSS.Transform.toString(transform), transition }}>
      <button className="drag-handle" {...attributes} {...listeners} disabled={anchor} title={anchor ? "硬时间锚点，时段锁定" : "拖动排序"}>⠿</button>
      <time>{cumulative}</time>
      <div className="row-main">
        <b>{item.title}
          {anchor && <Tag color="purple" className="inline-tag">硬时间锚点 {item.hardStart}</Tag>}
          {locked && <Tag color="magenta" className="inline-tag">切换中·占用</Tag>}
        </b>
        <small>{item.source} · {item.presenter}
          {item.type === "连线" && item.signal && <Tag color={signalColor[item.signal]} className="inline-tag">信号{item.signal}</Tag>}
          {item.status === "排队补播" && <Tag color="volcano" className="inline-tag">已进补播清单</Tag>}
          {item.status === "备播中" && <Tag color="orange" className="inline-tag">备用覆盖 {item.backupCovered ?? item.duration}/{item.duration} 分钟</Tag>}
        </small>
      </div>
      <Tag color={item.type === "广告" ? "gold" : item.type === "连线" ? "blue" : "geekblue"}>{item.type}</Tag>
      <span>{item.duration} 分钟</span>
      <Tag color={item.status === "已播出" ? "green" : item.status === "已跳过" ? "red" : item.status === "排队补播" ? "volcano" : item.status === "备播中" ? "orange" : "default"}>{item.status}</Tag>
      <div className="row-actions">
        {atRisk && <Tooltip title={riskAcked ? "风险已点名确认" : `赶不上下一硬锚点约 ${riskMinutes} 分钟`}><Button size="small" danger type={riskAcked ? "default" : "primary"} onClick={onAckRisk} disabled={!canDirect}>{riskAcked ? "风险已点名" : `点名风险 +${riskMinutes}′`}</Button></Tooltip>}
        {item.type === "连线" && !ended && <Button size="small" onClick={onSwitch} disabled={locked || !canDirect}>切换信号源</Button>}
        {item.type === "连线" && item.signal !== "断" && !ended && <Button size="small" danger onClick={onSignalLost} disabled={!canDirect}>信号断</Button>}
        {item.type === "连线" && item.signal === "断" && <Button size="small" type="primary" ghost onClick={onRestore} disabled={!canDirect}>信号恢复</Button>}
        <Button size="small" onClick={() => onDuration(-1)} disabled={anchor || !canDirect}>-1</Button>
        <Button size="small" onClick={() => onDuration(1)} disabled={anchor || !canDirect}>+1</Button>
        <Button size="small" type="primary" disabled={ended || !canDirect} onClick={onStatus}>播出</Button>
        <Button size="small" danger disabled={ended || anchor || !canDirect} onClick={onSkip}>取消</Button>
      </div>
    </article>
  );
}
