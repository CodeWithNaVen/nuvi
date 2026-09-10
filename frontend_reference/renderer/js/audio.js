/**
 * Mic capture -> 16kHz mono PCM16 chunks (streamed to backend over the
 * websocket) + playback of returned TTS audio, both feeding a live
 * amplitude value the visualizer can react to.
 */
const TARGET_SAMPLE_RATE = 16000;
const SILENCE_RMS_THRESHOLD = 0.012;
const SILENCE_HOLD_MS = 1100; // auto-stop after this much continuous quiet, once speech was heard

export class MicStreamer {
  constructor({ onChunk, onAmplitude, onAutoStop }) {
    this.onChunk = onChunk;
    this.onAmplitude = onAmplitude;
    this.onAutoStop = onAutoStop;
    this.active = false;
    this._heardSpeech = false;
    this._silenceStart = null;
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.sourceNode = this.ctx.createMediaStreamSource(this.stream);
    this.processor = this.ctx.createScriptProcessor(4096, 1, 1);
    this._heardSpeech = false;
    this._silenceStart = null;

    this.processor.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      const rms = this._rms(input);
      this.onAmplitude?.(Math.min(1, rms * 6));

      if (rms > SILENCE_RMS_THRESHOLD) {
        this._heardSpeech = true;
        this._silenceStart = null;
      } else if (this._heardSpeech) {
        if (this._silenceStart === null) this._silenceStart = performance.now();
        else if (performance.now() - this._silenceStart > SILENCE_HOLD_MS) {
          this._silenceStart = null;
          this.onAutoStop?.();
          return;
        }
      }

      const downsampled = this._downsample(input, this.ctx.sampleRate, TARGET_SAMPLE_RATE);
      const pcm16 = this._floatTo16BitPCM(downsampled);
      this.onChunk?.(pcm16);
    };

    this.sourceNode.connect(this.processor);
    this.processor.connect(this.ctx.destination); // required by some browsers to keep processor alive
    this.active = true;
  }

  stop() {
    this.active = false;
    this.processor?.disconnect();
    this.sourceNode?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close();
  }

  _rms(buf) {
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    return Math.sqrt(sum / buf.length);
  }

  _downsample(buffer, inRate, outRate) {
    if (outRate === inRate) return buffer;
    const ratio = inRate / outRate;
    const newLength = Math.round(buffer.length / ratio);
    const result = new Float32Array(newLength);
    let offsetResult = 0, offsetBuffer = 0;
    while (offsetResult < result.length) {
      const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
      let accum = 0, count = 0;
      for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
        accum += buffer[i];
        count++;
      }
      result[offsetResult] = accum / (count || 1);
      offsetResult++;
      offsetBuffer = nextOffsetBuffer;
    }
    return result;
  }

  _floatTo16BitPCM(float32Array) {
    const out = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
      const s = Math.max(-1, Math.min(1, float32Array[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out.buffer;
  }
}

export function pcm16ToBase64(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/** Plays base64-encoded TTS audio (wav/mp3) and reports live amplitude for the visualizer. */
export class TTSPlayer {
  constructor({ onAmplitude, onEnd }) {
    this.onAmplitude = onAmplitude;
    this.onEnd = onEnd;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
  }

  async play(base64Audio, mime = "audio/wav") {
    const binary = atob(base64Audio);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    const audioBuffer = await this.ctx.decodeAudioData(bytes.buffer.slice(0));
    const source = this.ctx.createBufferSource();
    source.buffer = audioBuffer;

    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 256;
    const dataArray = new Uint8Array(analyser.frequencyBinCount);

    source.connect(analyser);
    analyser.connect(this.ctx.destination);

    let raf;
    const tick = () => {
      analyser.getByteTimeDomainData(dataArray);
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        const v = (dataArray[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / dataArray.length);
      this.onAmplitude?.(Math.min(1, rms * 4));
      raf = requestAnimationFrame(tick);
    };
    tick();

    source.onended = () => {
      cancelAnimationFrame(raf);
      this.onAmplitude?.(0);
      this.onEnd?.();
    };
    source.start();
    return source;
  }

  speakBrowser(text, onEnd) {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.onend = () => onEnd?.();
    utterance.onboundary = () => this.onAmplitude?.(0.4 + Math.random() * 0.3);
    window.speechSynthesis.speak(utterance);
  }
}
