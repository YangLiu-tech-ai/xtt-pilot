import React from 'react';

export function Card({ children, className = '' }: React.PropsWithChildren<{ className?: string }>) {
  return (
    <div className={`bg-white rounded-xl shadow-sm border border-slate-100 ${className}`}>{children}</div>
  );
}

export function StatusDot({ level }: { level: 'NORMAL' | 'WARN' | 'CRIT' | 'OK' | 'OVERDUE' }) {
  const cls =
    level === 'CRIT' || level === 'OVERDUE' ? 'dot-red'
      : level === 'WARN' ? 'dot-orange'
        : 'dot-green';
  return <span className={`inline-block w-2 h-2 rounded-full ${cls}`} />;
}

export function Badge({ children, kind = 'neutral' }: React.PropsWithChildren<{ kind?: 'neutral' | 'brand' | 'danger' | 'warn' | 'hq' }>) {
  const base = 'inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium';
  if (kind === 'brand') return <span className={`${base} bg-brand text-white`}>{children}</span>;
  if (kind === 'danger') return <span className={`${base} bg-red-50 text-red-600`}>{children}</span>;
  if (kind === 'warn') return <span className={`${base} bg-orange-50 text-orange-600`}>{children}</span>;
  if (kind === 'hq') return <span className={`${base} bg-purple-50 text-purple-700`}>总部派</span>;
  return <span className={`${base} bg-slate-100 text-slate-600`}>{children}</span>;
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="text-center py-16 text-slate-400">
      <div className="text-4xl mb-2">{'\u{1F4ED}'}</div>
      <div className="text-sm font-medium">{title}</div>
      {hint && <div className="text-xs mt-1">{hint}</div>}
    </div>
  );
}

export function LoadingSpinner() {
  return (
    <div className="flex justify-center py-12">
      <div className="w-6 h-6 border-2 border-brand border-t-transparent rounded-full animate-spin" />
    </div>
  );
}
