/**
 * HQ H5 · API client
 * 后端路径前缀 /api/hq/*
 *
 * 鉴权：
 *   - URL 上 ?t=<magic-link> → 自动 exchange 拿 session token，写 sessionStorage
 *   - 后续请求 header: x-hq-token: <session-token>
 *
 * 字段对齐 hq-routes.js 的 snake_case 返回
 */

const BASE = '/api/hq';
const SESSION_KEY = 'hq_session_token';
const SESSION_META_KEY = 'hq_session_meta';

// ========== token 管理 ==========
export function getToken(): string | null {
  return sessionStorage.getItem(SESSION_KEY);
}
export function setToken(t: string, meta?: any) {
  sessionStorage.setItem(SESSION_KEY, t);
  if (meta) sessionStorage.setItem(SESSION_META_KEY, JSON.stringify(meta));
}
export function clearToken() {
  sessionStorage.removeItem(SESSION_KEY);
  sessionStorage.removeItem(SESSION_META_KEY);
}
export function getSessionMeta(): any | null {
  try {
    const raw = sessionStorage.getItem(SESSION_META_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

// ========== 基础请求 ==========
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init?.headers as Record<string, string> | undefined),
  };
  if (token) headers['x-hq-token'] = token;
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  if (res.status === 401) {
    clearToken();
    throw new Error('NEED_LOGIN');
  }
  const json = await res.json();
  if (!res.ok || json.ok === false) {
    throw new Error(json.err || `HTTP_${res.status}`);
  }
  return json as T;
}

// ========== 类型定义（对齐 hq-routes 返回） ==========
export interface ShopRanking {
  shop_id: string;
  shop_short_name: string;
  attendance_rate: number;       // 0..1
  missing_sku_cnt: number;
  light: 'red' | 'yel' | 'grn';
  loss_gmv: number;
}

export interface DashboardResp {
  ok: true;
  brand: 'csnc' | 'xq' | 'txp';
  brand_display_name: string;
  date: string;
  summary: {
    attendance_rate: number;
    missing_sku: number;
    loss_gmv: number;
    red_shops: number;
    yellow_shops: number;
  };
  shops: ShopRanking[];
  last_updated_at: string;
}

export interface MissingSku {
  task_id: number;
  sku: string;
  barcode: string;
  item_name: string;
  category: string;
  suggest_price: number;
  yesterday_sales: number;
  stock: number;
  monthly_sales: number;
  current_price: number;
  activity_price: number | null;
  status: string;
  source: 'system' | 'hq_assigned' | null;
  assigned_by: string | null;
  assigned_at: string | null;
  created_at: string;
  pushed_at: string | null;
  acted_at: string | null;
}

export interface ShopDetailResp {
  ok: true;
  shop: {
    shop_id: string;
    shop_short_name: string;
    shop_full_name: string;
    store_manager_mobile: string;
  };
  items: MissingSku[];
}

export interface CrossShopRow {
  shop_id: string;
  shop_short_name: string;
  online: boolean;
  stock: number;
  monthly_sales: number;
  last_seen?: string;
}

export interface CrossShopResp {
  ok: true;
  barcode: string;
  item_name: string;
  shops: CrossShopRow[];
}

export interface AssignItem {
  shop_id: string;
  barcode: string;
  item_name?: string;
  yesterday_sales?: number;
  suggest_price?: number;
  category?: string;
  monthly_sales?: number;
  stock?: number;
  priority?: string;
  sku?: string;
}
export interface AssignResp {
  ok: true;
  batch_id: string;
  created_cnt: number;
  skipped_cnt: number;
  created: Array<{ task_id: number; shop_id: string; barcode: string }>;
  skipped: Array<AssignItem & { reason: string }>;
}

export interface HqTaskRow {
  task_id: number;
  store_id: string;
  store_name: string;
  barcode: string;
  item_name: string;
  status: string;
  source: 'hq_assigned' | 'system';
  assigned_by: string | null;
  assigned_at: string | null;
  pushed_at: string | null;
  acted_at: string | null;
  created_at: string;
  sla_minutes: number | null;
}

// ========== auth ==========
export async function magicLogin(magicToken: string) {
  const r = await request<{
    ok: true; sessionToken: string; exp: number; brand: string;
    displayName: string; role: string; brandConfig: { displayName: string };
  }>('/auth/magic-login', {
    method: 'POST',
    body: JSON.stringify({ token: magicToken }),
  });
  setToken(r.sessionToken, {
    brand: r.brand,
    displayName: r.displayName,
    role: r.role,
    brandDisplay: r.brandConfig?.displayName,
    exp: r.exp,
  });
  return r;
}

// ========== dashboard ==========
export async function fetchDashboard(): Promise<DashboardResp> {
  return request<DashboardResp>('/dashboard');
}

// ========== shop detail ==========
export async function fetchShopMissing(shopId: string): Promise<ShopDetailResp> {
  return request<ShopDetailResp>(`/shops/${encodeURIComponent(shopId)}/missing-skus`);
}

// ========== cross-shop ==========
export async function fetchCrossShop(barcode: string): Promise<CrossShopResp> {
  return request<CrossShopResp>(`/skus/${encodeURIComponent(barcode)}/cross-shop`);
}

// ========== assign ==========
export async function assignTasks(items: AssignItem[]): Promise<AssignResp> {
  return request<AssignResp>('/tasks/assign', {
    method: 'POST',
    body: JSON.stringify({ items }),
  });
}

// ========== tasks list ==========
export async function fetchHqTasks(params: { status?: string; shop_id?: string; days?: number } = {}) {
  const q = new URLSearchParams();
  if (params.status) q.set('status', params.status);
  if (params.shop_id) q.set('shop_id', params.shop_id);
  if (params.days) q.set('days', String(params.days));
  return request<{ ok: true; count: number; tasks: HqTaskRow[] }>(`/tasks?${q.toString()}`);
}
