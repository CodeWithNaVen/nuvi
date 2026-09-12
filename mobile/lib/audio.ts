/**
 * Mobile audio session for NUVI Live API.
 * Adapted from src/lib/audio.ts for React Native / Expo.
 * - Web (Expo web): uses Web Audio API same as desktop.
 * - Native (iOS/Android): uses expo-audio for 16kHz capture + 24kHz playback (fallback to Web API where possible).
 * - Exposes LiveState, sendVideoFrame, connect/disconnect.
 */

import { Platform } from 'react-native';
import Constants from 'expo-constants';

export type LiveState = 'disconnected' | 'connecting' | 'listening' | 'speaking';

function floatTo16BitPCM(input: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(input.length * 2);
  const view = new DataView(buffer);
  let offset = 0;
  for (let i = 0; i < input.length; i++, offset += 2) {
    let s = Math.max(-1, Math.min(1, input[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}

function pcm16ToFloats(uint8Array: Uint8Array): Float32Array {
  const int16 = new Int16Array(uint8Array.buffer, uint8Array.byteOffset, uint8Array.byteLength / 2);
  const floats = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) floats[i] = int16[i] / 32768.0;
  return floats;
}

function base64ArrayBuffer(arrayBuffer: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(arrayBuffer);
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  // React Native has global btoa via JS polyfill? Use atob/btoa fallback.
  if (typeof globalThis.btoa === 'function') return globalThis.btoa(binary);
  // fallback manual
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  let i = 0;
  const len = binary.length;
  while (i < len) {
    const a = binary.charCodeAt(i++) || 0;
    const b = binary.charCodeAt(i++) || 0;
    const c = binary.charCodeAt(i++) || 0;
    const triple = (a << 16) | (b << 8) | c;
    out += chars[(triple >> 18) & 0x3f] + chars[(triple >> 12) & 0x3f] + chars[(triple >> 6) & 0x3f] + chars[triple & 0x3f];
  }
  const pad = len % 3;
  if (pad) out = out.slice(0, pad === 1 ? -2 : -1) + (pad === 1 ? '==' : '=');
  return out;
}

function base64ToUint8Array(base64: string): Uint8Array {
  if (typeof globalThis.atob === 'function') {
    const binaryString = globalThis.atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = binaryString.charCodeAt(i);
    return bytes;
  }
  // fallback: use Buffer if available (Expo)
  // @ts-ignore
  if (typeof Buffer !== 'undefined') return Uint8Array.from(Buffer.from(base64, 'base64'));
  return new Uint8Array();
}

function pcmBytesToWavBytes(pcmBytes: Uint8Array, sampleRate: number, numChannels = 1, bitsPerSample = 16): Uint8Array {
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcmBytes.length;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  let offset = 0;
  const writeString = (s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(offset++, s.charCodeAt(i)); };
  writeString('RIFF');
  view.setUint32(offset, 36 + dataSize, true); offset += 4;
  writeString('WAVE');
  writeString('fmt ');
  view.setUint32(offset, 16, true); offset += 4;
  view.setUint16(offset, 1, true); offset += 2;
  view.setUint16(offset, numChannels, true); offset += 2;
  view.setUint32(offset, sampleRate, true); offset += 4;
  view.setUint32(offset, byteRate, true); offset += 4;
  view.setUint16(offset, blockAlign, true); offset += 2;
  view.setUint16(offset, bitsPerSample, true); offset += 2;
  writeString('data');
  view.setUint32(offset, dataSize, true); offset += 4;
  new Uint8Array(buffer, 44).set(pcmBytes);
  return new Uint8Array(buffer);
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  if (typeof globalThis.btoa === 'function') return globalThis.btoa(binary);
  // @ts-ignore
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  return base64ArrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
}

export class NuviAudioSession {
  private ws: WebSocket | null = null;
  private inputAudioCtx: AudioContext | null = null;
  private outputAudioCtx: AudioContext | null = null;
  private micStream: MediaStream | null = null;
  private micSourceNode: MediaStreamAudioSourceNode | null = null;
  private micProcessorNode: ScriptProcessorNode | null = null;

  public inputAnalyser: AnalyserNode | null = null;
  public outputAnalyser: AnalyserNode | null = null;
  private outputGainNode: GainNode | null = null;
  private nextStartTime = 0;
  private activeSources: AudioBufferSourceNode[] = [];
  private currentState: LiveState = 'disconnected';
  private isActivated = false;
  // Native audio (expo-audio + expo-file-system) — queued to avoid mixed voices
  private nativeRecorder: any = null;
  private nativeRecordTimer: any = null;
  private nativePlayer: any = null;
  private nativeQueue: { uri: string; durMs: number }[] = [];
  private nativeIsPlaying = false;
  private nativePlayerQueue: string[] = [];
  // PCM batching for smooth native playback (reduces per-chunk WAV/file overhead)
  private nativePending: Uint8Array[] = [];
  private nativePendingBytes = 0;
  private nativePendingTimer: any = null;
  // Gapless playlist (expo-audio 57) — preferred over per-file AudioPlayer
  private nativePlaylist: any = null;
  private nativePlaylistUris: string[] = [];
  private nativePlaylistStarting = false;

  private serverUrl: string;

  private onStateChange: (s: LiveState) => void;
  private onTranscription: (role: 'user' | 'model', text: string) => void;
  private onToolCall: (name: string, args: any, cb: (r: any) => void) => void;
  private onError: (e: string) => void;
  private onMemorySync?: (m: any[]) => void;

  constructor(
    serverUrl: string,
    handlers: {
      onStateChange: (s: LiveState) => void;
      onTranscription: (role: 'user' | 'model', text: string) => void;
      onToolCall: (name: string, args: any, cb: (r: any) => void) => void;
      onError: (e: string) => void;
      onMemorySync?: (m: any[]) => void;
    },
  ) {
    this.serverUrl = serverUrl.replace(/\/$/, '');
    this.onStateChange = handlers.onStateChange;
    this.onTranscription = handlers.onTranscription;
    this.onToolCall = handlers.onToolCall;
    this.onError = handlers.onError;
    this.onMemorySync = handlers.onMemorySync;
  }

  private setState(s: LiveState) {
    this.currentState = s;
    this.onStateChange(s);
  }
  getState(): LiveState { return this.currentState; }

  private canCaptureMic(): boolean {
    return this.isActivated && this.currentState !== 'disconnected' && this.currentState !== 'connecting' && this.currentState !== 'speaking';
  }

  public sendVideoFrame(b64: string) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.currentState !== 'disconnected') {
      this.ws.send(JSON.stringify({ type: 'video', video: b64 }));
    }
  }

  public sendText(text: string) {
    const t = String(text || '').trim();
    if (!t) return;
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.currentState !== 'disconnected') {
      this.ws.send(JSON.stringify({ type: 'text', text: t }));
    }
  }

  updateServerUrl(url: string) {
    this.serverUrl = url.replace(/\/$/, '');
  }

  private getWsUrl(): string {
    const base = this.serverUrl.replace(/\/$/, '');
    const wsUrl = base.startsWith('http') ? base.replace(/^http/, 'ws') + '/live' : `ws://${base}/live`;

    // Web (Expo web on :8081): server is on :3000, so use hostname:3000, not host (which includes :8081)
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      const isPlaceholder = base.includes('192.168.') || base.includes('10.0.');
      if (isPlaceholder) {
        const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        return `${proto}//${window.location.hostname}:3000/live`;
      }
      return wsUrl;
    }

    // Native (Expo Go): if still placeholder 192.168.x.x, try to derive LAN IP from debugger hostUri
    if (Platform.OS !== 'web' && base.includes('192.168.')) {
      try {
        const hostUri =
          (Constants.expoConfig as any)?.hostUri ||
          (Constants.manifest as any)?.hostUri ||
          (Constants as any)?.manifest2?.extra?.expoGo?.debuggerHost ||
          '';
        if (hostUri) {
          const host = String(hostUri).split(':')[0];
          if (host && host !== '127.0.0.1' && host !== 'localhost') {
            return `ws://${host}:3000/live`;
          }
        }
      } catch {}
    }
    return wsUrl;
  }

  async connect() {
    if (this.isActivated) return;
    this.isActivated = true;
    this.setState('connecting');
    let finalWs = '';
    try {
      finalWs = this.getWsUrl();
      console.log('[Nuvi WS] connecting to', finalWs, 'via serverUrl', this.serverUrl);
      this.ws = new WebSocket(finalWs);

      this.ws.onopen = async () => {
        if (!this.isActivated) return;
        // Audio setup – only on web where AudioContext exists
        if (Platform.OS === 'web' && typeof window !== 'undefined' && (window.AudioContext || (window as any).webkitAudioContext)) {
          try {
            const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
            this.inputAudioCtx = new AudioContextClass({ sampleRate: 16000 });
            this.outputAudioCtx = new AudioContextClass({ sampleRate: 24000 });
            if (this.inputAudioCtx.state === 'suspended') await this.inputAudioCtx.resume().catch(() => {});
            if (this.outputAudioCtx.state === 'suspended') await this.outputAudioCtx.resume().catch(() => {});
            this.outputGainNode = this.outputAudioCtx.createGain();
            this.outputAnalyser = this.outputAudioCtx.createAnalyser();
            this.outputAnalyser.fftSize = 256;
            this.outputGainNode.connect(this.outputAnalyser);
            this.outputAnalyser.connect(this.outputAudioCtx.destination);
            const stream = await navigator.mediaDevices.getUserMedia({
              audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
            });
            if (!this.isActivated || !this.inputAudioCtx || !this.outputAudioCtx) {
              stream.getTracks().forEach(t => t.stop());
              return;
            }
            this.micStream = stream;
            this.inputAnalyser = this.inputAudioCtx.createAnalyser();
            this.inputAnalyser.fftSize = 256;
            this.micSourceNode = this.inputAudioCtx.createMediaStreamSource(this.micStream);
            this.micSourceNode.connect(this.inputAnalyser);
            this.micProcessorNode = this.inputAudioCtx.createScriptProcessor(2048, 1, 1);
            this.micSourceNode.connect(this.micProcessorNode);
            this.micProcessorNode.connect(this.inputAudioCtx.destination);
            this.micProcessorNode.onaudioprocess = e => {
              if (!this.canCaptureMic()) return;
              const channelData = e.inputBuffer.getChannelData(0);
              const pcmBuffer = floatTo16BitPCM(channelData);
              const b64 = base64ArrayBuffer(pcmBuffer);
              if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ audio: b64 }));
            };
            this.setState('listening');
          } catch (err: any) {
            this.onError(`Mic error: ${err.message || err}`);
            this.disconnect();
          }
        } else {
          // Native: expo-audio streaming via chunked WAV → PCM 16k base64
          try {
            await this.startNativeMic();
          } catch (e) { console.warn('native mic init', e); }
          this.setState('listening');
        }
      };

      this.ws.onmessage = async (event: any) => {
        try {
          const data = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString());
          if (data.type === 'error') { this.onError(data.error); this.disconnect(); return; }
          if (data.type === 'status') {
            if (data.status === 'connected') this.setState('listening');
            else if (data.status === 'session_closed') this.disconnect();
            return;
          }
          if (data.type === 'audio' && data.audio) this.playAudioPCMChunk(data.audio);
          if (data.type === 'interrupted') this.handleInterruption();
          if (data.type === 'turnComplete') {
            // flush any pending batched PCM so tail is not delayed
            void this.flushNativePending();
            setTimeout(() => { if (this.activeSources.length === 0 && this.currentState === 'speaking' && this.nativeQueue.length === 0 && this.nativePendingBytes === 0) this.setState('listening'); }, 180);
          }
          if (data.type === 'transcription') this.onTranscription(data.role, data.text);
          if (data.type === 'memory_sync' && data.memories) this.onMemorySync?.(data.memories);
          if (data.type === 'toolCall') {
            const { callId, name, args } = data;
            this.onToolCall(name, args, (result) => {
              if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({ type: 'toolResponse', id: callId, name, output: result }));
              }
            });
          }
        } catch (e) { console.warn('WS parse', e); }
      };
      this.ws.onerror = (e: any) => {
        console.warn('[Nuvi WS] onerror', finalWs, e?.message || e);
        this.onError(`WebSocket error – check serverUrl (${finalWs}). Ensure server is running (npm run dev → :3000) and phone is on same Wi-Fi as ${this.serverUrl}.`);
        this.disconnect();
      };
      this.ws.onclose = (ev: any) => {
        console.log('[Nuvi WS] closed', finalWs, ev?.code, ev?.reason);
        this.disconnect();
      };
    } catch (e: any) {
      this.onError(e.message || 'Failed to connect');
      this.disconnect();
    }
  }

  private handleInterruption() {
    this.activeSources.forEach(s => { try { s.stop(); } catch {} });
    this.activeSources = [];
    this.nextStartTime = 0;
    // native queue interrupt — stop current and clear pending
    try { (this.nativePlayer as any)?.pause?.(); (this.nativePlayer as any)?.remove?.(); } catch {}
    this.nativePlayer = null;
    try { (this.nativePlaylist as any)?.pause?.(); } catch {}
    // delete pending playlist files (best-effort, async)
    for (const u of this.nativePlaylistUris) {
      import('expo-file-system').then(({ File }: any) => { try { new (File as any)(u).delete?.(); } catch {} }).catch(() => {});
      import('expo-file-system/legacy').then((L: any) => L.deleteAsync?.(u, { idempotent: true }).catch(() => {})).catch(() => {});
    }
    this.nativePlaylist = null;
    this.nativePlaylistUris = [];
    this.nativePlaylistStarting = false;
    this.nativeQueue = [];
    this.nativeIsPlaying = false;
    this.nativePlayerQueue = [];
    // drop pending PCM batches
    this.nativePending = [];
    this.nativePendingBytes = 0;
    if (this.nativePendingTimer) { clearTimeout(this.nativePendingTimer); this.nativePendingTimer = null; }
    this.setState('listening');
  }

  private async playNativeChunk(b64: string) {
    this.setState('speaking');
    try {
      const pcmBytes = base64ToUint8Array(b64);
      if (!pcmBytes.length) return;
      // Batch PCM to reduce per-chunk file overhead (main cause of breaking voice)
      // Gemini sends 60-100ms chunks; coalesce to ~150ms for low latency + gapless playlist
      this.nativePending.push(pcmBytes);
      this.nativePendingBytes += pcmBytes.length;
      const flushThreshold = 7200; // ~150ms at 24k mono 16-bit (48000 B/s) — balance latency vs gapless
      if (this.nativePendingBytes >= flushThreshold) {
        void this.flushNativePending();
      } else if (!this.nativePendingTimer) {
        this.nativePendingTimer = setTimeout(() => void this.flushNativePending(), 60);
      }
    } catch (e) { console.warn('native play fail', e); }
  }

  private async flushNativePending() {
    if (this.nativePendingTimer) { clearTimeout(this.nativePendingTimer); this.nativePendingTimer = null; }
    if (this.nativePending.length === 0) return;
    // concatenate pending PCM
    const total = this.nativePendingBytes;
    const combined = new Uint8Array(total);
    let off = 0;
    for (const c of this.nativePending) { combined.set(c, off); off += c.length; }
    this.nativePending = [];
    this.nativePendingBytes = 0;
    const wavBytes = pcmBytesToWavBytes(combined, 24000, 1, 16);
    let uri: string | null = null;
    try {
      const fileName = `nuvi_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.wav`;
      let written = false;
      try {
        const { File, Paths } = await import('expo-file-system');
        const cacheDir: any = (Paths as any)?.cache;
        if (cacheDir?.uri) {
          const file: any = new (File as any)(cacheDir, fileName);
          try { file.create?.({ overwrite: true } as any); } catch {}
          if (typeof file.write === 'function') {
            file.write(wavBytes);
            uri = file.uri as string;
            written = true;
          } else if (typeof file.writeAsStringAsync === 'function') {
            throw new Error('File.write unavailable');
          }
        }
      } catch {}
      if (!written) {
        const Legacy: any = await import('expo-file-system/legacy');
        const dir: string | null = Legacy.cacheDirectory ?? Legacy.documentDirectory ?? null;
        if (!dir) throw new Error('expo-file-system cacheDirectory unavailable (legacy)');
        const fileUri = `${dir}${fileName}`;
        const enc = Legacy.EncodingType?.Base64 ?? 'base64';
        await Legacy.writeAsStringAsync(fileUri, uint8ToBase64(wavBytes), { encoding: enc });
        uri = fileUri;
      }
    } catch (e) {
      console.warn('wav file write failed; skipping chunk to avoid invalid data URI playback', e);
      return;
    }
    if (!uri) return;
    const durMs = (combined.length / 48000) * 1000;
    // Prefer gapless AudioPlaylist (SDK 57) over per-file AudioPlayer queue
    const usePlaylist = await this.enqueueViaPlaylist(uri, durMs);
    if (usePlaylist) return;
    // Fallback: legacy per-file queue (gapless via early start)
    this.nativeQueue.push({ uri, durMs });
    if (!this.nativeIsPlaying) {
      const totalBuffered = this.nativeQueue.reduce((s, q) => s + q.durMs, 0);
      if (totalBuffered < 200) {
        setTimeout(() => void this.playNextNative(), 30);
      } else {
        void this.playNextNative();
      }
    } else {
      void this.playNextNative();
    }
  }

  private async enqueueViaPlaylist(uri: string, _durMs: number): Promise<boolean> {
    try {
      const mod: any = await import('expo-audio');
      const createPlaylist = mod.createAudioPlaylist || mod.AudioModule?.AudioPlaylist || null;
      if (!createPlaylist) return false;
      if (!this.nativePlaylist) {
        // create playlist with first track; gapless mode
        try {
          // try options-object signature first (SDK 57)
          this.nativePlaylist = createPlaylist({ sources: [uri], loop: 'none' });
        } catch {
          // fallback to array signature
          this.nativePlaylist = new (mod.AudioPlaylist || createPlaylist)([uri], 100, 'none');
        }
        this.nativePlaylistUris = [uri];
        try { this.nativePlaylist.volume = 1.0; } catch {}
        // cleanup listener: delete files as tracks advance
        try {
          this.nativePlaylist.addListener?.('trackChanged', ({ previousIndex, currentIndex }: any) => {
            const prevUri = this.nativePlaylistUris[previousIndex];
            if (prevUri) {
              (async () => {
                try {
                  const { File } = await import('expo-file-system');
                  try { new (File as any)(prevUri).delete?.(); } catch {}
                } catch {}
                try {
                  const Legacy: any = await import('expo-file-system/legacy');
                  await Legacy.deleteAsync?.(prevUri, { idempotent: true }).catch(() => {});
                } catch {}
              })();
            }
            // if playlist advanced to last and pending still has data, flush
            if (currentIndex === this.nativePlaylistUris.length - 1 && this.nativePendingBytes > 0) {
              void this.flushNativePending();
            }
          });
          this.nativePlaylist.addListener?.('playlistStatusUpdate', (st: any) => {
            if (st?.didJustFinish && this.nativeQueue.length === 0 && this.nativePendingBytes === 0) {
              // playlist drained
            }
          });
        } catch {}
        // ensure audio session for gapless
        try { await mod.setAudioModeAsync?.({ playsInSilentMode: true, shouldRouteThroughEarpiece: false, allowsRecording: true, interruptionMode: 'duckOthers' }); } catch {}
        this.nativePlaylist.play?.();
        // also keep legacy queue state in sync for turnComplete checks
        this.nativeIsPlaying = true;
        // when playlist finishes all, we will be notified via didJustFinish; also poll fallback
        const checkDone = () => {
          if (!this.nativePlaylist) return;
          const st: any = this.nativePlaylist.currentStatus || {};
          if (st.didJustFinish || (!this.nativePlaylist.playing && this.nativeQueue.length === 0 && this.nativePendingBytes === 0)) {
            this.nativeIsPlaying = false;
            if (this.currentState === 'speaking') this.setState('listening');
            // cleanup playlist instance to free ExoPlayer
            try { this.nativePlaylist?.pause?.(); } catch {}
            // keep uris for lazy delete on next interruption/playlist recreate; clear after 2s
            setTimeout(() => {
              for (const u of this.nativePlaylistUris) {
                import('expo-file-system').then(({ File }: any) => { try { new (File as any)(u).delete?.(); } catch {} }).catch(() => {});
                import('expo-file-system/legacy').then((L: any) => L.deleteAsync?.(u, { idempotent: true }).catch(() => {})).catch(() => {});
              }
              this.nativePlaylist = null;
              this.nativePlaylistUris = [];
            }, 2000);
          } else if (this.nativePlaylist.playing) {
            setTimeout(checkDone, 300);
          }
        };
        setTimeout(checkDone, 600);
        return true;
      } else {
        // append to existing playlist — gapless add
        try { this.nativePlaylist.add?.(uri); } catch { // some versions use add(source)
          this.nativePlaylist.add?.({ uri });
        }
        this.nativePlaylistUris.push(uri);
        if (!this.nativePlaylist.playing) this.nativePlaylist.play?.();
        return true;
      }
    } catch (e) {
      // playlist not supported, fall back to per-file player
      return false;
    }
  }

  private async playNextNative() {
    if (this.nativeIsPlaying || this.nativeQueue.length === 0) return;
    // with batching, queue holds ~180-220ms chunks; tiny tail <70ms is flushed on turnComplete
    if (this.nativeQueue.length === 1) {
      const total = this.nativeQueue[0].durMs;
      if (total < 45 && this.nativePendingBytes > 0) {
        // pending will be flushed shortly, wait to avoid playing tiny tail before batch completes
        setTimeout(() => void this.playNextNative(), 25);
        return;
      }
    }
    const next = this.nativeQueue.shift();
    if (!next) return;
    this.nativeIsPlaying = true;
    try {
      const { createAudioPlayer } = await import('expo-audio');
      try { (this.nativePlayer as any)?.remove?.(); } catch {}
      const p: any = (createAudioPlayer as any)(next.uri);
      this.nativePlayer = p;
      try { p.volume = 1.0; } catch {}
      p.play?.();
      // gapless: start next slightly before current ends (-14ms) to hide file-load latency
      setTimeout(async () => {
        try { (p as any)?.remove?.(); } catch {}
        try {
          if (next.uri.startsWith('file:')) {
            let deleted = false;
            try {
              const { File } = await import('expo-file-system');
              const f: any = new (File as any)(next.uri);
              if (typeof f.delete === 'function') {
                f.delete();
                deleted = true;
              } else if (typeof f.deleteAsync === 'function') {
                await f.deleteAsync();
                deleted = true;
              }
            } catch {}
            if (!deleted) {
              const Legacy: any = await import('expo-file-system/legacy');
              if (Legacy.deleteAsync) await Legacy.deleteAsync(next.uri, { idempotent: true }).catch(() => {});
            }
          }
        } catch {}
        this.nativeIsPlaying = false;
        if (this.nativeQueue.length > 0) void this.playNextNative();
        else if (this.nativePendingBytes > 0) void this.flushNativePending();
        else if (this.currentState === 'speaking') this.setState('listening');
      }, Math.max(22, next.durMs - 14));
    } catch (e) {
      console.warn('playNextNative failed', e);
      this.nativeIsPlaying = false;
      void this.playNextNative();
    }
  }

  private playAudioPCMChunk(b64: string) {
    // Native path: no Web Audio, use expo-audio wav file
    if (Platform.OS !== 'web') {
      void this.playNativeChunk(b64);
      return;
    }
    if (!this.outputAudioCtx || !this.outputGainNode) {
      this.setState('speaking');
      return;
    }
    try {
      this.setState('speaking');
      const uint8 = base64ToUint8Array(b64);
      const floats = pcm16ToFloats(uint8);
      const buffer = this.outputAudioCtx.createBuffer(1, floats.length, 24000);
      buffer.getChannelData(0).set(floats);
      const source = this.outputAudioCtx.createBufferSource();
      source.buffer = buffer;
      source.connect(this.outputGainNode);
      const ct = this.outputAudioCtx.currentTime;
      if (this.nextStartTime < ct) this.nextStartTime = ct + 0.03;
      source.start(this.nextStartTime);
      this.nextStartTime += buffer.duration;
      source.onended = () => {
        const idx = this.activeSources.indexOf(source);
        if (idx > -1) this.activeSources.splice(idx, 1);
        if (this.activeSources.length === 0 && this.currentState === 'speaking') this.setState('listening');
      };
      this.activeSources.push(source);
    } catch (e) { console.warn('play chunk fail', e); }
  }

  disconnect() {
    this.isActivated = false;
    this.setState('disconnected');
    if (this.ws) { try { this.ws.close(); } catch {} this.ws = null; }
    if (this.micStream) { this.micStream.getTracks().forEach(t => { try { t.stop(); } catch {} }); this.micStream = null; }
    if (this.micProcessorNode) { try { this.micProcessorNode.disconnect(); } catch {} this.micProcessorNode = null; }
    if (this.micSourceNode) { try { this.micSourceNode.disconnect(); } catch {} this.micSourceNode = null; }
    if (this.inputAudioCtx) { try { this.inputAudioCtx.close(); } catch {} this.inputAudioCtx = null; }
    if (this.outputAudioCtx) { try { this.outputAudioCtx.close(); } catch {} this.outputAudioCtx = null; }
    this.activeSources = [];
    this.nextStartTime = 0;
    this.inputAnalyser = null;
    this.outputAnalyser = null;
    this.outputGainNode = null;
    // native cleanup — stop stream/recorder and clear queued playback
    if (this.nativeRecordTimer) { clearInterval(this.nativeRecordTimer); this.nativeRecordTimer = null; }
    if (this.nativePendingTimer) { clearTimeout(this.nativePendingTimer); this.nativePendingTimer = null; }
    this.nativePending = [];
    this.nativePendingBytes = 0;
    if (this.nativeRecorder) { try { (this.nativeRecorder as any)?.stop?.(); } catch {} this.nativeRecorder = null; }
    if (this.nativePlayer) { try { (this.nativePlayer as any)?.pause?.(); (this.nativePlayer as any)?.remove?.(); } catch {} this.nativePlayer = null; }
    if (this.nativePlaylist) { try { (this.nativePlaylist as any)?.pause?.(); } catch {} }
    for (const u of this.nativePlaylistUris) {
      import('expo-file-system').then(({ File }: any) => { try { new (File as any)(u).delete?.(); } catch {} }).catch(() => {});
      import('expo-file-system/legacy').then((L: any) => L.deleteAsync?.(u, { idempotent: true }).catch(() => {})).catch(() => {});
    }
    this.nativePlaylist = null;
    this.nativePlaylistUris = [];
    this.nativePlaylistStarting = false;
    this.nativeQueue = [];
    this.nativeIsPlaying = false;
    this.nativePlayerQueue = [];
  }

  private async startNativeMic() {
    if (Platform.OS === 'web') return;
    // Prefer real-time PCM stream (expo-audio AudioStream) – no wav/AAC transcode, true 16k int16
    try {
      const { AudioModule } = await import('expo-audio');
      const perm = await (AudioModule as any).requestRecordingPermissionsAsync?.();
      if (perm && perm.granted === false) throw new Error('Mic permission denied');
      await (AudioModule as any).setAudioModeAsync?.({
        playsInSilentMode: true,
        shouldRouteThroughEarpiece: false,
        allowsRecording: true,
        // mixWithOthers prevents recording from stealing focus and breaking playback on Android
        interruptionMode: 'duckOthers' as any,
        interruptionModeAndroid: 'duckOthers' as any,
      });

      // Try AudioStream first (SDK 57+)
      const StreamClass = (AudioModule as any).AudioStream;
      if (StreamClass) {
        const onBuffer = (buf: any) => {
          if (!this.canCaptureMic() || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
          try {
            const data: ArrayBuffer = buf?.data || buf;
            if (!data || (data as any).byteLength < 400) return; // skip tiny
            const b64 = base64ArrayBuffer(data as ArrayBuffer);
            this.ws?.send(JSON.stringify({ audio: b64 }));
            console.log('[Nuvi Mic] stream chunk', (data as any).byteLength, 'b64', b64.length);
          } catch (e) { console.warn('stream onBuffer', e); }
        };
        const stream: any = new StreamClass({ sampleRate: 16000, channels: 1, encoding: 'int16', onBuffer } as any);
        try { stream.addListener?.('audioStreamBuffer', onBuffer); } catch {}
        (stream as any).onBuffer = onBuffer;
        await stream.start();
        this.nativeRecorder = stream; // reuse field for cleanup
        console.log('[Nuvi Mic] AudioStream started', (stream as any).sampleRate, (stream as any).channels);
        return;
      }
      // Fallback: old file-based recorder (wav) – keeps previous logic for devices without AudioStream
      throw new Error('AudioStream unavailable, fallback to file recorder');
    } catch (e: any) {
      console.warn('AudioStream failed, falling back to file recorder', e?.message || e);
      // File fallback (kept for completeness, but prefers stream)
      try {
        const { AudioModule: AM2 } = await import('expo-audio');
        const recOptions: any = {
          extension: '.wav',
          sampleRate: 16000,
          numberOfChannels: 1,
          bitRate: 256000,
          android: { extension: '.wav', outputFormat: 'default', audioEncoder: 'default', sampleRate: 16000, numberOfChannels: 1 },
          ios: { extension: '.wav', outputFormat: 'lpcm', audioQuality: 96, sampleRate: 16000, numberOfChannels: 1, linearPCMBitDepth: 16, linearPCMIsBigEndian: false, linearPCMIsFloat: false },
        };
        const RecorderClass = (AM2 as any).AudioRecorder;
        if (!RecorderClass) throw e;
        // @ts-ignore
        this.nativeRecorder = new RecorderClass(recOptions);
        await (this.nativeRecorder as any).prepareToRecordAsync();
        (this.nativeRecorder as any).record();
        this.nativeRecordTimer = setInterval(async () => {
          if (!this.isActivated || this.currentState === 'disconnected' || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
          const rec: any = this.nativeRecorder;
          if (!rec) return;
          try {
            const uri: string | null = rec.uri || null;
            try { await rec.stop(); } catch {}
            if (uri) {
              let sent = false;
              try {
                const { File } = await import('expo-file-system');
                const f: any = new (File as any)(uri);
                let buf: any = null;
                try { buf = await f.arrayBuffer(); } catch { try { const b: Uint8Array = await (f as any).bytes(); buf = (b as any).buffer ?? b; } catch {} }
                if (buf) {
                  const all = new Uint8Array(buf as any);
                  const isWav = all.length > 12 && all[0] === 82 && all[1] === 73 && all[2] === 70 && all[3] === 70;
                  const pcm = isWav && all.length > 44 ? all.slice(44) : all;
                  if (pcm.length > 800) {
                    this.ws?.send(JSON.stringify({ audio: uint8ToBase64(pcm as Uint8Array) }));
                    sent = true;
                  }
                }
              } catch {}
              if (!sent) {
                try {
                  const Legacy: any = await import('expo-file-system/legacy');
                  const b64: string = await Legacy.readAsStringAsync(uri, { encoding: Legacy.EncodingType?.Base64 ?? 'base64' });
                  if (b64) {
                    const all = base64ToUint8Array(b64);
                    const isWav = all.length > 12 && all[0] === 82 && all[1] === 73 && all[2] === 70 && all[3] === 70;
                    const pcm = isWav && all.length > 44 ? all.slice(44) : all;
                    if (pcm.length > 800) this.ws?.send(JSON.stringify({ audio: uint8ToBase64(pcm as Uint8Array) }));
                  }
                } catch {}
              }
            }
            try { await rec.prepareToRecordAsync(); rec.record(); } catch {}
          } catch {}
        }, 850);
      } catch (e2: any) {
        console.warn('startNativeMic fallback failed', e2?.message || e2);
        this.onError(`Mic init failed: ${e2?.message || e2}. Use text chat.`);
      }
    }
  }
}
