/**
 * Nuvi Live Audio Session — Myraa parity.
 * Streams 16k PCM to /live and plays 24k PCM back, with gapless scheduling.
 * Also provides sendVideoFrame for screen sharing.
 */
function floatTo16BitPCM(input) {
  const buffer = new ArrayBuffer(input.length * 2);
  const view = new DataView(buffer);
  let offset = 0;
  for (let i = 0; i < input.length; i++, offset += 2) {
    let s = Math.max(-1, Math.min(1, input[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  return buffer;
}
function pcm16ToFloats(uint8Array) {
  const int16 = new Int16Array(uint8Array.buffer, uint8Array.byteOffset, uint8Array.byteLength / 2);
  const floats = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) floats[i] = int16[i] / 32768.0;
  return floats;
}
function base64ArrayBuffer(ab) {
  let binary = '';
  const bytes = new Uint8Array(ab);
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
function base64ToUint8Array(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export class NuviLiveSession {
  constructor(handlers) {
    this.ws = null;
    this.inputAudioCtx = null;
    this.outputAudioCtx = null;
    this.micStream = null;
    this.micSourceNode = null;
    this.micProcessorNode = null;
    this.inputAnalyser = null;
    this.outputAnalyser = null;
    this.outputGainNode = null;
    this.nextStartTime = 0;
    this.activeSources = [];
    this.currentState = "disconnected";
    this.isActivated = false;
    this.onStateChange = handlers.onStateChange;
    this.onTranscription = handlers.onTranscription;
    this.onToolCall = handlers.onToolCall;
    this.onError = handlers.onError;
    this.onMemorySync = handlers.onMemorySync;
  }
  setState(s) { this.currentState = s; this.onStateChange(s); }
  getState() { return this.currentState; }
  sendVideoFrame(b64) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.currentState !== "disconnected") {
      this.ws.send(JSON.stringify({ type: "video", video: b64 }));
    }
  }
  async connect(backendUrl) {
    if (this.isActivated) return;
    this.isActivated = true;
    this.setState("connecting");
    try {
      const base = backendUrl || "http://127.0.0.1:877";
      const wsUrl = base.replace("http", "ws") + "/live";
      this.ws = new WebSocket(wsUrl);
      this.ws.binaryType = "blob";
      this.ws.onopen = async () => {
        console.log("[Nuvi Live] Connected to /live");
        try {
          if (!this.isActivated) return;
          const AC = window.AudioContext || window.webkitAudioContext;
          if (!AC) throw new Error("Web Audio API missing");
          this.inputAudioCtx = new AC({ sampleRate: 16000 });
          this.outputAudioCtx = new AC({ sampleRate: 24000 });
          if (this.inputAudioCtx.state === "suspended") await this.inputAudioCtx.resume().catch(()=>{});
          if (this.outputAudioCtx.state === "suspended") await this.outputAudioCtx.resume().catch(()=>{});
          this.outputGainNode = this.outputAudioCtx.createGain();
          this.outputAnalyser = this.outputAudioCtx.createAnalyser();
          this.outputAnalyser.fftSize = 256;
          this.outputAnalyser.smoothingTimeConstant = 0.8;
          this.outputGainNode.connect(this.outputAnalyser);
          this.outputAnalyser.connect(this.outputAudioCtx.destination);
          const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }});
          if (!this.isActivated || !this.inputAudioCtx) { stream.getTracks().forEach(t=>t.stop()); return; }
          this.micStream = stream;
          this.inputAnalyser = this.inputAudioCtx.createAnalyser();
          this.inputAnalyser.fftSize = 256;
          this.micSourceNode = this.inputAudioCtx.createMediaStreamSource(this.micStream);
          this.micSourceNode.connect(this.inputAnalyser);
          this.micProcessorNode = this.inputAudioCtx.createScriptProcessor(2048,1,1);
          this.micSourceNode.connect(this.micProcessorNode);
          this.micProcessorNode.connect(this.inputAudioCtx.destination);
          this.micProcessorNode.onaudioprocess = (e) => {
            if (this.currentState==="disconnected" || this.currentState==="connecting") return;
            const data = e.inputBuffer.getChannelData(0);
            const pcm = floatTo16BitPCM(data);
            const b64 = base64ArrayBuffer(pcm);
            if (this.ws && this.ws.readyState===WebSocket.OPEN) this.ws.send(JSON.stringify({ audio: b64 }));
          };
          this.setState("listening");
        } catch (err) {
          console.error("Audio init failed", err);
          this.onError(err.message || "Microphone required");
          this.disconnect();
        }
      };
      this.ws.onmessage = async (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type==="error") { this.onError(data.error); this.disconnect(); return; }
          if (data.type==="status") {
            console.log("[Nuvi Live status]", data.status);
            if (data.status==="connected") this.setState("listening");
            else if (data.status==="session_closed") this.disconnect();
            return;
          }
          if (data.type==="audio" && data.audio) this.playPCM(data.audio);
          if (data.type==="interrupted") this.handleInterruption();
          if (data.type==="turnComplete") setTimeout(()=>{ if(this.activeSources.length===0 && this.currentState==="speaking") this.setState("listening"); },100);
          if (data.type==="transcription") this.onTranscription(data.role, data.text);
          if (data.type==="memory_sync" && data.memories) this.onMemorySync?.(data.memories);
          if (data.type==="toolCall") {
            const {callId, name, args} = data;
            this.onToolCall(name, args, (result)=>{ if(this.ws && this.ws.readyState===WebSocket.OPEN) this.ws.send(JSON.stringify({type:"toolResponse", id:callId, name, output:result})); });
          }
        } catch(e){ console.error("ws parse", e); }
      };
      this.ws.onerror = ()=>{ this.onError("Live connection lost"); this.disconnect(); };
      this.ws.onclose = ()=>{ this.disconnect(); };
    } catch(e){ this.onError(e.message||"Failed to connect"); this.disconnect(); }
  }
  handleInterruption(){
    this.activeSources.forEach(s=>{ try{s.stop()}catch{}});
    this.activeSources=[]; this.nextStartTime=0; this.setState("listening");
  }
  playPCM(b64){
    if(!this.outputAudioCtx || !this.outputGainNode) return;
    try{
      this.setState("speaking");
      const u8 = base64ToUint8Array(b64);
      const floats = pcm16ToFloats(u8);
      const buffer = this.outputAudioCtx.createBuffer(1, floats.length, 24000);
      buffer.getChannelData(0).set(floats);
      const source = this.outputAudioCtx.createBufferSource();
      source.buffer = buffer;
      source.connect(this.outputGainNode);
      const now = this.outputAudioCtx.currentTime;
      if(this.nextStartTime < now) this.nextStartTime = now + 0.03;
      source.start(this.nextStartTime);
      this.nextStartTime += buffer.duration;
      source.onended = ()=>{
        const idx=this.activeSources.indexOf(source);
        if(idx>-1) this.activeSources.splice(idx,1);
        if(this.activeSources.length===0 && this.currentState==="speaking") this.setState("listening");
      };
      this.activeSources.push(source);
    }catch(e){ console.error("PCM play failed", e); }
  }
  disconnect(){
    this.isActivated=false; this.setState("disconnected");
    if(this.ws){ try{this.ws.close()}catch{}; this.ws=null; }
    if(this.micStream){ this.micStream.getTracks().forEach(t=>{try{t.stop()}catch{}}); this.micStream=null; }
    if(this.micProcessorNode){ try{this.micProcessorNode.disconnect()}catch{}; this.micProcessorNode=null; }
    if(this.micSourceNode){ try{this.micSourceNode.disconnect()}catch{}; this.micSourceNode=null; }
    if(this.inputAudioCtx){ try{this.inputAudioCtx.close()}catch{}; this.inputAudioCtx=null; }
    if(this.outputAudioCtx){ try{this.outputAudioCtx.close()}catch{}; this.outputAudioCtx=null; }
    this.activeSources=[]; this.nextStartTime=0; this.inputAnalyser=null; this.outputAnalyser=null; this.outputGainNode=null;
  }
}
