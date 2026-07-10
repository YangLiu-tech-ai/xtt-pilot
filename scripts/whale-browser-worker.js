/**
 * whale-browser-worker.js — 半自动 worker（浏览器注入版）
 *
 * 【为什么用浏览器版】
 *   鲸品云租户隔离靠服务端会话(JSESSIONID+Tenant_id cookie)控制，不是 token/organizationIds。
 *   纯 Node worker 用 refresh_token+organizationIds 刷的 token 不带会话租户上下文，跨租户查询返回0/SKU not found。
 *   只有浏览器 tab 当前登录会话的 midstrage-access_token 带正确租户上下文，能上架当前租户商品。
 *
 * 【半自动策略】
 *   worker 只处理"浏览器当前会话所在租户"的任务；其它租户任务留给用户手动切租户后由下轮处理。
 *   - 登出(在/login或无token) → 不硬重登，返回 loggedOut 让 agent 发钉钉告警
 *   - 当前租户任务：查SKU→双轨补库存→上架→report DONE
 *   - 其它租户有积压任务 → 返回 pendingOtherTenants 让 agent 告警提示用户切租户
 *
 * 【注入方式】builtin_browser javascript_tool 在 whale.zwztf.net tab 执行此 IIFE，立即返回；
 *   后台 async 跑，agent 轮询 window.__xttWorker.done 与 .result。
 *
 * 【credential_key → tenantId 映射】与 brands-config.json 保持一致
 */
