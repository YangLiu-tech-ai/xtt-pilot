import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { applyTheme, Brand, detectBrand } from './theme/brand';
import { getToken } from './api/hq';
import { AppShell } from './components/AppShell';
import { Dashboard } from './pages/Dashboard';
import { ShopDetail } from './pages/ShopDetail';
import { SkuCrossShop } from './pages/SkuCrossShop';
import { MagicLogin } from './pages/MagicLogin';
import { TasksPage } from './pages/TasksPage';
import { MePage } from './pages/MePage';

/**
 * 部署时通过 Vite 的 --base=/csnc/ 等指定基路径
 * import.meta.env.BASE_URL 在生产构建会被替换为对应前缀
 */
const BASE = import.meta.env.BASE_URL || '/';

function Shell({ brand }: { brand: Brand }) {
  const loc = useLocation();
  const nav = useNavigate();
  const active: 'dashboard' | 'tasks' | 'me' =
    loc.pathname.startsWith('/tasks') ? 'tasks'
      : loc.pathname.startsWith('/me') ? 'me'
        : 'dashboard';

  return (
    <AppShell
      brand={brand}
      active={active}
      onNavigate={(k) => nav(`/${k === 'dashboard' ? 'dashboard' : k}`)}
    >
      <Routes>
        <Route path="/dashboard" element={<Dashboard brand={brand} />} />
        <Route path="/shops/:shopId" element={<ShopDetail brand={brand} />} />
        <Route path="/skus" element={<SkuCrossShop brand={brand} />} />
        <Route path="/tasks" element={<TasksPage brand={brand} />} />
        <Route path="/me" element={<MePage brand={brand} />} />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </AppShell>
  );
}

function Gate({ brand }: { brand: Brand }) {
  const loc = useLocation();
  const isLogin = loc.pathname.startsWith('/login');
  // 钉钉群点开是 /csnc/?t=xxx，落到 / + ?t=xxx：有 t 参数无 token → 进 login 消费
  const sp = new URLSearchParams(loc.search);
  const hasMagic = sp.has('t') || sp.has('mt');

  if (isLogin) return <MagicLogin brand={brand} />;
  if (hasMagic) return <Navigate to={`/login${loc.search}`} replace />;
  if (!getToken()) return <Navigate to="/login" replace />;
  return <Shell brand={brand} />;
}

export function App() {
  const [brand, setBrand] = useState<Brand | null>(null);

  useEffect(() => {
    const b = detectBrand();
    applyTheme(b);
    setBrand(b);
  }, []);

  if (!brand) return null;
  return (
    <BrowserRouter basename={BASE}>
      <Gate brand={brand} />
    </BrowserRouter>
  );
}
