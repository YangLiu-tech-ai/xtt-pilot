import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchDashboard, DashboardResp, ShopRanking } from '../api/hq';
import { Card, EmptyState, LoadingSpinner } from '../components/Ui';
import { Brand } from '../theme/brand';

interface Props { brand: Brand }

export function Dashboard({ brand }: Props) {
  const [data, setData] = useState<DashboardResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const nav = useNavigate();

  async function load() {
    try {
      setLoading(true);
      const d = await fetchDashboard();
      setData(d);
      setErr(null);
    } catch (e: any) {
      setErr(e.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);

  if (loading) return <LoadingSpinner />;
  if (err) return <EmptyState title="加载失败" hint={err} />;
  if (!data) return <EmptyState title="暂无数据" />;

  const s = data.summary;
  const attRate = (s.attendance_rate * 100).toFixed(1);
  const attTone = s.attendance_rate < 0.9 ? 'danger' : s.attendance_rate < 0.95 ? 'warn' : 'normal';

  return (
    <div className="p-3 space-y-3">
      {/* 4 核心指标 */}
      <div className="grid grid-cols-2 gap-2">
        <MetricCard label="整体出勤率" value={attRate} unit="%" tone={attTone} />
        <MetricCard label="未出勤 SKU" value={s.missing_sku} unit="件" tone={s.missing_sku > 30 ? 'danger' : 'normal'} />
        <MetricCard label="预估损失" value={fmtMoney(s.loss_gmv)} unit="元" tone={s.loss_gmv > 5000 ? 'danger' : 'normal'} />
        <MetricCard label="红/黄灯店" value={`${s.red_shops}/${s.yellow_shops}`} unit="家" tone={s.red_shops > 0 ? 'danger' : s.yellow_shops > 0 ? 'warn' : 'normal'} />
      </div>

      {/* 门店排行 */}
      <Card>
        <div className="px-3 py-2.5 border-b border-slate-100 flex items-center justify-between">
          <div className="text-sm font-semibold">门店出勤排行</div>
          <button onClick={load} className="text-[11px] text-slate-400">刷新</button>
        </div>
        <div className="divide-y divide-slate-100">
          {data.shops.map((shop, idx) => (
            <ShopRow key={shop.shop_id} rank={idx + 1} shop={shop} onClick={() => nav(`/shops/${shop.shop_id}`)} />
          ))}
          {data.shops.length === 0 && <EmptyState title="今日全部门店达标" />}
        </div>
      </Card>

      <Card>
        <button onClick={() => nav('/skus')} className="w-full px-3 py-3 flex items-center justify-between text-sm">
          <div className="flex items-center gap-2">
            <span className="text-base">{'\u{1F50D}'}</span>
            <span className="font-medium">SKU 跨店在架矩阵</span>
          </div>
          <span className="text-slate-300">{'>'}</span>
        </button>
      </Card>

      <div className="text-center text-[10px] text-slate-400 pt-1">
        数据更新于 {new Date(data.last_updated_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
      </div>
    </div>
  );
}

function MetricCard({ label, value, unit, tone }: { label: string; value: string | number; unit: string; tone: 'normal' | 'warn' | 'danger' }) {
  const numColor = tone === 'danger' ? 'text-red-600' : tone === 'warn' ? 'text-orange-600' : 'text-slate-900';
  return (
    <Card className="px-3 py-2.5">
      <div className="text-[11px] text-slate-500">{label}</div>
      <div className="mt-1 flex items-baseline gap-0.5">
        <div className={`text-2xl font-bold ${numColor}`}>{value}</div>
        {unit && <div className="text-[11px] text-slate-400">{unit}</div>}
      </div>
    </Card>
  );
}

function ShopRow({ rank, shop, onClick }: { rank: number; shop: ShopRanking; onClick: () => void }) {
  const dot = shop.light === 'red' ? 'dot-red' : shop.light === 'yel' ? 'dot-orange' : 'dot-green';
  return (
    <button onClick={onClick} className="w-full text-left px-3 py-2.5 flex items-center gap-2.5 active:bg-slate-50">
      <span className="w-5 text-center text-[11px] text-slate-400">{rank}</span>
      <span className={`inline-block w-2 h-2 rounded-full ${dot}`} />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate">{shop.shop_short_name}</div>
        <div className="text-[11px] text-slate-500 mt-0.5">出勤 {(shop.attendance_rate * 100).toFixed(1)}%</div>
      </div>
      <div className="text-right">
        <div className="text-sm font-bold text-red-600">{shop.missing_sku_cnt}</div>
        <div className="text-[10px] text-slate-400">缺货</div>
      </div>
      <div className="text-right ml-2">
        <div className="text-sm font-semibold text-slate-700">{fmtMoney(shop.loss_gmv)}</div>
        <div className="text-[10px] text-slate-400">损失</div>
      </div>
      <span className="text-slate-300 ml-1">{'>'}</span>
    </button>
  );
}

function fmtMoney(n: number): string {
  if (n >= 10000) return (n / 10000).toFixed(1) + 'w';
  return n.toFixed(0);
}
