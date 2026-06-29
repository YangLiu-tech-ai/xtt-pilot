import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CrossShopRow, fetchCrossShop } from '../api/hq';
import { Card, EmptyState, LoadingSpinner } from '../components/Ui';
import { Brand } from '../theme/brand';

interface Props { brand: Brand }

export function SkuCrossShop({ brand }: Props) {
  const nav = useNavigate();

  const [barcode, setBarcode] = useState('');
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<CrossShopRow[]>([]);
  const [itemName, setItemName] = useState('');
  const [err, setErr] = useState<string | null>(null);

  async function search() {
    if (!barcode.trim()) return;
    try {
      setLoading(true);
      setErr(null);
      const r = await fetchCrossShop(barcode.trim());
      setRows(r.shops);
      setItemName(r.item_name);
    } catch (e: any) {
      setErr(e.message || '查询失败');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="pb-20">
      <div className="px-3 py-2 flex items-center gap-2 sticky top-0 bg-brand-bg z-10">
        <button onClick={() => nav(-1)} className="text-sm text-slate-500">{'<'} 返回</button>
        <div className="flex-1 text-center text-sm font-semibold">SKU 跨店矩阵</div>
        <div className="w-12" />
      </div>

      <div className="px-3 space-y-3">
        <Card className="px-3 py-3">
          <div className="text-[11px] text-slate-500 mb-2">输入条码查看本品牌全部门店在架情况</div>
          <div className="flex gap-2">
            <input
              value={barcode}
              onChange={(e) => setBarcode(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && search()}
              placeholder="例如 6901234567890"
              className="flex-1 border border-slate-200 rounded-lg px-3 py-2 text-sm"
            />
            <button
              onClick={search}
              disabled={loading || !barcode.trim()}
              className="bg-brand text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50"
            >
              查询
            </button>
          </div>
        </Card>

        {loading && <LoadingSpinner />}
        {err && <EmptyState title="查询失败" hint={err} />}

        {!loading && rows.length > 0 && (
          <>
            <Card className="px-3 py-2.5">
              <div className="text-[11px] text-slate-500">商品</div>
              <div className="text-sm font-semibold mt-0.5 truncate">{itemName}</div>
              <div className="text-[11px] text-slate-400 mt-0.5">条码 {barcode}</div>
            </Card>

            <Card>
              <div className="px-3 py-2 border-b border-slate-100 flex items-center text-[11px] text-slate-500">
                <div className="flex-1">门店</div>
                <div className="w-12 text-center">在架</div>
                <div className="w-14 text-right">月售</div>
              </div>
              <div className="divide-y divide-slate-100">
                {rows.map((r) => (
                  <div key={r.shop_id} className="px-3 py-2.5 flex items-center text-sm">
                    <div className="flex-1 truncate">{r.shop_short_name}</div>
                    <div className="w-12 text-center">
                      {r.online
                        ? <span className="text-green-600 font-semibold">{'\u2713'}</span>
                        : <span className="text-red-500 font-bold">{'\u2717'}</span>}
                    </div>
                    <div className="w-14 text-right">{r.monthly_sales || '-'}</div>
                  </div>
                ))}
              </div>
            </Card>

            <Card className="px-3 py-2.5">
              <div className="text-[11px] text-slate-500">汇总</div>
              <div className="text-sm mt-1">
                <span className="text-green-600 font-semibold">{rows.filter((r) => r.online).length}</span>
                <span className="text-slate-500"> / {rows.length} 店在架</span>
                <span className="ml-2 text-red-500">{rows.filter((r) => !r.online).length} 店缺</span>
              </div>
            </Card>
          </>
        )}

        {!loading && rows.length === 0 && !err && (
          <div className="pt-8 text-center text-slate-400 text-xs">输入条码后点击查询</div>
        )}
      </div>
    </div>
  );
}
