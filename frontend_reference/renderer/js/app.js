import { Visualizer } from "./visualizer.js";
import { TTSPlayer } from "./audio.js";
import { NuviSocket } from "./ws.js";
import { NuviLiveSession } from "./liveAudio.js";
import { NuviWakeWordDetector } from "./wakeWord.js";
import { ScreenShare } from "./screenShare.js";
import { BrowserAgent } from "./browserAgent.js";
import * as sfx from "./sounds.js";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

let BACKEND_URL = "http://127.0.0.1:877";
let WS_URL = "ws://127.0.0.1:877/ws/agent";

const state = {
  settings: null,
  socketOpen: false,
  liveState: "disconnected", // disconnected | connecting | listening | speaking — Myraa parity
};

const visualizer = new Visualizer($("#orb-canvas"));
const ttsPlayer = new TTSPlayer({
  onAmplitude: (a) => visualizer.setAmplitude(a),
  onEnd: () => { visualizer.setState("idle"); setStatus("Tap the orb to awake Nuvi."); },
});

let socket = null;
let liveSession = null;
let browserAgent = null;
let wakeDetector = null;
let screenShare = null;
let memories = [];
// Myraa parity refs for wake word connect handler
let connectHandlerRef = () => {};

// Captions like Myraa: userCaption/modelCaption overlay
let userCaption = "", modelCaption = "";
const captionEl = (() => {
  const c = document.createElement("div");
  c.id = "nuvi-captions";
  c.style.cssText = "position:absolute; left:50%; bottom:132px; transform:translateX(-50%); max-width:680px; width:88%; text-align:center; pointer-events:none; z-index:5; min-height:28px;";
  c.innerHTML = `<div id="nuvi-caption-model" style="font-size:15px; color:var(--text); line-height:1.5; font-weight:300; letter-spacing:0.02em; text-shadow:0 2px 18px rgba(0,0,0,0.85); display:none;"></div><div id="nuvi-caption-user" style="font-family:var(--font-mono); font-size:13px; color:#7dd3fc; display:none; align-items:center; justify-content:center; gap:8px;"></div><div id="nuvi-caption-status" style="font-family:var(--font-mono); font-size:10px; color:var(--text-faint); letter-spacing:0.18em; text-transform:uppercase; display:block;">Tap the orb to awake Nuvi</div>`;
  return c;
})();

// ---------------------------------------------------------------------
// Boot — Myraa parity lifecycle
// ---------------------------------------------------------------------
async function boot(){
  if(window.nuvi?.getBackendUrl){ BACKEND_URL = await window.nuvi.getBackendUrl(); WS_URL = BACKEND_URL.replace("http","ws")+"/ws/agent"; }
  document.addEventListener("click", ()=> sfx.unlockAudio(), {once:true});
  // Inject captions overlay into #stage
  const stage = $("#stage");
  if(stage) stage.appendChild(captionEl);
  setTimeout(()=> sfx.playIntro(),250);
  await loadSettings();
  connectSocket(); // kept for text chat fallback (like Myraa keeps /live + tools)
  initLiveSession();
  initWakeWord();
  initScreenShare();
  wireUI();
  refreshMemoryPanel();
  refreshMyraaMemories();
  injectScreenPIPStyles();
  injectLiveIndicator();
  updateMicBtnVisual();
}

function connectSocket(){
  socket = new NuviSocket(WS_URL, {
    onOpen: ()=>{ state.socketOpen=true; setStatus("Nuvi ready — tap orb to talk (Gemini 3.1 Flash Live)."); },
    onClose: ()=>{ state.socketOpen=false; setStatus("Reconnecting…"); },
    onMessage: handleServerMessage,
  });
}

