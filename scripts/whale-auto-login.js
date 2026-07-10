/**
 * whale-auto-login.js — 鲸品云滑块验证自动登录求解器（浏览器注入版）
 *
 * 【用途】worker 检测到鲸品云被登出（跳转 /login）时，注入此脚本自动完成登录。
 * 【原理】
 *   1. 自动填账号密码（18201062873 / a123456）并点登录
 *   2. 滑块识别用「模板匹配」：把滑块拼图块的非透明像素，在背景图上滑动找最小差异位置
 *   3. 置信度过滤：conf(第二名diff - 第一名diff) < 8 说明匹配不可靠，直接点刷新换图重试
 *   4. 拖拽用 requestAnimationFrame 驱动（独立于外部执行生命周期，不会被 MCP timeout 中断）
 *   5. 拖拽距离 = gapX - 滑块拼图块非透明区最左x + 3px补偿
 *   6. 失败自动刷新换图，最多重试 10 次（单次成功率约50-70%，累积接近100%）
 *
 * 【注入方式】通过 builtin_browser 的 javascript_tool 在 whale.zwztf.net tab 执行本文件内容包裹的 IIFE。
 *   注入后立即返回，登录在后台 async 跑；用 window.__login2 查询进度：
 *   { phase:'init'|'success'|'exhausted'|'error', attempts:N, log:[...] }
 *   轮询 window.__login2.phase === 'success' 或 localStorage['midstrage-refresh_token'] 存在即登录成功。
 *
 * 【关键教训】
 *   - 一次性 left_click_drag 直线拖拽会被滑块识破弹回；必须用带缓动+抖动的轨迹
 *   - JS 里 await sleep 循环拖拽会超 MCP 工具执行时限；必须 rAF 后台跑 + 立即返回
 *   - 缺口识别别用边缘检测/暗度（噪声大）；用滑块像素模板匹配（diff 有清晰峰值）
 *   - dragTo 必须加 setTimeout 超时兜底 resolve，否则 rAF 不触发时整个 async 循环挂死
 */
