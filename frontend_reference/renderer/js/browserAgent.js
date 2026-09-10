/**
 * Nuvi Browser Agent — Myraa parity, Nuvi theme.
 * Vanilla JS overlay that mirrors Myraa's holographic projector:
 * - Tabs, address bar, back/forward/refresh/home
 * - Proxied iframe via /api/web-proxy
 * - Real YouTube search results via /api/youtube-search
 * - Handles live tool triggers (browserOpen, browserSearch, etc.)
 */
export class BrowserAgent {
  constructor({ onClose, backendUrl }){
    this.backendUrl = backendUrl || "http://127.0.0.1:877";
    this.onClose = onClose;
    this.tabs = [];
    this.activeTabId = "";
    this.container = null;
    this.iframe = null;
    this.ytResults = [];
  }
  mount(initialUrl){
    if(this.container) this.unmount();
    const wrap = document.createElement("div");
    wrap.id = "nuvi-browser-overlay";
    wrap.innerHTML = `
      <div style="position:fixed; inset:0; z-index:999; display:flex; align-items:center; justify-content:center; padding:16px; background: rgba(8,8,12,0.85); backdrop-filter:blur(16px);">
        <div style="position:relative; width:100%; max-width:1100px; height:88vh; display:flex; flex-direction:column; border-radius:24px; border:1px solid var(--border-soft, rgba(255,255,255,0.1)); background: var(--bg-elevated, #0f0f12); overflow:hidden; box-shadow:0 0 80px rgba(217,119,87,0.15);">
          <div style="display:flex; align-items:end; gap:6px; padding:12px 16px 6px; border-bottom:1px solid var(--border-soft); background: rgba(0,0,0,0.2);">
            <div id="nuvi-tabs" style="display:flex; gap:6px; overflow-x:auto; flex:1;"></div>
            <button id="nuvi-new-tab" title="New Tab" style="padding:6px 10px; border-radius:10px; border:1px solid var(--border); background:var(--bg-panel); color:var(--text-dim); cursor:pointer; font-size:14px;">＋</button>
            <button id="nuvi-close-overlay" style="margin-left:8px; padding:8px 14px; border-radius:12px; border:1px solid rgba(244,63,94,0.3); background:rgba(244,63,94,0.1); color:#fca5a5; cursor:pointer; font-family:var(--font-mono); font-size:11px;">✕ Close</button>
          </div>
          <div style="display:flex; align-items:center; gap:10px; padding:10px 16px; border-bottom:1px solid var(--border-soft); background:var(--bg-elevated);">
            <button id="nuvi-back" style="padding:8px; border-radius:10px; border:none; background:transparent; color:var(--text-dim); cursor:pointer;">←</button>
            <button id="nuvi-fwd" style="padding:8px; border-radius:10px; border:none; background:transparent; color:var(--text-dim); cursor:pointer;">→</button>
            <button id="nuvi-refresh" style="padding:8px; border-radius:10px; border:none; background:transparent; color:var(--text-dim); cursor:pointer;">↻</button>
            <button id="nuvi-home" style="padding:8px; border-radius:10px; border:none; background:transparent; color:var(--text-dim); cursor:pointer;">⌂</button>
            <form id="nuvi-addr-form" style="flex:1; position:relative; display:flex; align-items:center;">
              <span style="position:absolute; left:12px; color:var(--text-faint); font-size:13px;">🔍</span>
              <input id="nuvi-addr" type="text" placeholder="Type web address or search..." style="width:100%; padding:10px 40px 10px 34px; border-radius:12px; border:1px solid var(--border); background:var(--bg-panel); color:var(--text); font-family:var(--font-mono); font-size:12px; outline:none;" />
              <button type="submit" style="position:absolute; right:8px; background:transparent; border:none; color:var(--text-faint); cursor:pointer; font-family:var(--font-mono); font-size:10px;">GO</button>
            </form>
            <span id="nuvi-diag" style="font-family:var(--font-mono); font-size:10px; color:var(--text-faint);"></span>
          </div>
          <div id="nuvi-body" style="flex:1; position:relative; display:flex; overflow:hidden; background:#07070c;">
            <div id="nuvi-start" style="display:none; flex:1; overflow-y:auto; padding:32px; flex-direction:column; align-items:center; gap:24px; text-align:center;"></div>
            <div id="nuvi-iframe-wrap" style="flex:1; position:relative; display:none;"><iframe id="nuvi-iframe" style="width:100%; height:100%; border:none; background:#07070a;" allow="autoplay; encrypted-media; fullscreen"></iframe><div id="nuvi-loading" style="position:absolute; inset:0; background:rgba(10,10,15,0.85); display:none; flex-direction:column; align-items:center; justify-content:center; gap:12px; backdrop-filter:blur(6px);"><div style="width:40px; height:40px; border:2px solid var(--accent); border-top-color:transparent; border-radius:50%; animation:spin 1s linear infinite;"></div><span style="font-family:var(--font-mono); font-size:10px; color:var(--accent); letter-spacing:0.2em;">LOADING…</span></div></div>
            <div id="nuvi-yt" style="display:none; flex:1; flex-direction:column; overflow:hidden; background:#0a0a0f;"></div>
            <div id="nuvi-restricted" style="display:none; flex:1; flex-direction:column; align-items:center; justify-content:center; padding:24px; text-align:center; gap:16px;"></div>
            <div id="nuvi-error" style="display:none; flex:1; flex-direction:column; align-items:center; justify-content:center; padding:24px; text-align:center; gap:16px;"></div>
          </div>
        </div>
      </div>
      <style>@keyframes spin{to{transform:rotate(360deg)}}</style>
    `;
    document.body.appendChild(wrap);
    this.container = wrap;
    this.iframe = wrap.querySelector("#nuvi-iframe");
    this.iframe.addEventListener("load", ()=>this.onIframeLoad());
    wrap.querySelector("#nuvi-close-overlay").onclick = ()=>this.unmount();
    wrap.querySelector("#nuvi-new-tab").onclick = ()=>this.newTab("about:blank");
    wrap.querySelector("#nuvi-back").onclick = ()=>this.goBack();
    wrap.querySelector("#nuvi-fwd").onclick = ()=>this.goForward();
    wrap.querySelector("#nuvi-refresh").onclick = ()=>this.refresh();
    wrap.querySelector("#nuvi-home").onclick = ()=>this.navigate("about:blank");
    wrap.querySelector("#nuvi-addr-form").onsubmit = (e)=>{ e.preventDefault(); const v=wrap.querySelector("#nuvi-addr").value.trim(); if(v) this.navigate(v); };
    window.addEventListener("message", this._onMessage);
    const url = initialUrl || "about:blank";
    const tab = this.makeTab(url);
    this.tabs=[tab]; this.activeTabId=tab.id;
    this.renderTabs(); this.applyTab(tab);
    // animate in
    wrap.style.opacity="0"; requestAnimationFrame(()=>{ wrap.style.transition="opacity 0.2s ease"; wrap.style.opacity="1"; });
  }
  _onMessage = (e)=>{
    if(e.data && e.data.type==="NAVIGATE" && e.data.url) this.navigate(e.data.url);
  };
  unmount(){
    if(!this.container) return;
    window.removeEventListener("message", this._onMessage);
    this.container.remove(); this.container=null;
    this.onClose?.();
  }
  makeTab(url){
    const id=Math.random().toString(36).slice(2,8);
    return { id, url, title:this.titleFor(url), history:[url], idx:0, loading: url!=="about:blank" };
  }
  titleFor(u){
    if(!u||u==="about:blank") return "Start Page";
    try{ const p=new URL(u); if(p.hostname.includes("youtube")){ if(p.searchParams.get("v")) return "YouTube"; if(p.pathname.includes("results")) return `YouTube: ${p.searchParams.get("search_query")||""}`; return "YouTube"; } if(p.hostname.includes("google")) return "Google"; return p.hostname.replace("www.",""); }catch{return "Portal";}
  }
  isRestricted(u){
    try{
      const p=new URL(u); const h=p.hostname.toLowerCase();
      if(h.includes("youtube.com") && !p.pathname.includes("/embed") && !p.pathname.includes("/results")) return {restricted:true, reason:"YouTube blocks iframe (X-Frame-Options). Opened in native tab."};
      if(h.includes("youtu.be")) return {restricted:true, reason:"youtu.be redirects require native tab."};
      if(h.includes("chatgpt.com")||h.includes("openai.com")) return {restricted:true, reason:"OpenAI requires auth cookies — open in native tab."};
      if(h.includes("gmail.com")||h.includes("mail.google.com")) return {restricted:true, reason:"Gmail requires auth — native tab only."};
      if(h.includes("github.com")) return {restricted:true, reason:"GitHub denies iframe (X-Frame-Options: deny)."};
      if(h.includes("twitter.com")||h.includes("x.com")||h.includes("instagram.com")||h.includes("facebook.com")) return {restricted:true, reason:"Social networks forbid iframe injection."};
      return {restricted:false};
    }catch{ return {restricted:false};}
  }
  renderTabs(){
    const el=this.container.querySelector("#nuvi-tabs");
    el.innerHTML="";
    this.tabs.forEach(t=>{
      const isActive=t.id===this.activeTabId;
      const d=document.createElement("div");
      d.style.cssText=`display:flex; align-items:center; gap:8px; padding:8px 12px; border-radius:10px 10px 0 0; cursor:pointer; font-family:var(--font-mono); font-size:11px; border:1px solid ${isActive?'var(--border)':'transparent'}; background:${isActive?'var(--bg-panel)':'transparent'}; color:${isActive?'var(--text)':'var(--text-faint)'};`;
      d.innerHTML=`<span>🌐</span><span style="max-width:110px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${t.title}</span><button data-close="${t.id}" style="padding:2px 6px; border-radius:6px; border:none; background:transparent; color:inherit; cursor:pointer;">×</button>`;
      d.onclick=(e)=>{ if(e.target.dataset.close) { e.stopPropagation(); this.closeTab(t.id);} else { this.activeTabId=t.id; this.renderTabs(); this.applyTab(t); } };
      el.appendChild(d);
    });
  }
  applyTab(tab){
    const addr=this.container.querySelector("#nuvi-addr");
    addr.value = tab.url==="about:blank" ? "" : tab.url;
    const restricted=this.isRestricted(tab.url);
    const start=this.container.querySelector("#nuvi-start");
    const iframeWrap=this.container.querySelector("#nuvi-iframe-wrap");
    const yt=this.container.querySelector("#nuvi-yt");
    const restrictedEl=this.container.querySelector("#nuvi-restricted");
    const errEl=this.container.querySelector("#nuvi-error");
    [start,iframeWrap,yt,restrictedEl,errEl].forEach(e=>e.style.display="none");
    if(tab.url==="about:blank"){
      start.style.display="flex"; this.renderStart(start);
    } else if(tab.url.includes("youtube.com/results")){
      yt.style.display="flex"; this.renderYouTube(tab);
    } else if(restricted.restricted){
      restrictedEl.style.display="flex"; restrictedEl.innerHTML=`<div style="width:56px; height:56px; border-radius:50%; background:rgba(245,158,11,0.1); border:1px solid rgba(245,158,11,0.3); display:flex; align-items:center; justify-content:center; font-size:22px;">🛡️</div><div style="font-family:var(--font-mono); font-size:10px; letter-spacing:0.3em; color:#f59e0b;">SECURE REDIRECT</div><div style="font-family:var(--font-mono); font-size:11px; color:var(--text); max-width:520px;">${restricted.reason}<br/><span style="color:var(--text-dim)">${tab.url}</span></div><div style="display:flex; gap:10px;"><button id="nuvi-open-native" style="padding:10px 18px; border-radius:12px; border:none; background:var(--accent); color:#1a1a1a; font-family:var(--font-mono); font-size:11px; cursor:pointer;">↗ OPEN NATIVE TAB</button><button id="nuvi-go-home" style="padding:10px 18px; border-radius:12px; border:1px solid var(--border); background:var(--bg-panel); color:var(--text); font-family:var(--font-mono); font-size:11px; cursor:pointer;">HOME</button></div>`;
      try{ window.open(tab.url, "_blank", "noopener,noreferrer"); }catch{}
      restrictedEl.querySelector("#nuvi-open-native").onclick=()=>window.open(tab.url, "_blank");
      restrictedEl.querySelector("#nuvi-go-home").onclick=()=>this.navigate("about:blank");
    } else {
      iframeWrap.style.display="block";
      this.container.querySelector("#nuvi-loading").style.display="flex";
      this.container.querySelector("#nuvi-diag").textContent="LOADING…";
      const src=this.proxyUrl(tab.url);
      this.iframe.src=src;
    }
    this.renderTabs();
  }
  proxyUrl(u){
    if(!u||u==="about:blank") return "about:blank";
    const m=u.match(/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/ ]{11})/i);
    if(m && m[1]) return `https://www.youtube.com/embed/${m[1]}?autoplay=1&enablejsapi=1`;
    if(u.includes("youtube.com/results")) return "about:blank";
    return `${this.backendUrl}/api/web-proxy?url=${encodeURIComponent(u)}`;
  }
  renderStart(el){
    el.innerHTML=`
      <div style="width:64px; height:64px; border-radius:20px; background:rgba(217,119,87,0.1); border:1px solid rgba(217,119,87,0.2); display:flex; align-items:center; justify-content:center; font-size:26px;">🌐</div>
      <div style="font-family:var(--font-mono); font-size:11px; letter-spacing:0.3em; color:var(--accent);">NUVI HOLOGRAPHIC BROWSER</div>
      <div style="color:var(--text-dim); font-size:13px; max-width:420px; line-height:1.6;"> Voice-control a real browser — search, click, scroll, type, all via Nuvi's vision bridge.</div>
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; width:100%; max-width:560px; text-align:left;">
        ${[
          {name:"YouTube", url:"https://youtube.com", icon:"▶", desc:"Media search & embed"},
          {name:"Wikipedia", url:"https://wikipedia.org", icon:"📖", desc:"Global articles"},
          {name:"Google", url:"https://google.com", icon:"🔍", desc:"Search portal"},
          {name:"DuckDuckGo", url:"https://duckduckgo.com", icon:"🦆", desc:"Privacy search"},
          {name:"GitHub", url:"https://github.com", icon:"⭐", desc:"Code & repos"},
          {name:"ChatGPT", url:"https://chatgpt.com", icon:"✨", desc:"AI chat"},
        ].map(s=>`<button data-url="${s.url}" style="padding:14px; border-radius:14px; border:1px solid var(--border-soft); background:var(--bg-panel); text-align:left; cursor:pointer; display:flex; flex-direction:column; gap:6px;"><div style="display:flex; justify-content:space-between; align-items:center;"><span style="font-size:14px;">${s.icon}</span><span style="color:var(--text-faint);">↗</span></div><div style="font-family:var(--font-mono); font-size:11px; color:var(--text);">${s.name}</div><div style="font-size:10px; color:var(--text-faint);">${s.desc}</div></button>`).join("")}
      </div>
    `;
    el.querySelectorAll("[data-url]").forEach(b=> b.onclick=()=> this.navigate(b.dataset.url));
  }
  async renderYouTube(tab){
    const yt=this.container.querySelector("#nuvi-yt");
    yt.innerHTML=`<div style="padding:14px 18px; border-bottom:1px solid var(--border-soft); display:flex; justify-content:space-between; align-items:center; font-family:var(--font-mono); font-size:11px; background:var(--bg-panel);"><span style="display:flex; gap:8px; align-items:center;"><span style="color:#ef4444;">▶</span> YouTube: "${new URL(tab.url).searchParams.get("search_query")||""}"</span><span style="display:flex; gap:6px; align-items:center; color:#22c55e;"><span style="width:8px; height:8px; border-radius:50%; background:#22c55e; display:inline-block; animation:spin 1s infinite;"></span> LIVE</span></div><div id="nuvi-yt-grid" style="flex:1; overflow-y:auto; padding:18px; display:grid; grid-template-columns:repeat(auto-fill, minmax(240px,1fr)); gap:16px;"></div>`;
    const grid=yt.querySelector("#nuvi-yt-grid");
    grid.innerHTML=`<div style="grid-column:1/-1; display:flex; flex-direction:column; align-items:center; gap:12px; padding:40px; color:var(--text-faint); font-family:var(--font-mono); font-size:12px;"><div style="width:32px; height:32px; border:2px solid #ef4444; border-top-color:transparent; border-radius:50%; animation:spin 0.9s linear infinite;"></div> Fetching YouTube…</div>`;
    try{
      const q=new URL(tab.url).searchParams.get("search_query")||"";
      const res=await fetch(`${this.backendUrl}/api/youtube-search?q=${encodeURIComponent(q)}`);
      const data=await res.json();
      const results=data.results||[];
      if(results.length===0) grid.innerHTML=`<div style="grid-column:1/-1; text-align:center; padding:40px; color:var(--text-faint); font-family:var(--font-mono); font-size:12px;">No videos found. Try another query.</div>`;
      else grid.innerHTML=results.map(v=>`<button data-vid="${v.videoId}" style="text-align:left; border-radius:16px; overflow:hidden; border:1px solid var(--border-soft); background:var(--bg-panel); cursor:pointer; display:flex; flex-direction:column; padding:0;"><div style="position:relative; aspect-ratio:16/9; background:#000; overflow:hidden;"><img src="${v.thumbnail}" referrerpolicy="no-referrer" style="width:100%; height:100%; object-fit:cover;" /><span style="position:absolute; right:8px; bottom:8px; background:rgba(0,0,0,0.85); color:#fff; font-family:var(--font-mono); font-size:9px; padding:4px 6px; border-radius:6px;">${v.duration||""}</span></div><div style="padding:12px; display:flex; flex-direction:column; gap:6px;"><div style="font-size:12px; color:var(--text); line-height:1.4; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden;">${v.title}</div><div style="font-family:var(--font-mono); font-size:10px; color:var(--text-faint);">${v.author}</div><div style="display:flex; justify-content:space-between; font-family:var(--font-mono); font-size:9px; color:var(--text-faint); border-top:1px solid var(--border-soft); padding-top:8px;"><span>${v.views||""}</span><span>${v.published||""}</span></div></div></button>`).join("");
      grid.querySelectorAll("[data-vid]").forEach(b=> b.onclick=()=> this.navigate(`https://youtube.com/watch?v=${b.dataset.vid}`));
    }catch(e){ grid.innerHTML=`<div style="grid-column:1/-1; text-align:center; padding:40px; color:#f87171;">Failed: ${e.message}</div>`; }
  }
  onIframeLoad(){
    const wrap=this.container?.querySelector("#nuvi-loading");
    if(wrap) wrap.style.display="none";
    const diag=this.container?.querySelector("#nuvi-diag");
    if(diag) diag.textContent="SECURE";
    // detect proxy error text inside iframe if same-origin
    try{
      const doc=this.iframe.contentDocument;
      const txt=doc?.body?.innerText||"";
      if(txt.includes("Nuvi Web Proxy Error")||txt.includes("Failed loading")){
        this.showError(txt.slice(0,800));
      }
    }catch{}
  }
  showError(msg){
    const err=this.container.querySelector("#nuvi-error");
    this.container.querySelector("#nuvi-iframe-wrap").style.display="none";
    err.style.display="flex";
    err.innerHTML=`<div style="width:56px; height:56px; border-radius:50%; background:rgba(244,63,94,0.1); border:1px solid rgba(244,63,94,0.3); display:flex; align-items:center; justify-content:center; font-size:22px;">⚠️</div><div style="font-family:var(--font-mono); font-size:10px; letter-spacing:0.3em; color:#f87171;">PROXY ERROR</div><div style="font-family:var(--font-mono); font-size:11px; color:var(--text-dim); max-width:600px; text-align:left; background:var(--bg-panel); border:1px solid var(--border-soft); padding:12px; border-radius:12px; max-height:220px; overflow:auto;">${msg}</div><div style="display:flex; gap:10px;"><button id="nuvi-retry-native" style="padding:10px 18px; border-radius:12px; border:none; background:var(--accent); color:#1a1a1a; font-family:var(--font-mono); font-size:11px; cursor:pointer;">↗ NATIVE TAB</button><button id="nuvi-retry-home" style="padding:10px 18px; border-radius:12px; border:1px solid var(--border); background:var(--bg-panel); color:var(--text); font-family:var(--font-mono); font-size:11px; cursor:pointer;">HOME</button></div>`;
    const tab=this.tabs.find(t=>t.id===this.activeTabId);
    err.querySelector("#nuvi-retry-native").onclick=()=>window.open(tab.url, "_blank");
    err.querySelector("#nuvi-retry-home").onclick=()=>this.navigate("about:blank");
  }
  navigate(target){
    let url=target.trim();
    if(url==="about:blank"){ this.commitNav(url); return; }
    const isDomain=/^(https?:\/\/)?([\da-z.-]+)\.([a-z.]{2,6})([\/\w .-]*)*\/?(\?.*)?(#.*)?$/i.test(url);
    if(isDomain){ if(!url.startsWith("http")) url="https://"+url; } else { url=`https://html.duckduckgo.com/html/?q=${encodeURIComponent(url)}`; }
    this.commitNav(url);
  }
  commitNav(url){
    const tab=this.tabs.find(t=>t.id===this.activeTabId);
    if(!tab) return;
    // truncate forward history
    tab.history = tab.history.slice(0, tab.idx+1);
    tab.history.push(url); tab.idx = tab.history.length-1; tab.url=url; tab.title=this.titleFor(url);
    this.applyTab(tab);
  }
  newTab(url="about:blank"){
    const tab=this.makeTab(url);
    this.tabs.push(tab); this.activeTabId=tab.id; this.applyTab(tab); this.renderTabs();
  }
  closeTab(id){
    if(this.tabs.length<=1){ this.unmount(); return; }
    const idx=this.tabs.findIndex(t=>t.id===id);
    this.tabs=this.tabs.filter(t=>t.id!==id);
    if(this.activeTabId===id) this.activeTabId=this.tabs[Math.max(0, idx-1)].id;
    this.renderTabs();
    const active=this.tabs.find(t=>t.id===this.activeTabId);
    if(active) this.applyTab(active);
  }
  goBack(){
    const tab=this.tabs.find(t=>t.id===this.activeTabId);
    if(tab && tab.idx>0){ tab.idx--; tab.url=tab.history[tab.idx]; tab.title=this.titleFor(tab.url); this.applyTab(tab); }
  }
  goForward(){
    const tab=this.tabs.find(t=>t.id===this.activeTabId);
    if(tab && tab.idx < tab.history.length-1){ tab.idx++; tab.url=tab.history[tab.idx]; tab.title=this.titleFor(tab.url); this.applyTab(tab); }
  }
  refresh(){
    if(this.iframe && this.iframe.src) this.iframe.src=this.iframe.src;
  }
  // Live tool trigger dispatcher
  async handleToolTrigger(type, args, callback){
    try{
      switch(type){
        case "browserOpen": { const u=args.url||"https://google.com"; this.navigate(u); callback({result:`Opening ${this.titleFor(u)} for you now.`}); break; }
        case "browserSearch": {
          const q=args.query; if(!q) throw new Error("query required");
          const active=this.tabs.find(t=>t.id===this.activeTabId);
          const isYt=q.toLowerCase().includes("youtube")||q.toLowerCase().includes("video")||(active && active.url.includes("youtube"));
          if(isYt){ const clean=q.replace(/youtube|search|find|play/gi,"").trim(); const url=`https://youtube.com/results?search_query=${encodeURIComponent(clean||q)}`; this.navigate(url); callback({result:`Searching YouTube for "${clean||q}" right away.`}); }
          else { const url=`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`; this.navigate(url); callback({result:`Searching for "${q}" right now.`}); }
          break;
        }
        case "browserGoBack": this.goBack(); callback({result:"Went back."}); break;
        case "browserTabAction": {
          const {action, url: startUrl, tabId}=args;
          if(action==="new"){ this.newTab(startUrl||"about:blank"); callback({result:"Opened new tab."}); }
          else if(action==="close"){ this.closeTab(tabId||this.activeTabId); callback({result:"Closed tab."}); }
          else if(action==="switch"){ if(tabId && this.tabs.some(t=>t.id===tabId)){ this.activeTabId=tabId; this.renderTabs(); this.applyTab(this.tabs.find(t=>t.id===tabId)); callback({result:"Switched tab."}); } else callback({error:"No matching tab"}); }
          break;
        }
        case "browserScroll": {
          const dir=args.direction||"down"; const amt=args.amount||350;
          try{ this.iframe.contentWindow.scrollBy({top: dir==="down"?amt:-amt, behavior:"smooth"}); callback({result:`Scrolled ${dir}`}); }catch{ callback({error:"Cannot scroll"}); }
          break;
        }
        case "browserType": {
          const text=args.text; const win=this.iframe.contentWindow;
          if(win){ const doc=win.document; const el=doc.querySelector('input[type="text"], input[type="search"], textarea, [contenteditable="true"]'); if(el){ el.focus(); if(el instanceof HTMLInputElement||el instanceof HTMLTextAreaElement){ el.value=text; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); } else el.innerText=text; callback({result:`Typed "${text}"`}); } else callback({error:"No input found"}); } else callback({error:"No page"});
          break;
        }
        case "browserClick": {
          const sel=args.selector; const win=this.iframe.contentWindow;
          if(win){ const doc=win.document; let el=doc.querySelector(sel); if(!el){ const cand=Array.from(doc.querySelectorAll('a, button, [role="button"], span, h3')); el=cand.find(e=>e.textContent?.toLowerCase().includes(sel.toLowerCase())); } if(el){ el.click(); callback({result:"Clicked."}); } else callback({error:`Not found ${sel}`}); } else callback({error:"No viewport"});
          break;
        }
        case "browserMediaControl": {
          const action=args.action, value=args.value; const win=this.iframe.contentWindow;
          if(win){ const doc=win.document; const video=doc.querySelector('video'); if(video){ if(action==="play") video.play(); else if(action==="pause") video.pause(); else if(action==="volume") video.volume=value!==undefined?value/100:0.75; else if(action==="mute") video.muted=true; else if(action==="unmute") video.muted=false; else if(action==="skip") video.currentTime+=30; callback({result:`Media ${action}`}); } else { win.postMessage(JSON.stringify({event:"command", func: action==="play"?"playVideo":action==="pause"?"pauseVideo":action==="volume"&&value?"setVolume":"", args: action==="volume"?[value]:[]}), "*"); callback({result:"Sent to YouTube"}); }} else callback({error:"No media"});
          break;
        }
        default: callback({error:`Unknown browser tool ${type}`});
      }
    }catch(e){ callback({error:e.message}); }
  }
}