function initLiveSession(){
  liveSession = new NuviLiveSession({
    onStateChange: (s)=>{
      state.liveState = s;
      if(s==="disconnected"){ userCaption=""; modelCaption=""; visualizer.setState("idle"); updateCaptions(); updateMicBtnVisual(); updateWakeWordState(); }
      else if(s==="connecting"){ visualizer.setState("thinking"); setCaptionsStatus("Connecting to Gemini Live…"); updateMicBtnVisual(); }
      else if(s==="listening"){ visualizer.setState("listening"); setCaptionsStatus("Listening — speak freely…"); updateMicBtnVisual(); }
      else if(s==="speaking"){ visualizer.setState("speaking"); updateMicBtnVisual(); }
    },
    onTranscription: (role, text)=>{
      if(role==="user"){ userCaption=text; modelCaption=""; visualizer.setState("thinking"); updateCaptions(); }
      else if(role==="model"){ modelCaption = (modelCaption||"") + text; userCaption=""; updateCaptions(); }
    },
    onToolCall: (name, args, cb)=>{
      console.log("[Live Tool]", name, args);
      const browserTools=["browserOpen","browserSearch","browserClick","browserMediaControl","browserScroll","browserType","browserGoBack","browserTabAction","openWebsite"];
      if(browserTools.includes(name)){
        if(!browserAgent) browserAgent = new BrowserAgent({ backendUrl: BACKEND_URL, onClose: ()=> browserAgent=null });
        if(!browserAgent.container){
          let start="https://youtube.com";
          if((name==="browserOpen"||name==="openWebsite")&&args.url) start=args.url;
          browserAgent.mount(start);
        }
        const mapped = name==="openWebsite" ? "browserOpen" : name;
        browserAgent.handleToolTrigger(mapped, args, (res)=>{ cb(res); });
      } else if(name==="changeBackground"){
        const c=(args.color||"").toLowerCase();
        const ok=["violet","crimson","emerald","celestial","gold","rose","charcoal"];
        if(ok.includes(c)){
          document.documentElement.setAttribute("data-theme-color", c);
          fetch(`${BACKEND_URL}/api/settings`, {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({theme_color:c})});
          visualizer.refreshTheme(); cb({result:`Theme changed to ${c}`});
        } else cb({error:`Unsupported color ${c}`});
      } else cb({error:`Tool ${name} not implemented`});
    },
    onError: (msg)=>{
      addMessage("tool", `⚠ ${msg}`); sfx.playError(); setCaptionsStatus(msg); setStatus(msg);
    },
    onMemorySync: (updated)=>{
      if(Array.isArray(updated)){ memories=updated; renderMyraaMemories(); addMessage("tool", `🧠 Memory updated (${updated.length})`); }
    }
  });
}

// Myraa parity: wake word always-listening when enabled and live is disconnected
function initWakeWord(){
  wakeDetector = new NuviWakeWordDetector();
}
function updateWakeWordState(){
  if(!wakeDetector || !state.settings) return;
  const enabled = !!state.settings.wake_word_enabled;
  const phrase = state.settings.wake_phrase || "hey nuvi";
  const sens = state.settings.wake_sensitivity ?? 60;
  if(enabled && state.liveState==="disconnected" && NuviWakeWordDetector.isSupported()){
    wakeDetector.start({ phrase, sensitivity: sens, onTriggered: ()=>{
      console.log("[WakeWord] triggered:", phrase);
      wakeDetector.stop();
      connectHandlerRef();
    }});
  } else {
    wakeDetector.stop();
  }
}

function initScreenShare(){
  screenShare = new ScreenShare(()=>liveSession, ()=>BACKEND_URL);
  screenShare.onChange((info)=>{
    const btn=$("#screen-btn");
    if(btn){ btn.classList.toggle("active", info.isSharing && !info.paused); btn.title = info.isSharing ? (info.paused?"Resume screen vision":"Pause screen vision") : "Share screen"; }
    renderScreenPIP(info);
  });
}