(function whaleAutoLogin(){
  window.__login2 = {phase:'init', log:[], attempts:0};
  const L = window.__login2;
  const sleep = ms => new Promise(r=>setTimeout(r,ms));
  const isLoggedIn = () => !!localStorage.getItem('midstrage-refresh_token');

  function solveGap(){
    const imgs=[...document.querySelectorAll('img')].filter(i=>i.alt!=='logo');
    const bg=imgs.find(i=>i.naturalWidth>=200), piece=imgs.find(i=>i.naturalWidth<100);
    if(!bg||!piece) return null;
    const W=bg.naturalWidth,H=bg.naturalHeight,PW=piece.naturalWidth;
    const bc=document.createElement('canvas');bc.width=W;bc.height=H;const bx=bc.getContext('2d');bx.drawImage(bg,0,0);const bd=bx.getImageData(0,0,W,H).data;
    const pc=document.createElement('canvas');pc.width=PW;pc.height=H;const px=pc.getContext('2d');px.drawImage(piece,0,0);const pd=px.getImageData(0,0,PW,H).data;
    const pts=[];let minX=PW;for(let y=0;y<H;y++)for(let x=0;x<PW;x++){const idx=(y*PW+x)*4;if(pd[idx+3]>80){pts.push([x,y,0.3*pd[idx]+0.59*pd[idx+1]+0.11*pd[idx+2]]);if(x<minX)minX=x;}}
    const gray=(x,y)=>{const i=(y*W+x)*4;return 0.3*bd[i]+0.59*bd[i+1]+0.11*bd[i+2];};
    let ranked=[];
    for(let off=PW;off<=W-PW;off++){let diff=0;for(const[a,b,g]of pts)diff+=Math.abs(gray(off+a,b)-g);ranked.push({off,diff:diff/pts.length});}
    ranked.sort((a,b)=>a.diff-b.diff);
    return {gapX:ranked[0].off, pieceMinX:minX, diff:Math.round(ranked[0].diff), conf:Math.round(ranked[1].diff-ranked[0].diff)};
  }

  function dragTo(distance){
    return new Promise(resolve=>{
      let done=false; const finish=v=>{if(!done){done=true;resolve(v);}};
      setTimeout(()=>finish(false), 3000);
      const handle=document.querySelector('[class*="verify-move-block"]');
      const bar=document.querySelector('[class*="verify-bar-area"]');
      if(!handle||!bar){finish(false);return;}
      const br=bar.getBoundingClientRect();
      const startX=br.x+18, startY=br.y+br.height/2;
      const fire=(el,t,x,y)=>{const o={bubbles:true,cancelable:true,clientX:x,clientY:y,pointerId:1,isPrimary:true,button:0,view:window};el.dispatchEvent(new PointerEvent(t,o));el.dispatchEvent(new MouseEvent(t.replace('pointer','mouse'),o));};
      fire(handle,'pointerdown',startX,startY);
      const T=650,t0=performance.now();
      function step(now){
        if(done)return; let p=(now-t0)/T;if(p>1)p=1;
        const ease=p<0.8?(p/0.8)*(p/0.8):1-Math.pow((1-p)/0.2,2)*0.08;
        const dx=distance*ease+(Math.random()-0.5)*1.2, y=startY+(Math.random()-0.5)*2;
        document.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,clientX:startX+dx,clientY:y,pointerId:1,isPrimary:true,view:window}));
        document.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:startX+dx,clientY:y,view:window}));
        if(p<1)requestAnimationFrame(step);
        else setTimeout(()=>{const ex=startX+distance;document.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,clientX:ex,clientY:startY,pointerId:1,isPrimary:true,view:window}));document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,clientX:ex,clientY:startY,view:window}));finish(true);},110);
      }
      requestAnimationFrame(step);
    });
  }

  async function run(){
    try{
      const uinp=document.querySelector('input[placeholder*="账号"]');
      const pinp=document.querySelector('input[placeholder*="密码"]');
      if(uinp && !isLoggedIn()){
        const setVal=(el,v)=>{const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;d.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));};
        setVal(uinp,'18201062873'); setVal(pinp,'a123456');
        L.log.push('filled'); await sleep(300);
        const btn=[...document.querySelectorAll('button')].find(b=>b.innerText.includes('登'));
        if(btn){btn.click(); L.log.push('clicked');}
        await sleep(2500);
      }
      for(let a=1;a<=10;a++){
        L.attempts=a;
        if(isLoggedIn()){L.phase='success';L.log.push('SUCCESS@'+a);return;}
        const bg=[...document.querySelectorAll('img')].find(i=>i.alt!=='logo'&&i.naturalWidth>=200);
        if(!bg){L.log.push(a+':no-slider');await sleep(1200);continue;}
        const s=solveGap();
        if(!s){L.log.push(a+':solve-null');await sleep(600);continue;}
        if(s.conf<8){L.log.push(a+':lowconf('+s.conf+')');const rf=document.querySelector('[class*="verify-refresh"]');if(rf)rf.click();await sleep(1200);continue;}
        const dist=s.gapX - s.pieceMinX + 3;
        L.log.push(a+':drag gapX='+s.gapX+' conf='+s.conf+' dist='+dist);
        await dragTo(dist);
        await sleep(2000);
        if(isLoggedIn()){L.phase='success';L.log.push('SUCCESS@'+a);return;}
        const rf=document.querySelector('[class*="verify-refresh"]');if(rf)rf.click();
        L.log.push(a+':failed-refresh'); await sleep(1300);
      }
      L.phase=isLoggedIn()?'success':'exhausted';
    }catch(e){L.phase='error';L.log.push('ERR '+e.message);}
  }
  run();
  return 'whale-auto-login started';
})();
