import { Button, Card, Progress, Tag } from "antd";
import { useAppDispatch, useAppSelector } from "../store/hooks";
import { signalLost, signalRestore, toggleSourceSignal } from "../store/rundownSlice";
import { remainingCapacity } from "../engine/schedule";

const signalColor: Record<string, string> = { 正常: "green", 断: "red", 占用中: "orange" };

export function SourceBoard() {
  const dispatch = useAppDispatch();
  const { sources, uses, items } = useAppSelector((s) => s.rundown);

  const cut = (sourceId: string) => {
    dispatch(toggleSourceSignal({ sourceId, signal: "断" }));
    // 主源关断：挂在它下面的在播连线全部走"信号中断 → 备用顶播/补播排队"
    items
      .filter((i) => i.type === "连线" && i.sourceId === sourceId && i.signal !== "断")
      .forEach((i) => dispatch(signalLost({ id: i.id, reason: `主源信号关断，备用顶播` })));
  };

  const recover = (sourceId: string) => {
    dispatch(toggleSourceSignal({ sourceId, signal: "正常" }));
    items
      .filter((i) => i.type === "连线" && i.sourceId === sourceId && i.signal === "断")
      .forEach((i) => dispatch(signalRestore({ id: i.id, sourceId })));
  };

  return <div className="source-board">
    {sources.map((source) => {
      const left = source.kind === "backup" ? remainingCapacity(source, uses) : null;
      const usedBy = uses.filter((u) => u.sourceId === source.id);
      return <Card key={source.id} size="small" className={`source-card source-${source.signal}`}
        title={<span>{source.name} <Tag color={source.kind === "backup" ? "gold" : "blue"}>{source.kind === "backup" ? "备用源" : "主源"}</Tag></span>}
        extra={<Tag color={signalColor[source.signal]}>{source.signal}</Tag>}>
        {left !== null && <>
          <Progress percent={Math.round(((source.capacity - left) / source.capacity) * 100)} size="small"
            status={left === 0 ? "exception" : "active"} format={() => `已占 ${source.capacity - left}/${source.capacity} 分钟`} />
          {usedBy.length === 0 && <small className="hint">尚无占用记录</small>}
          {usedBy.map((u) => {
            const owner = items.find((i) => i.id === u.itemId);
            return <small key={u.id} className="usage-line">· {owner?.title ?? u.itemId} 占用 {u.minutes} 分钟（{u.reason}）</small>;
          })}
        </>}
        <div className="source-actions">
          {source.signal === "断"
            ? <Button size="small" onClick={() => recover(source.id)}>恢复信号</Button>
            : <Button size="small" danger onClick={() => cut(source.id)}>关断信号</Button>}
        </div>
      </Card>;
    })}
  </div>;
}