function injectScreenPIPStyles(){
  const style=document.createElement("style");
  style.textContent=`
    #nuvi-screen-pip{ position:absolute; bottom:20px; right:20px; width:280px; background:var(--bg-elevated); border:1px solid var(--border); border-radius:14px; padding:12px; backdrop-filter:blur(16px); box-shadow:0 8px 32px rgba(0,0,0,0.4); z-index:50; display:none; flex-direction:column; gap:10px; }
    #nuvi-screen-pip.show{ display:flex; }
    #nuvi-screen-pip video{ width:100%; aspect-ratio:16/9; border-radius:10px; background:#000; object-fit:cover; }
    #nuvi-screen-pip .pip-header{ display:flex; align-items:center; justify-content:space-between; font-family:var(--font-mono); font-size:10px; color:var(--text-dim); }
    #nuvi-screen-pip .pip-indicator{ width:8px; height:8px; border-radius:50%; background:#22c55e; animation:pulse 1.2s infinite; }
    #nuvi-screen-pip .pip-actions{ display:flex; gap:6px; }
    #nuvi-screen-pip button{ flex:1; padding:6px 8px; border-radius:8px; border:1px solid var(--border); background:var(--bg-panel); color:var(--text); font-family:var(--font-mono); font-size:10px; cursor:pointer; }
    #nuvi-captions{ transition: opacity 0.3s ease; }
    @keyframes pulse{0%,100%{opacity:1} 50%{opacity:0.5}}
  `;
  document.head.appendChild(style);
  const pip=document.createElement("div");
  pip.id="nuvi-screen-pip";
  pip.innerHTML=`
    <div class="pip-header"><span style="display:flex; gap:6px; align-items:center;"><span class="pip-indicator"></span> SCREEN VISION</span><button id="pip-close" style="flex:none; width:24px; height:24px; display:flex; align-items:center; justify-content:center; border-radius:8px;">×</button></div>
    <video id="pip-video" autoplay muted playsinline></video>
    <div class="pip-actions">
      <button id="pip-pause">⏸ Pause</button>
      <button id="pip-switch">↻ Switch</button>
      <button id="pip-stop" style="background:rgba(244,63,94,0.15); border-color:rgba(244,63,94,0.3); color:#fca5a5;">■ Stop</button>
    </div>
    <label style="display:flex; align-items:center; justify-content:space-between; font-family:var(--font-mono); font-size:10px; color:var(--text-dim); border-top:1px solid var(--border-soft); padding-top:8px; margin-top:4px;">VISION MODE <input type="checkbox" id="pip-vision-toggle" checked style="accent-color:var(--accent);" /></label>
  `;
  document.body.appendChild(pip);
  pip.querySelector("#pip-close").onclick=()=> screenShare.stop();
  pip.querySelector("#pip-pause").onclick=()=>{
    const btn=pip.querySelector("#pip-pause");
    if(screenShare.paused){ screenShare.resume(); btn.textContent="⏸ Pause"; } else { screenShare.pause(); btn.textContent="▶ Resume"; }
  };
  pip.querySelector("#pip-switch").onclick=()=> screenShare.switchSource();
  pip.querySelector("#pip-stop").onclick=()=> screenShare.stop();
  pip.querySelector("#pip-vision-toggle").onchange=(e)=> screenShare.setVisionMode(e.target.checked);
}
function renderScreenPIP(info){
  const pip=$("#nuvi-screen-pip"); if(!pip) return;
  if(info.isSharing){
    pip.classList.add("show");
    const video=pip.querySelector("#pip-video");
    const stream=screenShare.getStream();
    if(stream && video.srcObject!==stream){ video.srcObject=stream; video.play().catch(()=>{}); }
    pip.querySelector("#pip-vision-toggle").checked = !!info.visionMode;
    if(info.paused) { video.style.opacity="0.35"; video.style.filter="blur(4px)"; } else { video.style.opacity="1"; video.style.filter="none"; }
  } else pip.classList.remove("show");
}
function injectLiveIndicator(){
  const controls=$("#controls"); if(!controls) return;
  const liveDot=document.createElement("div");
  liveDot.id="live-indicator";
  liveDot.style.cssText="position:absolute; top:-28px; left:50%; transform:translateX(-50%); font-family:var(--font-mono); font-size:10px; letter-spacing:0.14em; color:var(--text-faint); display:flex; align-items:center; gap:6px; pointer-events:none;";
  liveDot.innerHTML=`<span id="live-dot" style="width:6px; height:6px; border-radius:50%; background:var(--text-faint);"></span> <span id="live-label">Tap orb to awake</span>`;
  controls.style.position="relative"; controls.prepend(liveDot);
}
function updateMicBtnVisual(){
  const btn=$("#mic-btn"); if(!btn) return;
  const s=state.liveState;
  // Myraa parity: power icon when disconnected, mic when listening, volume when speaking, spinner when connecting
  if(s==="disconnected"){ btn.innerHTML="◯"; btn.title="Awake Nuvi — tap to connect (no hold)"; btn.classList.remove("listening"); }
  else if(s==="connecting"){ btn.innerHTML="◌"; btn.title="Connecting…"; btn.classList.add("listening"); }
  else if(s==="listening"){ btn.innerHTML="●"; btn.title="Listening — just talk, tap again to sleep"; btn.classList.add("listening"); }
  else if(s==="speaking"){ btn.innerHTML="♪"; btn.title="Nuvi speaking…"; btn.classList.add("listening"); }
  const dot=$("#live-dot"), label=$("#live-label");
  if(dot && label){
    if(s==="listening"){ dot.style.background="#22c55e"; dot.style.boxShadow="0 0 8px #22c55e"; label.textContent="Listening — speak freely (no hold)"; label.style.color="#22c55e"; }
    else if(s==="speaking"){ dot.style.background="#a855f7"; label.textContent="Nuvi speaking…"; label.style.color="#a855f7"; }
    else if(s==="connecting"){ dot.style.background="#f59e0b"; label.textContent="Connecting Gemini 3.1 Flash Live…"; label.style.color="#f59e0b"; }
    else { dot.style.background="var(--text-faint)"; dot.style.boxShadow="none"; if(state.settings?.wake_word_enabled) label.textContent=`Wake word "${state.settings.wake_phrase||'hey nuvi'}" active — or tap orb`; else label.textContent="Tap orb to awake — no hold needed"; label.style.color="var(--text-faint)"; }
  }
  // hook analyser tick while live is active
  if(s==="listening" || s==="speaking") hookLiveAnalyser();
}

