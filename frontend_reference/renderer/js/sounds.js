/**
 * All UI sound effects are synthesized on the fly with the Web Audio API --
 * no external sound files, no licensing concerns, instant to load.
 */
let ctx = null;
function getCtx() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  return ctx;
}

function envelope(gainNode, attack, sustainLevel, release, startTime, duration) {
  const g = gainNode.gain;
  g.cancelScheduledValues(startTime);
  g.setValueAtTime(0.0001, startTime);
  g.exponentialRampToValueAtTime(sustainLevel, startTime + attack);
  g.setValueAtTime(sustainLevel, startTime + duration - release);
  g.exponentialRampToValueAtTime(0.0001, startTime + duration);
}

function tone({ freq, type = "sine", start, duration, gain = 0.2, freqEnd = null, filterFreq = null }) {
  const c = getCtx();
  const osc = c.createOscillator();
  const amp = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  if (freqEnd !== null) osc.frequency.exponentialRampToValueAtTime(freqEnd, start + duration);

  let node = osc;
  if (filterFreq) {
    const filter = c.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = filterFreq;
    osc.connect(filter);
    node = filter;
  }
  node.connect(amp);
  amp.connect(c.destination);
  envelope(amp, 0.02, gain, duration * 0.6, start, duration);
  osc.start(start);
  osc.stop(start + duration + 0.05);
}

function noiseBurst({ start, duration, gain = 0.08, filterFreq = 2000 }) {
  const c = getCtx();
  const bufferSize = c.sampleRate * duration;
  const buffer = c.createBuffer(1, bufferSize, c.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
  const src = c.createBufferSource();
  src.buffer = buffer;
  const filter = c.createBiquadFilter();
  filter.type = "highpass";
  filter.frequency.value = filterFreq;
  const amp = c.createGain();
  amp.gain.value = gain;
  src.connect(filter);
  filter.connect(amp);
  amp.connect(c.destination);
  src.start(start);
}

/** Cinematic "system boot" sting played once when the app launches. */
export function playIntro() {
  const c = getCtx();
  const now = c.currentTime + 0.05;

  // low rising drone
  tone({ freq: 60, freqEnd: 140, type: "sawtooth", start: now, duration: 1.8, gain: 0.12, filterFreq: 400 });
  // sub impact
  tone({ freq: 50, type: "sine", start: now + 1.5, duration: 0.6, gain: 0.35 });
  noiseBurst({ start: now + 1.48, duration: 0.35, gain: 0.15, filterFreq: 200 });
  // shimmering rising arpeggio -- "system online"
  const notes = [392, 523.25, 659.25, 783.99, 1046.5];
  notes.forEach((f, i) => {
    tone({ freq: f, type: "sine", start: now + 1.9 + i * 0.09, duration: 0.5, gain: 0.09, filterFreq: 4000 });
    tone({ freq: f * 2, type: "triangle", start: now + 1.9 + i * 0.09, duration: 0.35, gain: 0.03 });
  });
  // final resonant chord
  [523.25, 659.25, 783.99, 1046.5].forEach((f) =>
    tone({ freq: f, type: "sine", start: now + 2.5, duration: 1.6, gain: 0.06, filterFreq: 3000 })
  );
  noiseBurst({ start: now + 2.5, duration: 0.15, gain: 0.06, filterFreq: 6000 });
}

export function playListenStart() {
  const now = getCtx().currentTime;
  tone({ freq: 440, freqEnd: 880, type: "sine", start: now, duration: 0.18, gain: 0.15 });
}

export function playListenStop() {
  const now = getCtx().currentTime;
  tone({ freq: 660, freqEnd: 330, type: "sine", start: now, duration: 0.18, gain: 0.12 });
}

export function playAck() {
  const now = getCtx().currentTime;
  tone({ freq: 523.25, type: "sine", start: now, duration: 0.09, gain: 0.1 });
  tone({ freq: 783.99, type: "sine", start: now + 0.08, duration: 0.12, gain: 0.08 });
}

export function playError() {
  const now = getCtx().currentTime;
  tone({ freq: 220, type: "square", start: now, duration: 0.15, gain: 0.08 });
  tone({ freq: 160, type: "square", start: now + 0.12, duration: 0.18, gain: 0.08 });
}

export function unlockAudio() {
  // Browsers require a user gesture before AudioContext can play -- call
  // this from the first click anywhere in the app.
  const c = getCtx();
  if (c.state === "suspended") c.resume();
}
