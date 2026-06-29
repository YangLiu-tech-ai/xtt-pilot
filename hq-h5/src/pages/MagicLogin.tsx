import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { magicLogin } from '../api/hq';
import { Brand, THEMES } from '../theme/brand';

interface Props { brand: Brand }

export function MagicLogin({ brand }: Props) {
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const t = THEMES[brand];
  const [state, setState] = useState<'loading' | 'ok' | 'fail'>('loading');
  const [msg, setMsg] = useState('');

  useEffect(() => {
    const mt = sp.get('t') || sp.get('mt');
    if (!mt) { setState('fail'); setMsg('链接无效（缺少 token）'); return; }

    magicLogin(mt)
      .then(() => {
        setState('ok');
        setTimeout(() => nav('/dashboard', { replace: true }), 400);
      })
      .catch((e) => {
        setState('fail');
        const m = (e?.message || '').toString();
        if (m.includes('EXPIRED') || m.includes('INVALID_OR_EXPIRED')) setMsg('链接已过期（5 分钟有效），请回群点最新一条');
        else if (m.includes('USED') || m.includes('JTI_ALREADY_USED')) setMsg('该链接已使用过，请回群点最新一条');
        else if (m.includes('NO_HQ_USER')) setMsg('该品牌暂未配置总部账号，请联系管理员');
        else if (m.includes('BRAND')) setMsg('品牌错误：链接与当前页面不匹配');
        else setMsg('登录失败：' + m);
      });
  }, [sp]);

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-6" style={{ background: t.colorBg }}>
      <div className="text-5xl mb-4">{t.emoji}</div>
      <div className="text-lg font-semibold mb-1">{t.shortName}</div>
      <div className="text-xs text-slate-500 mb-10">运营监控移动端</div>

      {state === 'loading' && (
        <>
          <div className="w-7 h-7 border-2 rounded-full animate-spin" style={{ borderColor: t.color, borderTopColor: 'transparent' }} />
          <div className="mt-4 text-sm text-slate-500">正在登录...</div>
        </>
      )}
      {state === 'ok' && <div className="text-sm" style={{ color: t.color }}>登录成功，正在跳转...</div>}
      {state === 'fail' && (
        <div className="text-center">
          <div className="text-2xl mb-2">{'\u26A0\uFE0F'}</div>
          <div className="text-sm text-red-600 mb-1">{msg}</div>
          <div className="text-xs text-slate-400">请回钉钉群打开最新的运营监控链接</div>
        </div>
      )}
    </div>
  );
}
