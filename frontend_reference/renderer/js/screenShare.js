/**
 * Nuvi Screen Share — port of Myraa's screen sharing logic
 * Captures display via getDisplayMedia, sends JPEG frames to live session.
 */
export class ScreenShare {
  constructor(liveSessionRef, backendUrlRef){
    this.liveSessionRef = liveSessionRef;
    this.backendUrlRef = backendUrlRef;
    this.stream = null;
    this.video = null;
    this.canvas = null;
    this.interval = null;
    this.isSharing = false;
    this.paused = false;
    this.visionMode = true;
    this.listeners = new Set();
  }
  onChange(cb){ this.listeners.add(cb); return ()=>this.listeners.delete(cb); }
  emit(){ this.listeners.forEach(cb=>cb({isSharing:this.isSharing, paused:this.paused, visionMode:this.visionMode})); }
  async start(){
    try{
      this.stream = await navigator.mediaDevices.getDisplayMedia({ video:{ width:{ideal:1280}, height:{ideal:720}, frameRate:{ideal:5} }, audio:false });
      this.video = document.createElement("video");
      this.video.srcObject = this.stream;
      this.video.muted = true; this.video.playsInline=true;
      await this.video.play().catch(()=>{});
      this.isSharing=true; this.paused=false;
      this.stream.getVideoTracks()[0].onended = ()=>this.stop();
      this.interval = setInterval(()=>this.capture(), 2000);
      setTimeout(()=>this.capture(), 500);
      this.emit();
    }catch(e){
      console.warn("Screen share failed", e);
      if(e.name!=="NotAllowedError") throw e;
    }
  }
  stop(){
    if(this.interval){ clearInterval(this.interval); this.interval=null; }
    if(this.stream){ this.stream.getTracks().forEach(t=>{try{t.stop()}catch{}}); this.stream=null; }
    if(this.video){ try{this.video.pause()}catch{}; this.video=null; }
    this.isSharing=false; this.paused=false; this.emit();
  }
  pause(){ this.paused=true; this.emit(); }
  resume(){ this.paused=false; setTimeout(()=>this.capture(),100); this.emit(); }
  async switchSource(){
    if(this.stream){ this.stream.getTracks().forEach(t=>{try{t.stop()}catch{}}); }
    await this.start();
  }
  setVisionMode(v){ this.visionMode=v; this.emit(); }
  capture(){
    const video=this.video;
    const session=this.liveSessionRef?.();
    if(!video || this.paused || !this.visionMode || !session) return;
    if(session.getState && session.getState()==="disconnected") return;
    try{
      if(video.videoWidth===0 || video.videoHeight===0) return;
      if(!this.canvas) this.canvas=document.createElement("canvas");
      const canvas=this.canvas, ctx=canvas.getContext("2d");
      if(!ctx) return;
      const maxDim=960;
      let w=video.videoWidth, h=video.videoHeight;
      if(w>maxDim||h>maxDim){ if(w>h){ h=Math.round(h*maxDim/w); w=maxDim; } else { w=Math.round(w*maxDim/h); h=maxDim; } }
      canvas.width=w; canvas.height=h;
      ctx.drawImage(video,0,0,w,h);
      const dataUrl=canvas.toDataURL("image/jpeg",0.55);
      const b64=dataUrl.split(",")[1];
      session.sendVideoFrame?.(b64);
    }catch(e){ console.error("capture failed", e); }
  }
  getStream(){ return this.stream; }
}
