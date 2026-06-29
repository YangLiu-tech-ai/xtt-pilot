/**
 * 三品牌主题配置
 * 通过 detectBrand() 从 URL base path 或 query 中获取当前品牌
 * 主题色通过 CSS variables 注入到 <html> 根，再由 Tailwind 的 var(--brand-color) 消费
 */

export type Brand = 'csnc' | 'xq' | 'txp';

export interface BrandTheme {
  brand: Brand;
  displayName: string;       // 总部全名（顶栏展示）
  shortName: string;         // 简称（标题/loading）
  color: string;             // 主色（hex）
  colorLight: string;        // 浅色
  colorBg: string;           // 背景浅
  emoji: string;             // 顶栏标识
}

export const THEMES: Record<Brand, BrandTheme> = {
  csnc: {
    brand: 'csnc',
    displayName: '成山农场 · 总部运营监控',
    shortName: '成山农场总部',
    color: '#16a34a',
    colorLight: '#86efac',
    colorBg: '#f0fdf4',
    emoji: '\u{1F33E}',
  },
  xq: {
    brand: 'xq',
    displayName: '兴勤超市 · 总部运营监控',
    shortName: '兴勤总部',
    color: '#ea580c',
    colorLight: '#fdba74',
    colorBg: '#fff7ed',
    emoji: '\u{1F6D2}',
  },
  txp: {
    brand: 'txp',
    displayName: '淘小胖 · 总部运营监控',
    shortName: '淘小胖总部',
    color: '#9333ea',
    colorLight: '#d8b4fe',
    colorBg: '#faf5ff',
    emoji: '\u{1F436}',
  },
};

/**
 * 品牌检测优先级：
 *   1) URL path 首段 /csnc/* /xq/* /txp/*   ← 生产部署主路径
 *   2) URL query ?brand=xxx                  ← 开发/Magic Link 调试
 *   3) localStorage 缓存的 last brand        ← 已登录会话回流
 *   4) 默认 csnc
 */
export function detectBrand(): Brand {
  const path = window.location.pathname;
  const m = path.match(/^\/(csnc|xq|txp)(\/|$)/);
  if (m) return m[1] as Brand;

  const q = new URLSearchParams(window.location.search);
  const fromQuery = q.get('brand');
  if (fromQuery === 'csnc' || fromQuery === 'xq' || fromQuery === 'txp') {
    return fromQuery;
  }

  const cached = localStorage.getItem('hq_brand');
  if (cached === 'csnc' || cached === 'xq' || cached === 'txp') {
    return cached;
  }
  return 'csnc';
}

export function applyTheme(brand: Brand) {
  const t = THEMES[brand];
  const root = document.documentElement;
  root.style.setProperty('--brand-color', t.color);
  root.style.setProperty('--brand-light', t.colorLight);
  root.style.setProperty('--brand-bg', t.colorBg);

  // 同步 PWA theme-color 元
  const meta = document.getElementById('theme-color-meta') as HTMLMetaElement | null;
  if (meta) meta.content = t.color;

  document.title = t.displayName;
  localStorage.setItem('hq_brand', brand);
}
