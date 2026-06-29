import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { assignTasks, fetchShopMissing, MissingSku } from '../api/hq';
import { Badge, Card, EmptyState, LoadingSpinner } from '../components/Ui';
import { Brand, THEMES } from '../theme/brand';

interface Props { brand: Brand }

export function ShopDetail({ brand }: Props) {
  const { shopId = '' } = useParams();
  const nav = useNavigate();
  const t = THEMES[brand];

  const [items, setItems] = useState<MissingSku[]>([]);
  const [shopMeta, setShopMeta] = useState<{ shop_short_name: string; store_manager_mobile: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [filter, setFilter] = useState<'all' | 'unassigned' | 'assigned'>('unassigned');
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  async function load() {
    try {
      setLoading(true);
      const r = await fetchShopMissing(shopId);
      setItems(r.items);
      setShopMeta({ shop_short_name: r.shop.shop_short_name, store_manager_mobile: r.shop.store_manager_mobile });
      setErr(null);
    } catch (e: any) {
      setErr(e.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { if (shopId) load(); }, [shopId]);

  const filtered = useMemo(() => {
    if (filter === 'unassigned') return items.filter((i) => i.source !== 'hq_assigned' && i.status === 'PENDING');
    if (filter === 'assigned') return items.filter((i) => i.source === 'hq_assigned');
    return items;
  }, [items, filter]);

  function toggle(taskId: number) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(taskId)) n.delete(taskId); else n.add(taskId);
      return n;
    });
  }
  function toggleAll() {
    const assignable = filtered.filter((i) => i.source !== 'hq_assigned').map((i) => i.task_id);
    if (selected.size === assignable.length) setSelected(new Set());
    else setSelected(new Set(assignable));
  }

  async function doAssign() {
    if (selected.size === 0) return;
    const targets = items.filter((i) => selected.has(i.task_id) && i.source !== 'hq_assigned');
    if (targets.length === 0) { setToast('已派单的不能重复派'); return; }
    try {
      setSubmitting(true);
      const r = await assignTasks(
        targets.map((i) => ({
          shop_id: shopId,
          barcode: i.barcode,
          item_name: i.item_name,
          sku: i.sku,
          yesterday_sales: i.yesterday_sales,
          suggest_price: i.suggest_price || i.current_price,
          monthly_sales: i.monthly_sales,
          category: i.category,
          stock: i.stock,
          priority: 'P1',
        }))
      );
      setToast(`已派单 ${r.created_cnt} 条，已 @ 店长`);
      setSelected(new Set());
      await load();
    } catch (e: any) {
      setToast(e.message || '派单失败');
    } finally {
      setSubmitting(false);
      setTimeout(() => setToast(null), 2500);
    }
  }

  if (loading) return <LoadingSpinner />;
  if (err) return <EmptyState title="加载失败" hint={err} />;

  const assignableSelectedCnt = items.filter((i) => selected.has(i.task_id) && i.source !== 'hq_assigned').length;
  const counts = {
    all: items.length,
    unassigned: items.filter((i) => i.source !== 'hq_assigned' && i.status === 'PENDING').length,
    assigned: items.filter((i) => i.source === 'hq_assigned').length,
  };

  return (
    <div className="pb-24">
      <div className="px-3 py-2 flex items-center gap-2 sticky top-0 bg-brand-bg z-10">
        <button onClick={() => nav(-1)} className="text-sm text-slate-500">{'<'} 返回</button>
        <div className="flex-1 text-center text-sm font-semibold truncate">{shopMeta?.shop_short_name || shopId}</div>
        <button onClick={load} className="text-[11px] text-slate-400">刷新</button>
      </div>

      <div className="px-3 mb-2 flex items-center gap-2 text-[12px]">
        {(['unassigned', 'assigned', 'all'] as const).map((k) => (
          <button
            key={k}
            onClick={() => setFilter(k)}
            className={`px-2.5 py-1 rounded-full ${filter === k ? 'bg-brand text-white' : 'bg-white border border-slate-200 text-slate-600'}`}
          >
            {k === 'all' ? '全部' : k === 'unassigned' ? '未派单' : '已派单'}
            <span className="ml-1 opacity-70">({counts[k]})</span>
          </button>
        ))}
        <div className="flex-1" />
        {filter !== 'assigned' && (
          <button onClick={toggleAll} className="text-[11px] text-brand">全选可派</button>
        )}
      </div>

      <div className="px-3 space-y-2">
        {filtered.map((it) => {
          const isAssigned = it.source === 'hq_assigned';
          const checked = selected.has(it.task_id);
          return (
            <Card key={it.task_id} className={`px-3 py-2.5 ${isAssigned ? 'opacity-70' : ''}`}>
              <div className="flex gap-2.5">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={isAssigned}
                  onChange={() => !isAssigned && toggle(it.task_id)}
                  className="mt-1 w-4 h-4"
                  style={{ accentColor: t.color }}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <div className="text-sm font-medium truncate">{it.item_name}</div>
                    {isAssigned && <Badge kind="hq">总部派</Badge>}
                    {it.status && it.status !== 'PENDING' && <Badge kind="neutral">{it.status}</Badge>}
                  </div>
                  <div className="mt-1 flex items-center gap-3 text-[11px] text-slate-500">
                    <span>{it.category || '-'}</span>
                    <span>月售 {it.monthly_sales}</span>
                    <span>昨售 {it.yesterday_sales}</span>
                    <span>¥{(it.current_price || it.suggest_price || 0).toFixed(2)}</span>
                  </div>
                </div>
              </div>
            </Card>
          );
        })}
        {filtered.length === 0 && <EmptyState title={filter === 'assigned' ? '该门店暂无总部派单' : '该门店无缺货'} />}
      </div>

      {selected.size > 0 && (
        <div className="fixed bottom-14 inset-x-0 px-3 py-2 bg-white border-t border-slate-200 shadow-lg z-20">
          <div className="flex items-center gap-2">
            <div className="text-sm">
              <span className="text-slate-500">已选 </span>
              <span className="font-bold text-brand">{assignableSelectedCnt}</span>
              <span className="text-slate-500"> 条</span>
            </div>
            <div className="flex-1" />
            <button
              disabled={submitting || assignableSelectedCnt === 0}
              onClick={doAssign}
              className="bg-brand text-white px-4 py-2 rounded-full text-sm font-medium disabled:opacity-50"
            >
              {submitting ? '派单中...' : `@ 店长派单`}
            </button>
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 bg-slate-900 text-white text-xs px-3 py-1.5 rounded-full z-50">
          {toast}
        </div>
      )}
    </div>
  );
}