(function whaleBrowserWorker(){
  const RENDER = 'https://xtt-pilot.onrender.com';
  const KEY = 'worker-key-2026-prod';
  const BASE = ''; // 同源，whale.zwztf.net
  const ONLINE_STOCK = 20, OFFLINE_STOCK = 20;
  // credential_key → tenantId
  const CRED_TENANT = {
    'xq-whale':   '188035768554677',
    'txp-whale':  '188139166811317',
    'csnc-whale': '191411162296725',
  };

  const W = window.__xttWorker = { done:false, phase:'init', result:null, log:[] };
  const isLoggedOut = () => location.pathname.includes('/login') || !localStorage.getItem('midstrage-access_token');
  const getToken = () => { try { return JSON.parse(localStorage.getItem('midstrage-access_token')).data.content; } catch { return null; } };
  const getTenant = () => { try { return JSON.parse(localStorage.getItem('midstrage-tenantId')).data.content; } catch { return null; } };

  async function jfetch(url, {method='GET', body}={}) {
    const h = { 'Authorization': 'Bearer ' + getToken() };
    if (body) h['Content-Type'] = 'application/json';
    const r = await fetch(url, { method, headers:h, body: body?JSON.stringify(body):undefined, credentials:'include' });
    try { return await r.json(); } catch { return null; }
  }
  const rfetch = (path, opt) => fetch(RENDER+path, {method:opt?.method||'GET', headers:{'Content-Type':'application/json','x-internal-key':KEY}, body:opt?.body}).then(r=>r.json());

  async function findSku(barcode, shopId){
    const r = await jfetch(`${BASE}/api/web/gms/b2c/store-goods/page?current=1&size=20&barcode=${encodeURIComponent(barcode)}&organizationIds=${encodeURIComponent(shopId)}`);
    if(!r || r.code!==0) throw new Error('查询失败:'+JSON.stringify(r));
    for(const rec of (r.data?.records||[])){
      if(String(rec.shopId)===String(shopId) && rec.skuList?.length){
        const s=rec.skuList[0];
        return {storeSkuId:s.id,currentStatus:s.saleStatus,isReceiveStock:s.isReceiveStock,currentStock:+s.currentStock||0,safeStock:+s.safeStock||0,availableStock:+s.availableStock||0,offlineStock:+s.offlineStock||0};
      }
    }
    return null;
  }
  async function ensureOnline(storeSkuId){ const r=await jfetch(`${BASE}/api/web/gms/b2c/store-goods/skus/stocks`,{method:'POST',body:{storeSkuId,currentStock:ONLINE_STOCK}}); if(r?.code!==0)throw new Error('补线上库存失败:'+JSON.stringify(r)); return {to:ONLINE_STOCK}; }
  async function ensureOffline(barcode,shopId){ const q=await jfetch(`${BASE}/api/web/gms/b2c/store-goods/stocks/page?size=20&current=1&isSkuCodeFuzzy=0&isBarcodeFuzzy=0&barcode=${encodeURIComponent(barcode)}&organizationIds=${encodeURIComponent(shopId)}`); if(!q||q.code!==0)throw new Error('查库存失败'); const rec=(q.data?.records||[])[0]; if(!rec)return{skipped:'no-record'}; const st=(rec.storeSkuStockList||[])[0]; if(!st)return{skipped:'no-stock'}; const cur=+st.offlineStock||0; if(cur>=OFFLINE_STOCK)return{skipped:'sufficient',cur}; const p=await jfetch(`${BASE}/api/web/gms/b2c/store-goods/stocks/store-sku/stocks`,{method:'PUT',body:{id:st.id,offlineStock:String(OFFLINE_STOCK)}}); if(p?.code!==0)throw new Error('补线下库存失败:'+JSON.stringify(p)); return {from:cur,to:OFFLINE_STOCK}; }
  async function onSale(storeSkuId,shopId){ const r=await jfetch(`${BASE}/api/web/gms/b2c/store-goods/skus/sale-status/on-sale/batch?organizationIds=${encodeURIComponent(shopId)}`,{method:'PUT',body:{storeSkuIds:[storeSkuId],saleStatus:1}}); if(r?.code!==0)throw new Error('上架失败:'+JSON.stringify(r)); return r; }

  async function processTask(t){
    const shopId=t.whale_shop_id;
    if(t.action!=='shelf') return {ok:false,error:'不支持action:'+t.action};
    const sku=await findSku(t.barcode,shopId);
    if(!sku) return {ok:false,error:`SKU not found barcode=${t.barcode} shop=${shopId}`};
    if(sku.currentStatus===1) return {ok:true,skipped:true,reason:'already_on_sale'};
    if(sku.availableStock<=0){
      if(sku.isReceiveStock===0){ await ensureOnline(sku.storeSkuId); }
      else { await ensureOffline(t.barcode,shopId); }
    }
    await onSale(sku.storeSkuId,shopId);
    return {ok:true,operated:true};
  }
  const report=(taskId,success,errorMsg,opType)=>rfetch('/v1/internal/worker/report',{method:'POST',body:JSON.stringify({taskId,success,errorMsg:errorMsg||undefined,operationType:opType||undefined})}).catch(()=>{});

  async function run(){
    try{
      // 1. 登出检查
      if(isLoggedOut()){ W.phase='logged_out'; W.result={loggedOut:true}; W.done=true; return; }
      const curTenant=getTenant();
      // 当前租户 tenantId → credential_key（反查）
      const curCredKey = Object.keys(CRED_TENANT).find(k=>CRED_TENANT[k]===curTenant);
      if(!curCredKey){ W.phase='error'; W.result={error:'未知租户 tenantId='+curTenant}; W.done=true; return; }
      // 2. 只 claim 当前租户任务（Render claim 支持 credentialKey 过滤，不挤占名额）
      const claimed=await rfetch('/v1/internal/worker/claim',{method:'POST',body:JSON.stringify({credentialKey:curCredKey})});
      const mine=claimed.tasks||[];
      W.phase='processing'; W.log.push(`curTenant=${curTenant} cred=${curCredKey} claimed=${mine.length}`);
      // 3. 处理当前租户任务
      let ok=0,skip=0,fail=0; const errs=[];
      for(const t of mine){
        try{
          const r=await processTask(t);
          if(r.ok){ await report(t.id,true,null,r.skipped?'already_on_sale':'operated'); r.skipped?skip++:ok++; }
          else{ await report(t.id,false,r.error); fail++; errs.push(`#${t.id} ${r.error}`); }
        }catch(e){ await report(t.id,false,e.message); fail++; errs.push(`#${t.id} ${e.message}`); }
      }
      // 4. 探测其它租户是否有积压 EXECUTING 任务（用 db-dump 全量查，只统计不处理）
      let pendingOther=[];
      try{
        const dump=await rfetch('/v1/internal/db-dump?table=tasks');
        const rows=dump.rows||[];
        const cnt={};
        for(const r of rows){ if(r.status==='EXECUTING'){ const ck=r.credential_key; if(ck && ck!==curCredKey) cnt[ck]=(cnt[ck]||0)+1; } }
        pendingOther=Object.entries(cnt).map(([ck,count])=>({credential_key:ck,count}));
      }catch{}
      W.phase='done';
      W.result={ curTenant, curCredKey, processed:{ok,skip,fail}, errors:errs, pendingOtherTenants:pendingOther };
      W.done=true;
    }catch(e){ W.phase='error'; W.result={error:e.message}; W.done=true; }
  }
  run();
  return 'whale-browser-worker started';
})();
