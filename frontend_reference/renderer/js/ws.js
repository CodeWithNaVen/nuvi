export class NuviSocket {
  constructor(url, handlers) {
    this.url = url;
    this.handlers = handlers; // { onMessage(msg), onOpen(), onClose() }
    this._connect();
  }

  _connect() {
    this.ws = new WebSocket(this.url);
    this.ws.onopen = () => this.handlers.onOpen?.();
    this.ws.onmessage = (evt) => {
      try {
        this.handlers.onMessage?.(JSON.parse(evt.data));
      } catch (e) {
        console.error("bad ws message", e);
      }
    };
    this.ws.onclose = () => {
      this.handlers.onClose?.();
      setTimeout(() => this._connect(), 1500);
    };
    this.ws.onerror = () => this.ws.close();
  }

  send(obj) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  sendAudioChunk(base64) {
    this.send({ type: "audio_chunk", data: base64 });
  }

  endAudio(sampleRate = 16000) {
    this.send({ type: "audio_end", sample_rate: sampleRate });
  }

  sendText(text) {
    this.send({ type: "text", text });
  }
}