function setStatus(text){ const el=$("#status-line"); if(el) el.textContent=text; }
// Myraa cinematic captions helpers
function updateCaptions(){
  const mEl=$("#nuvi-caption-model"), uEl=$("#nuvi-caption-user"), sEl=$("#nuvi-caption-status");
  if(modelCaption){ mEl.textContent=modelCaption; mEl.style.display="block"; uEl.style.display="none"; sEl.style.display="none"; }
  else if(userCaption){ uEl.innerHTML=`<span style="width:6px; height:6px; border-radius:50%; background:#22d3ee; display:inline-block; animation:pulse 1s infinite;"></span> “${userCaption}”`; uEl.style.display="flex"; mEl.style.display="none"; sEl.style.display="none"; }
  else { mEl.style.display="none"; uEl.style.display="none"; sEl.style.display="block"; }
}
function setCaptionsStatus(txt){ const sEl=$("#nuvi-caption-status"); if(sEl){ sEl.textContent=txt; sEl.style.display="block"; } $("#nuvi-caption-model").style.display="none"; $("#nuvi-caption-user").style.display="none"; }

function handleServerMessage(msg){
  switch(msg.type){
    case "status": setStatus(msg.text); break;
    case "tool_call": addMessage("tool", `→ ${msg.name}(${summarizeArgs(msg.args)})`); visualizer.setState("thinking"); break;
    case "transcript": addMessage("user", msg.text); break;
    case "reply": addMessage("assistant", msg.text); break;
    case "tts":
      visualizer.setState("speaking");
      if(msg.engine==="browser"){ ttsPlayer.speakBrowser(msg.text, ()=>{ visualizer.setState(state.liveState==="listening"?"listening":"idle"); }); }
      else { const mime=msg.format==="mp3"?"audio/mpeg":"audio/wav"; ttsPlayer.play(msg.audio_b64, mime); }
      break;
    case "error": sfx.playError(); addMessage("tool", `⚠ ${msg.text}`); break;
  }
}
function summarizeArgs(a){ try{ const s=JSON.stringify(a); return s.length>60?s.slice(0,57)+"...":s; }catch{return "";} }
function addMessage(role, text){
  const el=document.createElement("div"); el.className=`msg ${role}`; el.textContent=text;
  const t=$("#transcript"); if(t){ t.appendChild(el); t.scrollTop=t.scrollHeight; }
}

