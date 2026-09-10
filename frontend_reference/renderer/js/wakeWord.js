/**
 * Nuvi Wake Word Detector — port of Myraa's wakeWord.ts
 * Uses Web Speech API (webkitSpeechRecognition), zero deps.
 */
function getSR() {
  if (typeof window==="undefined") return null;
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}
export class NuviWakeWordDetector {
  constructor(){
    this.ctor = getSR();
    this.phrase = "hey nuvi";
    this.sensitivity = 60;
    this.onTriggered = null;
    this.onState = null;
    this.intended = false;
    this.active = false;
    this.lastTrigger = 0;
    this.debounceMs = 4000;
    this.restartTimer = null;
    this.consecutiveErrors = 0;
    this.recognition = null;
  }
  static isSupported(){ return getSR()!==null; }
  start(opts){
    if(!this.ctor){ this.setState("error"); return false; }
    this.phrase = (opts.phrase||"hey nuvi").toLowerCase().trim();
    this.sensitivity = opts.sensitivity ?? this.sensitivity;
    this.onTriggered = opts.onTriggered ?? null;
    this.onState = opts.onState ?? null;
    this.debounceMs = Math.round(7000 - (this.sensitivity/100)*5500);
    this.intended = true; this.consecutiveErrors=0; this.launch(); return true;
  }
  stop(){
    this.intended=false;
    if(this.restartTimer){ clearTimeout(this.restartTimer); this.restartTimer=null; }
    this.teardown(); this.setState("stopped");
  }
  setPhrase(p){ this.phrase=(p||"hey nuvi").toLowerCase().trim(); }
  setSensitivity(v){ this.sensitivity=Math.max(0,Math.min(100,v)); this.debounceMs=Math.round(7000-(this.sensitivity/100)*5500); }
  launch(){
    if(!this.ctor || !this.intended) return;
    this.teardown();
    try{
      const rec = new this.ctor();
      rec.continuous=true; rec.interimResults=true; rec.lang="en-US"; rec.maxAlternatives=3;
      rec.onstart = ()=>{ this.consecutiveErrors=0; this.active=true; this.setState("listening"); };
      rec.onresult = (e)=>{
        for(let i=e.resultIndex;i<e.results.length;i++){
          const res=e.results[i]; if(!res) continue;
          for(let j=0;j<res.length;j++){
            const txt=(res[j]?.transcript||"").toString().toLowerCase();
            if(txt.includes(this.phrase)){ this.fire(); return; }
          }
        }
      };
      rec.onerror = (e)=>{
        const err=e?.error||"unknown";
        if(err==="no-speech"||err==="aborted") return;
        this.consecutiveErrors++; this.setState("error");
      };
      rec.onend = ()=>{
        this.active=false;
        if(!this.intended) return;
        const delay=Math.min(1000*this.consecutiveErrors*2,15000);
        this.restartTimer=setTimeout(()=>this.launch(), Math.max(150,delay));
      };
      this.recognition=rec; rec.start();
    }catch{
      this.setState("error"); this.restartTimer=setTimeout(()=>this.launch(),1000);
    }
  }
  teardown(){
    if(this.recognition){
      try{ this.recognition.onresult=null; this.recognition.onerror=null; this.recognition.onend=null; this.recognition.onstart=null; this.recognition.abort(); }catch{}
      this.recognition=null;
    }
    this.active=false;
  }
  fire(){
    const now=Date.now();
    if(now-this.lastTrigger < this.debounceMs) return;
    this.lastTrigger=now;
    this.playChime(); this.setState("triggered");
    try{ this.onTriggered?.(); }catch{}
  }
  playChime(){
    try{
      const Ctx=window.AudioContext||window.webkitAudioContext; if(!Ctx) return;
      const ctx=new Ctx(); const now=ctx.currentTime;
      [{f:660,t:0},{f:880,t:0.12}].forEach(({f,t})=>{
        const osc=ctx.createOscillator(); const gain=ctx.createGain();
        osc.type="sine"; osc.frequency.value=f;
        gain.gain.setValueAtTime(0.0001, now+t);
        gain.gain.exponentialRampToValueAtTime(0.18, now+t+0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now+t+0.18);
        osc.connect(gain); gain.connect(ctx.destination);
        osc.start(now+t); osc.stop(now+t+0.2);
      });
      setTimeout(()=>ctx.close().catch(()=>{}),600);
    }catch{}
  }
  setState(s){ try{this.onState?.(s);}catch{} }
  get isActive(){ return this.active; }
}
