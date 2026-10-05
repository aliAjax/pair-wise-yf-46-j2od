import { Button, Card, Empty, Tag } from "antd";
import { format } from "date-fns";
import { useAppDispatch, useAppSelector } from "../store/hooks";
import { resolveMakeup } from "../store/rundownSlice";

export function MakeupPage() {
  const dispatch = useAppDispatch();
  const { makeup } = useAppSelector((s) => s.rundown);
  const pending = makeup.filter((m) => m.status === "排队中");
  const done = makeup.filter((m) => m.status === "已处理");

  const section = (title: string, empty: string, list: typeof makeup) => (
    <Card title={title} className="makeup-card">
      {list.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={empty} />}
      <div className="queue-list">
        {list.map((entry) => (
          <article key={entry.id}>
            <Tag color={entry.status === "排队中" ? "volcano" : "default"}>{entry.status}</Tag>
            <div>
              <b>{entry.title}</b>
              <small>{entry.reason} · 缺口 {entry.shortfall} 分钟 · 排队于 {format(new Date(entry.queuedAt), "HH:mm:ss")}</small>
            </div>
            {entry.status === "排队中" && <div className="switch-actions">
              <Button size="small" type="primary" onClick={() => dispatch(resolveMakeup({ makeupId: entry.id, resolved: true }))}>已补播</Button>
              <Button size="small" danger onClick={() => dispatch(resolveMakeup({ makeupId: entry.id, resolved: false }))}>放弃</Button>
            </div>}
          </article>
        ))}
      </div>
    </Card>
  );

  return <div className="page-grid makeup-grid">
    {section(`补播清单（${pending.length}）`, "备用源容量足够，暂无需补播内容", pending)}
    {section("已处理记录", "尚无处理记录", done)}
  </div>;
}
