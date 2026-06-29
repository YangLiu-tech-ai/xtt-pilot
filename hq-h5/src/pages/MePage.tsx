import { useNavigate } from 'react-router-dom';
import { clearToken, getSessionMeta } from '../api/hq';
import { Card } from '../components/Ui';
import { Brand, THEMES } from '../theme/brand';

interface Props { brand: Brand }

export function MePage({ brand }: Props) {
  const t = THEMES[brand];
  const nav = useNavigate();
  const meta = getSessionMeta();

  function logout() {
    clearToken();
    nav('/login', { replace: true });
  }

  return (
    <div className="p-3 space-y-3">
      <Card className="p-4 text-center">
        <div className="text-4xl mb-2">{t.emoji}</div>
        <div className="text-base font-semibold">{meta?.displayName || t.shortName}</div>
        {meta?.brandDisplay && <div className="text-xs text-slate-400 mt-1">{meta.brandDisplay}</div>}
      </Card>

      <Card className="divide-y divide-slate-100">
        <Row label="角色" value={meta?.role || 'viewer'} />
        <Row label="登录方式" value="钉钉群 Magic Link" />
        <Row label="会话有效期" value={meta?.exp ? fmtExp(meta.exp) : '-'} />
      </Card>

      <button onClick={logout} className="w-full bg-white border border-slate-200 rounded-xl py-3 text-sm text-red-500">
        退出登录
      </button>

      <div className="text-center text-[10px] text-slate-400 pt-4">
        新通途·总部运营监控 · v0.1
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="px-4 py-3 flex items-center justify-between text-sm">
      <span className="text-slate-500">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

function fmtExp(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
