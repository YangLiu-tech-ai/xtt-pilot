import { useEffect, useState } from 'react';
import { THEMES, Brand } from '../theme/brand';

interface Props {
  brand: Brand;
  active: 'dashboard' | 'tasks' | 'me';
  onNavigate: (k: 'dashboard' | 'tasks' | 'me') => void;
}

export function AppShell({ brand, active, onNavigate, children }: React.PropsWithChildren<Props>) {
  const t = THEMES[brand];
  const [time, setTime] = useState(new Date());

  useEffect(() => {
    const id = setInterval(() => setTime(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="min-h-screen flex flex-col" style={{ background: t.colorBg }}>
      {/* TopBar */}
      <header className="bg-brand text-white px-4 py-3 sticky top-0 z-30 shadow-sm">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xl">{t.emoji}</span>
            <div>
              <div className="text-[15px] font-semibold leading-tight">{t.displayName}</div>
              <div className="text-[11px] opacity-80">
                {time.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })} · 实时
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* Content */}
      <main className="flex-1 overflow-y-auto pb-20">{children}</main>

      {/* Bottom Nav */}
      <nav className="fixed bottom-0 inset-x-0 bg-white border-t border-slate-200 flex z-30">
        {[
          { k: 'dashboard', label: '盯盘', icon: '\u{1F4CA}' },
          { k: 'tasks', label: '派单', icon: '\u{1F4DD}' },
          { k: 'me', label: '我的', icon: '\u{1F464}' },
        ].map((tab) => {
          const isActive = active === tab.k;
          return (
            <button
              key={tab.k}
              onClick={() => onNavigate(tab.k as 'dashboard' | 'tasks' | 'me')}
              className="flex-1 py-2 flex flex-col items-center text-[11px]"
              style={{ color: isActive ? t.color : '#64748b' }}
            >
              <span className="text-lg leading-none">{tab.icon}</span>
              <span className="mt-0.5">{tab.label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}