// ---------------------------------------------------------------------
// Myraa parity: single-tap toggle (NO HOLD) — continuous streaming
// ---------------------------------------------------------------------
async function handleToggleConnection(){
  // Clear errors
  setCaptionsStatus("");
  if(state.liveState==="disconnected"){
    // Stop wake word to free mic
    wakeDetector?.stop();
    await liveSession.connect(BACKEND_URL);
    // analyser tick started via onStateChange
    sfx.playListenStart();
  } else {
    liveSession.disconnect();
    sfx.playListenStop();
    // wake word will auto-restart via onStateChange -> updateWakeWordState
  }
}
connectHandlerRef = handleToggleConnection;

function hookLiveAnalyser(){
  let rafId;
  const tick=()=>{
    if(state.liveState==="disconnected") { visualizer.setAmplitude(0); return; }
    let analyser=null;
    if(state.liveState==="speaking" && liveSession.outputAnalyser) analyser=liveSession.outputAnalyser;
    else if(state.liveState==="listening" && liveSession.inputAnalyser) analyser=liveSession.inputAnalyser;
    if(analyser){
      const arr=new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteFrequencyData(arr);
      let sum=0; for(let i=0;i<arr.length;i++) sum+=arr[i];
      visualizer.setAmplitude(sum/arr.length/255);
    }
    rafId=requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// ---------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------
async function loadSettings(){
  const res=await fetch(`${BACKEND_URL}/api/settings`);
  state.settings=await res.json();
  applySettingsToUI();
  await loadVoices();
  updateWakeWordState();
}
function applySettingsToUI(){
  const s=state.settings;
  document.documentElement.setAttribute("data-theme", s.theme || "claude-code");
  if(s.theme_color) document.documentElement.setAttribute("data-theme-color", s.theme_color);
  visualizer.refreshTheme();
  const setVal=(sel,val)=>{ const el=$(sel); if(el) el.value=val||""; };
  setVal("#assistant-name-input", s.assistant_name);
  setVal("#user-name-input", s.user_name);
  const eng=$("#tts-engine-select"); if(eng) eng.value=s.tts_engine||"edge";
  const st=$("#screen-toggle"), cb=$("#camera-toggle"), sb=$("#screen-btn"), camB=$("#camera-btn");
  if(st) st.checked=!!s.screen_vision_enabled;
  if(cb) cb.checked=!!s.camera_vision_enabled;
  if(sb) sb.classList.toggle("active", !!s.screen_vision_enabled);
  if(camB) camB.classList.toggle("active", !!s.camera_vision_enabled);
  const wToggle=$("#wake-toggle"), wPhrase=$("#wake-phrase-input"), wSens=$("#wake-sensitivity"), autoT=$("#autostart-toggle"), animT=$("#animations-toggle");
  if(wToggle) wToggle.checked=!!s.wake_word_enabled;
  if(wPhrase) wPhrase.value=s.wake_phrase||"hey nuvi";
  if(wSens) wSens.value=s.wake_sensitivity ?? 60;
  if(autoT) autoT.checked=!!s.auto_start;
  if(animT) animT.checked=s.animations!==false;
  setBadge("#groq-badge", !!s.groq_api_key);
  setBadge("#gemini-badge", !!s.gemini_api_key);
  $$(".theme-swatch").forEach(el=> el.classList.toggle("active", el.dataset.theme===s.theme));
  updateMicBtnVisual();
}
function setBadge(sel, ok){ const el=$(sel); if(!el) return; el.textContent=ok?"connected":"not set"; el.classList.toggle("ok", ok); el.classList.toggle("off", !ok); }
async function loadVoices(){
  const res=await fetch(`${BACKEND_URL}/api/settings/voices`); const voices=await res.json();
  const engine=$("#tts-engine-select")?.value || "edge";
  const list=engine==="groq"? voices.groq : voices.edge;
  const select=$("#tts-voice-select"); if(!select) return;
  select.innerHTML="";
  (list||[]).forEach(v=>{ const opt=document.createElement("option"); opt.value=v; opt.textContent=v; select.appendChild(opt); });
  if(state.settings?.tts_voice) select.value=state.settings.tts_voice;
}
async function saveSettings(){
  const payload={
    assistant_name: $("#assistant-name-input")?.value || "Nuvi",
    user_name: $("#user-name-input")?.value,
    tts_engine: $("#tts-engine-select")?.value,
    tts_voice: $("#tts-voice-select")?.value,
    screen_vision_enabled: $("#screen-toggle")?.checked,
    camera_vision_enabled: $("#camera-toggle")?.checked,
    wake_word_enabled: $("#wake-toggle")?.checked,
    wake_phrase: $("#wake-phrase-input")?.value,
    wake_sensitivity: parseInt($("#wake-sensitivity")?.value||"60",10),
    auto_start: $("#autostart-toggle")?.checked,
    animations: $("#animations-toggle")?.checked,
  };
  const groqKey=$("#groq-key-input")?.value.trim();
  const geminiKey=$("#gemini-key-input")?.value.trim();
  if(groqKey) payload.groq_api_key=groqKey;
  if(geminiKey) payload.gemini_api_key=geminiKey;
  const res=await fetch(`${BACKEND_URL}/api/settings`, {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(payload)});
  const data=await res.json(); state.settings=data.settings; applySettingsToUI(); sfx.playAck();
  const g=$("#groq-key-input"), gm=$("#gemini-key-input"); if(g) g.value=""; if(gm) gm.value="";
  setStatus("Settings saved."); updateWakeWordState();
}

// ---------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------
async function refreshMemoryPanel(){
  try{
    const res=await fetch(`${BACKEND_URL}/api/memory/profile`);
    const profile=await res.json();
    const el=$("#memory-list"); if(!el) return;
    const entries=Object.entries(profile);
    el.innerHTML=entries.length ? entries.map(([k,v])=>`<div style="margin-bottom:6px;"><strong style="color:var(--text)">${k}:</strong> ${v}</div>`).join("") : "Nothing remembered yet.";
  }catch{}
}
async function refreshMyraaMemories(){
  try{ const res=await fetch(`${BACKEND_URL}/api/memories`); memories=await res.json(); renderMyraaMemories(); }catch{}
}
function renderMyraaMemories(){
  const container=$("#memory-list-myraa"); if(!container) return;
  if(memories.length===0){ container.innerHTML=`<div class="hint">No recollections yet — Nuvi will learn as you chat.</div>`; return; }
  const byCat={}; memories.forEach(m=>{ byCat[m.category]=byCat[m.category]||[]; byCat[m.category].push(m); });
  const order=["identity","preference","goal","project","relationship","emotional","behavior"];
  const labels={identity:"Identity", preference:"Preferences", goal:"Goals", project:"Projects", relationship:"Relationships", emotional:"Emotional", behavior:"Behavior"};
  container.innerHTML=order.map(cat=>{
    const list=byCat[cat]||[]; if(list.length===0) return "";
    return `<div style="margin-bottom:12px;"><div style="font-family:var(--font-mono); font-size:10px; color:var(--accent); letter-spacing:0.1em; margin-bottom:6px;">${labels[cat]} (${list.length})</div>${list.map(m=>`<div style="background:var(--bg-panel); border:1px solid var(--border-soft); border-radius:8px; padding:8px 10px; margin-bottom:6px; display:flex; justify-content:space-between; gap:8px;"><span style="font-size:12px; color:var(--text); line-height:1.4;">${m.text}</span><button data-del="${m.id}" style="flex:none; background:transparent; border:none; color:var(--text-faint); cursor:pointer; font-size:14px;">×</button></div>`).join("")}</div>`;
  }).join("");
  container.querySelectorAll("[data-del]").forEach(btn=> btn.onclick=async ()=>{
    const id=btn.dataset.del;
    await fetch(`${BACKEND_URL}/api/memories/${id}`, {method:"DELETE"});
    memories=memories.filter(m=>m.id!==id); renderMyraaMemories();
  });
}
async function saveMemory(){
  const text=$("#memory-input")?.value.trim();
  const cat=$("#memory-category")?.value || "preference";
  if(!text) return;
  await fetch(`${BACKEND_URL}/api/memories`, {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({category:cat, text})});
  const inp=$("#memory-input"); if(inp) inp.value="";
  sfx.playAck(); refreshMyraaMemories(); refreshMemoryPanel();
}

// ---------------------------------------------------------------------
// UI wiring — Myraa parity: orb is the power button (no hold)
// ---------------------------------------------------------------------
function wireUI(){
  // Orb / mic button — SINGLE TAP toggle, NO HOLD (Myraa handleToggleConnection parity)
  $("#mic-btn")?.addEventListener("click", handleToggleConnection);
  // Also allow clicking the orb canvas itself
  $("#orb-canvas")?.addEventListener("click", handleToggleConnection);
  // Prevent hold behaviour: suppress mousedown long-press menus
  $("#mic-btn")?.addEventListener("mousedown", (e)=> e.preventDefault());

  $("#send-btn")?.addEventListener("click", sendTypedText);
  $("#text-input")?.addEventListener("keydown", (e)=>{ if(e.key==="Enter") sendTypedText(); });
  $("#type-btn")?.addEventListener("click", ()=> $("#text-input")?.focus());
  $$(".tab-btn").forEach(btn=> btn.addEventListener("click", ()=>{
    $$(".tab-btn").forEach(b=>b.classList.remove("active"));
    $$(".panel").forEach(p=>p.classList.remove("active"));
    btn.classList.add("active");
    $(`#${btn.dataset.panel}`)?.classList.add("active");
  }));
  $("#settings-btn")?.addEventListener("click", ()=>{
    $$(".tab-btn").forEach(b=>b.classList.remove("active"));
    $$(".panel").forEach(p=>p.classList.remove("active"));
    document.querySelector('.tab-btn[data-panel="settings-panel"]')?.classList.add("active");
    $("#settings-panel")?.classList.add("active");
  });
  $$(".theme-swatch").forEach(el=> el.addEventListener("click", async ()=>{
    document.documentElement.setAttribute("data-theme", el.dataset.theme);
    visualizer.refreshTheme();
    $$(".theme-swatch").forEach(s=>s.classList.remove("active"));
    el.classList.add("active");
    await fetch(`${BACKEND_URL}/api/settings`, {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({theme: el.dataset.theme})});
  }));
  $("#tts-engine-select")?.addEventListener("change", loadVoices);
  $("#save-settings-btn")?.addEventListener("click", saveSettings);
  $("#memory-save-btn")?.addEventListener("click", saveMemory);
  $("#screen-btn")?.addEventListener("click", async ()=>{
    if(screenShare.isSharing) screenShare.stop();
    else { try{ await screenShare.start(); }catch(e){ addMessage("tool", `⚠ Screen share: ${e.message}`); } }
  });
  $("#camera-btn")?.addEventListener("click", ()=> quickToggle("camera_vision_enabled","#camera-btn","#camera-toggle"));
  $("#wake-toggle")?.addEventListener("change", ()=> saveSettings());
  $("#wake-phrase-input")?.addEventListener("change", ()=> saveSettings());
  $("#wake-sensitivity")?.addEventListener("change", ()=> saveSettings());
  $("#autostart-toggle")?.addEventListener("change", ()=> saveSettings());
  $$("[data-link]").forEach(a=> a.addEventListener("click", (e)=>{ e.preventDefault(); window.nuvi?.openExternal(a.dataset.link); }));
  $("#min-btn")?.addEventListener("click", ()=> window.close());
  $("#close-btn")?.addEventListener("click", ()=> window.close());
  window.addEventListener("keydown", (e)=>{ if(e.key==="Escape" && browserAgent?.container) browserAgent.unmount(); });
  // Spacebar toggles like Myraa power button (when not typing)
  window.addEventListener("keydown", (e)=>{
    if(e.code==="Space" && document.activeElement?.tagName!=="INPUT" && document.activeElement?.tagName!=="TEXTAREA"){
      e.preventDefault(); handleToggleConnection();
    }
  });
}
async function quickToggle(key, btnSel, checkboxSel){
  const newVal=!$(btnSel)?.classList.contains("active");
  $(btnSel)?.classList.toggle("active", newVal);
  const cb=$(checkboxSel); if(cb) cb.checked=newVal;
  await fetch(`${BACKEND_URL}/api/settings`, {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({[key]: newVal})});
}
function sendTypedText(){
  const input=$("#text-input"); const text=input?.value.trim(); if(!text) return;
  addMessage("user", text); input.value=""; visualizer.setState("thinking"); setCaptionsStatus("Sending…");
  socket.sendText(text);
}
boot();
