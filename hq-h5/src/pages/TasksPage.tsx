import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchHqTasks, HqTaskRow } from '../api/hq';
import { Badge, Card, EmptyState, LoadingSpinner, StatusDot } from '../components/Ui';
import { Brand } from '../theme/brand';

interface Props { brand: Brand }

export function TasksPage({ brand }: Props) {
  const nav = useNavigate();
  const [tasks, setTasks] = useState<HqTaskRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<string>('');

  async function load() {
    try {
      setLoading(true);
      const r = await fetchHqTasks({ status: status || undefined, days: 7 });
      setTasks(r.tasks);
    } finally { setLoading(false); }
  }
  useEffect(() => { load(); }, [status]);

  return (
    <div className="p-3 space-y-2">
      <div className="flex items-center gap-2 text-[12px] overflow-x-auto">
        {(['', 'PENDING', 'EXECUTING', 'DONE', 'SHORTAGE'] as const).map((k) => (
          <button
            key={k}
            onClick={() => setStatus(k)}
            className={`px-2.5 py-1 rounded-full whitespace-nowrap ${status === k ? 'bg-brand text-white' : 'bg-white border border-slate-200 text-slate-600'}`}
          >
            {k === '' ? '全部' : k}
          </button>
        ))}
        <div className="flex-1" />
        <button onClick={load} className="text-[11px] text-slate-400 whitespace-nowrap">刷新</button>
      </div>

      {loading ? <LoadingSpinner /> : tasks.length === 0 ? <EmptyState title="近 7 天暂无总部派单" /> : (
        tasks.map((t) => {
          const ageMin = ageMinutes(t.assigned_at || t.created_at);
          const slaLevel = t.status === 'DONE' ? 'OK'
            : ageMin > 240 ? 'OVERDUE'
              : ageMin > 60 ? 'WARN' : 'OK';
          return (
            <Card key={t.task_id} className="px-3 py-2.5">
              <button onClick={() => nav(`/shops/${t.store_id}`)} className="w-full text-left">
                <div className="flex items-center gap-1.5">
                  <StatusDot level={slaLevel === 'OVERDUE' ? 'CRIT' : slaLevel === 'WARN' ? 'WARN' : 'OK'} />
                  <div className="text-sm font-medium truncate flex-1">{t.item_name}</div>
                  <Badge kind="hq">总部派</Badge>
                  <Badge kind={t.status === 'DONE' ? 'neutral' : t.status === 'SHORTAGE' ? 'warn' : 'danger'}>{t.status}</Badge>
                </div>
                <div className="mt-1 flex items-center gap-2 text-[11px] text-slate-500">
                  <span>{t.store_name}</span>
                  <span>·</span>
                  <span>{fmtAge(ageMin)}</span>
                  {t.sla_minutes != null && <span>· 处理用时 {t.sla_minutes}分钟</span>}
                </div>
              </button>
            </Card>
          );
        })
      )}
    </div>
  );
}

function ageMinutes(iso: string | null): number {
  if (!iso) return 0;
  return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
}
function fmtAge(min: number): string {
  if (min < 60) return `${min}分钟前`;
  if (min < 60 * 24) return `${Math.floor(min / 60)}小时前`;
  return `${Math.floor(min / 60 / 24)}天前`;
}
