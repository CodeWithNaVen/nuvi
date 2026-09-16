import { useEffect, useRef, useState } from "react";
import { NuviAudioSession, LiveState } from "./lib/audio";
import { NuviOrb } from "./components/NuviOrb";
import { MemoryDashboard } from "./components/MemoryDashboard";
import { SettingsPanel } from "./components/SettingsPanel";
import { Memory, MemoryCategory } from "./lib/memoryTypes";
import { NuviSettings, DEFAULT_SETTINGS, loadSettings, saveSettings } from "./lib/settingsStore";
import { NuviWakeWordDetector } from "./lib/wakeWord";
import { apiUrl } from "./lib/config";
import {
  Power,
  Mic,
  MicOff,
  Monitor,
  Video,
  Keyboard,
  Settings as SettingsIcon,
  MessageSquare,
  Brain,
  SlidersHorizontal,
  Send,
  X,
  Maximize2,
  Globe,
  AlertCircle,
  Sparkles,
  Volume2,
  Play,
  Pause,
  Square,
  RefreshCw,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type SidebarTab = "chat" | "settings" | "memory";

interface ChatMsg {
  id: string;
  role: "user" | "assistant" | "tool";
  text: string;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
export default function App() {
  const [liveState, setLiveState] = useState<LiveState>("disconnected");
  const [theme, setTheme] = useState<string>(() => {
    const ls = typeof window !== "undefined" ? localStorage.getItem("nuvi.theme") : null;
    return ls || "claude-code";
  });
  const [themeColor, setThemeColor] = useState<string>(() => {
    const ls = typeof window !== "undefined" ? localStorage.getItem("nuvi.themeColor") : null;
    return ls || "charcoal";
  });
  const [userCaption, setUserCaption] = useState("");
  const [modelCaption, setModelCaption] = useState("");
  const [errorText, setErrorText] = useState<string | null>(null);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [showMemoryDashboard, setShowMemoryDashboard] = useState(false);
  const [settings, setSettings] = useState<NuviSettings>(() => loadSettings());
  const [showSettings, setShowSettings] = useState(false);
  const [activeTab, setActiveTab] = useState<SidebarTab>("chat");
  const [chatMessages, setChatMessages] = useState<ChatMsg[]>([]);
  const [textInput, setTextInput] = useState("");

  // Screen sharing
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [isScreenSharingPaused, setIsScreenSharingPaused] = useState(false);
  const [screenVisionMode, setScreenVisionMode] = useState(true);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const screenVideoRef = useRef<HTMLVideoElement | null>(null);
  const screenCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const screenIntervalRef = useRef<any>(null);
  const isPausedRef = useRef(false);
  const screenVisionRef = useRef(true);
  const liveStateRef = useRef<LiveState>("disconnected");

  // Camera preview + scene analysis
  const [isCameraActive, setIsCameraActive] = useState(false);
  const [cameraStatus, setCameraStatus] = useState("Camera off");
  const [cameraResult, setCameraResult] = useState<Record<string, any> | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const cameraVideoRef = useRef<HTMLVideoElement | null>(null);
  const cameraCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const cameraIntervalRef = useRef<any>(null);
  const cameraActiveRef = useRef(false);

  useEffect(() => { isPausedRef.current = isScreenSharingPaused; }, [isScreenSharingPaused]);
  useEffect(() => { screenVisionRef.current = screenVisionMode; }, [screenVisionMode]);
  useEffect(() => { liveStateRef.current = liveState; }, [liveState]);
  useEffect(() => { cameraActiveRef.current = isCameraActive; }, [isCameraActive]);

  // Attach stream to video when it mounts after isCameraActive becomes true
  useEffect(() => {
    if (isCameraActive && cameraVideoRef.current && cameraStreamRef.current) {
      const v = cameraVideoRef.current;
      if (v.srcObject !== cameraStreamRef.current) {
        v.srcObject = cameraStreamRef.current;
        v.play().catch(() => {});
      }
    }
  }, [isCameraActive]);

  // Cleanup on unmount
  useEffect(() => () => {
    if (screenIntervalRef.current) clearInterval(screenIntervalRef.current);
    if (cameraIntervalRef.current) clearInterval(cameraIntervalRef.current);
    if (cameraStreamRef.current) cameraStreamRef.current.getTracks().forEach((t) => { try { t.stop(); } catch {} });
  }, []);

  // Theme persistence
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("nuvi.theme", theme);
  }, [theme]);
  useEffect(() => {
    if (themeColor && themeColor !== "charcoal") {
      document.documentElement.setAttribute("data-theme-color", themeColor);
    } else {
      document.documentElement.removeAttribute("data-theme-color");
    }
    localStorage.setItem("nuvi.themeColor", themeColor);
  }, [themeColor]);

  // Wake word
  const wakeDetectorRef = useRef<NuviWakeWordDetector | null>(null);
  const connectHandlerRef = useRef<() => void>(() => {});
  useEffect(() => {
    const det = new NuviWakeWordDetector();
    wakeDetectorRef.current = det;
    return () => det.stop();
  }, []);
  useEffect(() => {
    const det = wakeDetectorRef.current;
    if (!det) return;
    if (settings.wakeWordEnabled && liveState === "disconnected") {
      det.start({
        phrase: settings.wakePhrase,
        sensitivity: settings.sensitivity,
        onTriggered: () => {
          det.stop();
          connectHandlerRef.current();
        },
      });
    } else {
      det.stop();
    }
  }, [settings.wakeWordEnabled, settings.wakePhrase, settings.sensitivity, liveState]);

  const handleSettingsChange = (patch: Partial<NuviSettings>) => {
    const next = saveSettings(patch);
    setSettings(next);
  };

  const sessionRef = useRef<NuviAudioSession | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement>(null);

  const addChatMsg = (role: ChatMsg["role"], text: string) => {
    setChatMessages((prev) => [...prev, { id: Math.random().toString(36).slice(2, 8), role, text }]);
  };

  // Fetch memories (uses VITE_BACKEND_URL when deployed)
  useEffect(() => {
    fetch(apiUrl("/api/memories"))
      .then((r) => r.json())
      .then((d) => { if (Array.isArray(d)) setMemories(d); })
      .catch(() => {});
  }, []);

  const handleAddMemory = async (category: MemoryCategory, text: string) => {
    try {
      const res = await fetch(apiUrl("/api/memories"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category, text }),
      });
      const saved = await res.json();
      if (saved?.id) setMemories((prev) => [...prev, saved]);
    } catch (e) { console.error(e); }
  };
  const handleDeleteMemory = async (id: string) => {
    try {
      await fetch(apiUrl(`/api/memories/${id}`), { method: "DELETE" });
      setMemories((prev) => prev.filter((m) => m.id !== id));
    } catch (e) { console.error(e); }
  };

  // Screen share helpers
  const captureFrameAndSend = () => {
    const video = screenVideoRef.current;
    if (!video || isPausedRef.current || !screenVisionRef.current) return;
    if (liveStateRef.current === "disconnected") return;
    try {
      if (video.videoWidth === 0 || video.videoHeight === 0) return;
      if (!screenCanvasRef.current) screenCanvasRef.current = document.createElement("canvas");
      const canvas = screenCanvasRef.current;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const maxDim = 960;
      let w = video.videoWidth, h = video.videoHeight;
      if (w > maxDim || h > maxDim) {
        if (w > h) { h = Math.round((h * maxDim) / w); w = maxDim; }
        else { w = Math.round((w * maxDim) / h); h = maxDim; }
      }
      canvas.width = w; canvas.height = h;
      ctx.drawImage(video, 0, 0, w, h);
      const b64 = canvas.toDataURL("image/jpeg", 0.55).split(",")[1];
      sessionRef.current?.sendVideoFrame(b64);
    } catch (e) { console.error("[Nuvi Screen] capture failed", e); }
  };

  const startScreenSharing = async () => {
    setErrorText(null);
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 5 } },
        audio: false,
      });
      screenStreamRef.current = stream;
      const video = document.createElement("video");
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      video.play().catch(() => {});
      screenVideoRef.current = video;
      setIsScreenSharing(true);
      setIsScreenSharingPaused(false);
      stream.getVideoTracks()[0].onended = () => stopScreenSharing();
      if (screenIntervalRef.current) clearInterval(screenIntervalRef.current);
      screenIntervalRef.current = setInterval(captureFrameAndSend, 2000);
      setTimeout(captureFrameAndSend, 500);
    } catch (e: any) {
      if (e.name !== "NotAllowedError") setErrorText(`Screen capture failed: ${e.message || e}`);
    }
  };
  const stopScreenSharing = () => {
    if (screenIntervalRef.current) { clearInterval(screenIntervalRef.current); screenIntervalRef.current = null; }
    if (screenStreamRef.current) { screenStreamRef.current.getTracks().forEach((t) => { try { t.stop(); } catch {} }); screenStreamRef.current = null; }
    if (screenVideoRef.current) { try { screenVideoRef.current.pause(); } catch {} screenVideoRef.current = null; }
    setIsScreenSharing(false);
    setIsScreenSharingPaused(false);
  };
  const pauseScreenSharing = () => setIsScreenSharingPaused(true);
  const resumeScreenSharing = () => { setIsScreenSharingPaused(false); setTimeout(captureFrameAndSend, 100); };
  const switchScreenShare = async () => {
    if (screenStreamRef.current) screenStreamRef.current.getTracks().forEach((t) => { try { t.stop(); } catch {} });
    await startScreenSharing();
  };

  const sendCameraFrameToSession = () => {
    const video = cameraVideoRef.current;
    if (!video || !cameraActiveRef.current || !cameraStreamRef.current || liveStateRef.current === "disconnected") return;
    try {
      if (video.videoWidth === 0 || video.videoHeight === 0) return;
      if (!cameraCanvasRef.current) cameraCanvasRef.current = document.createElement("canvas");
      const canvas = cameraCanvasRef.current;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const maxDim = 960;
      let w = video.videoWidth;
      let h = video.videoHeight;
      if (w > maxDim || h > maxDim) {
        if (w > h) { h = Math.round((h * maxDim) / w); w = maxDim; }
        else { w = Math.round((w * maxDim) / h); h = maxDim; }
      }

      canvas.width = w;
      canvas.height = h;
      ctx.drawImage(video, 0, 0, w, h);
      const b64 = canvas.toDataURL("image/jpeg", 0.6).split(",")[1];
      sessionRef.current?.sendVideoFrame(b64);
    } catch (e) {
      console.error("[Nuvi Camera] frame send failed", e);
    }
  };

  const stopCameraSession = () => {
    if (cameraIntervalRef.current) {
      clearInterval(cameraIntervalRef.current);
      cameraIntervalRef.current = null;
    }
    if (cameraStreamRef.current) {
      cameraStreamRef.current.getTracks().forEach((track) => track.stop());
      cameraStreamRef.current = null;
    }
    if (cameraVideoRef.current) {
      cameraVideoRef.current.srcObject = null;
    }
    cameraActiveRef.current = false;
    setIsCameraActive(false);
    setCameraStatus("Camera off");
  };

  const startCameraSession = async () => {
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        setCameraStatus("This browser cannot access a camera.");
        return;
      }
      // Prevent double-open if already active
      if (cameraActiveRef.current && cameraStreamRef.current) {
        setCameraStatus("Camera live");
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      cameraStreamRef.current = stream;
      setIsCameraActive(true);
      cameraActiveRef.current = true;
      setCameraStatus("Camera live");
      setCameraResult(null);

      if (cameraIntervalRef.current) clearInterval(cameraIntervalRef.current);
      cameraIntervalRef.current = setInterval(sendCameraFrameToSession, 2000);

      // Attach stream to video – handle both immediate mount and delayed mount via effect
      setTimeout(() => {
        if (cameraVideoRef.current) {
          if (cameraVideoRef.current.srcObject !== stream) {
            cameraVideoRef.current.srcObject = stream;
          }
          cameraVideoRef.current.play().catch(() => {});
          setTimeout(sendCameraFrameToSession, 300);
        }
      }, 100);
      // Extra retry for slow mounts (React state -> render)
      setTimeout(() => {
        if (cameraVideoRef.current && cameraVideoRef.current.srcObject !== stream) {
          cameraVideoRef.current.srcObject = stream;
          cameraVideoRef.current.play().catch(() => {});
        }
      }, 400);
    } catch (error: any) {
      setCameraStatus(error?.message || "Camera permission denied");
      setIsCameraActive(false);
      cameraActiveRef.current = false;
    }
  };

  const captureCameraBrowserFrame = (): string | null => {
    const video = cameraVideoRef.current;
    if (!video || video.videoWidth === 0 || video.videoHeight === 0) return null;
    try {
      const canvas = cameraCanvasRef.current || document.createElement("canvas");
      if (!cameraCanvasRef.current) cameraCanvasRef.current = canvas;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      const maxDim = 1280;
      let w = video.videoWidth;
      let h = video.videoHeight;
      if (w > maxDim || h > maxDim) {
        if (w > h) { h = Math.round((h * maxDim) / w); w = maxDim; }
        else { w = Math.round((w * maxDim) / h); h = maxDim; }
      }
      canvas.width = w;
      canvas.height = h;
      ctx.drawImage(video, 0, 0, w, h);
      return canvas.toDataURL("image/jpeg", 0.72).split(",")[1];
    } catch {
      return null;
    }
  };

  const runCameraAnalysis = async (mode: "analyze" | "ocr") => {
    try {
      setCameraStatus(mode === "analyze" ? "Analyzing camera scene…" : "Reading camera text…");
      const tool = mode === "analyze" ? "analyzeCameraFrame" : "readCameraText";
      // Prefer a browser-captured frame to avoid Windows MSMF exclusive-lock
      // conflict (error -1072875772) when getUserMedia already holds the device.
      let browserB64 = captureCameraBrowserFrame();
      // If video not ready yet, give it a moment and retry once
      if (!browserB64 && cameraActiveRef.current) {
        await new Promise((r) => setTimeout(r, 350));
        browserB64 = captureCameraBrowserFrame();
      }
      const args: Record<string, unknown> = {
        camera_id: 0,
        include_image: true,
        max_dim: 1280,
        max_chars: 2000,
      };
      if (browserB64) {
        args.image_base64 = browserB64;
      }
      // Use backend URL (Vercel or same-origin) — falls back to direct agent in Electron
      let response: Response | null = null;
      let data: any = null;
      try {
        response = await fetch(apiUrl("/api/desktop/execute"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tool, args }),
        });
        data = await response.json();
      } catch {
        // Fallback to direct desktop agent (dev / Electron)
        response = await fetch("http://127.0.0.1:8765/execute", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tool, args }),
        });
        data = await response.json();
      }
      if (!response || !response.ok || !data.ok) {
        // Web without desktop agent: graceful browser-only fallback
        if (!data?.ok && String(data?.error || "").toLowerCase().includes("not run") && browserB64) {
          setCameraResult({ result: "Browser preview only (desktop agent offline). Live video is streaming to Gemini.", image_base64: browserB64 });
          setCameraStatus(mode === "analyze" ? "Scene visible (browser-only)" : "Text capture (browser-only)");
          return;
        }
        throw new Error(data?.error || "Camera tool failed");
      }
      setCameraResult(data.result || {});
      setCameraStatus(mode === "analyze" ? "Scene analyzed" : "Text read");
    } catch (error: any) {
      setCameraStatus(error?.message || "Camera analysis failed");
    }
  };

  // Audio session
  useEffect(() => {
    sessionRef.current = new NuviAudioSession({
      onStateChange: (s) => {
        setLiveState(s);
        if (s === "disconnected") { setUserCaption(""); setModelCaption(""); }
      },
      onTranscription: (role, text) => {
        if (role === "user") {
          setUserCaption(text);
          setModelCaption("");
          addChatMsg("user", text);
        } else {
          setModelCaption((prev) => prev + text);
          setUserCaption("");
          // Append or update last assistant msg
          setChatMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last && last.role === "assistant") {
              return [...prev.slice(0, -1), { ...last, text: last.text + text }];
            }
            return [...prev, { id: Math.random().toString(36).slice(2, 8), role: "assistant", text }];
          });
        }
        setTimeout(() => transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
      },
      onToolCall: (name, args, callback) => {
        addChatMsg("tool", `${name}(${JSON.stringify(args).slice(0, 80)})`);
        if (name === "changeBackground") {
          const c = (args.color || "").toLowerCase();
          const ok = ["violet","crimson","emerald","celestial","gold","rose","charcoal"];
          if (ok.includes(c)) { setThemeColor(c); callback({ result: `Theme changed to ${c}` }); }
          else callback({ error: `Unsupported color ${c}` });
        } else if (name === "openCamera" || name === "startCamera" || name === "enableCamera") {
          (async () => {
            try {
              await startCameraSession();
              // Give mount a moment before confirming
              await new Promise((r) => setTimeout(r, 500));
              if (cameraActiveRef.current) callback({ result: "Camera opened – preview is live and streaming to session." });
              else callback({ error: "Failed to open camera – permission denied or no device." });
            } catch (e: any) {
              callback({ error: e?.message || "Failed to open camera" });
            }
          })();
          return;
        } else if (name === "closeCamera" || name === "stopCamera" || name === "disableCamera") {
          stopCameraSession();
          callback({ result: "Camera closed." });
        } else if (["captureCameraFrame", "analyzeCameraFrame", "readCameraText"].includes(name)) {
          // Route camera capture through browser preview to avoid MSMF exclusive lock
          (async () => {
            try {
              if (!cameraActiveRef.current) {
                try { await startCameraSession(); await new Promise((r) => setTimeout(r, 700)); } catch {}
              }
              let b64 = captureCameraBrowserFrame();
              if (!b64 && cameraActiveRef.current) {
                await new Promise((r) => setTimeout(r, 350));
                b64 = captureCameraBrowserFrame();
              }
              const fwdArgs: Record<string, any> = { ...(args || {}) };
              if (b64) fwdArgs.image_base64 = b64;
              // Prefer backend URL (Vercel or same-origin), fallback to direct agent
              let res: Response | null = null;
              let data: any = null;
              try {
                res = await fetch(apiUrl("/api/desktop/execute"), {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ tool: name, args: fwdArgs }),
                });
                data = await res.json();
              } catch {
                res = await fetch("http://127.0.0.1:8765/execute", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ tool: name, args: fwdArgs }),
                });
                data = await res.json();
              }
              if (res && res.ok && data.ok) {
                if (data.result) setCameraResult(data.result);
                // Update status for UI feedback
                if (name === "analyzeCameraFrame") setCameraStatus("Scene analyzed");
                else if (name === "readCameraText") setCameraStatus("Text read");
                else setCameraStatus("Camera frame captured");
                callback({ result: data.result });
              } else {
                // Browser-only fallback when agent unavailable but we have a frame
                if (String(data?.error || "").toLowerCase().includes("not run") && b64) {
                  const fallback = { result: "Captured browser frame (desktop agent offline – preview is live).", image_base64: b64, camera_id: 0 } as any;
                  setCameraResult(fallback);
                  setCameraStatus("Camera frame captured (browser-only)");
                  callback({ result: fallback });
                } else {
                  callback({ error: data?.error || `Camera tool ${name} failed` });
                }
              }
            } catch (e: any) {
              callback({ error: e?.message || `Camera ${name} failed` });
            }
          })();
          return;
        } else {
          callback({ result: `Desktop control is handling ${name}; browser and app actions execute through the real desktop automation layer.` });
        }
      },
      onError: (msg) => setErrorText(msg),
      onMemorySync: (updated) => { if (Array.isArray(updated)) setMemories(updated); },
    });
    return () => sessionRef.current?.disconnect();
  }, []); // eslint-disable-line

  const handleToggleConnection = async () => {
    setErrorText(null);
    if (!sessionRef.current) return;
    if (liveState === "disconnected") await sessionRef.current.connect();
    else sessionRef.current.disconnect();
  };
  connectHandlerRef.current = handleToggleConnection;

  // Scroll chat on new messages
  useEffect(() => { transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [chatMessages]);

  const sendTypedText = async () => {
    const t = textInput.trim();
    if (!t) return;
    setTextInput("");
    addChatMsg("user", t);
    setTimeout(() => transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
    // When live is active, route chat through Gemini Live so Nuvi talks + texts back
    const sent = sessionRef.current?.sendTextMessage(t) ?? false;
    if (!sent) {
      // Offline: queue as visual-only and nudge user to activate voice
      addChatMsg("assistant", "I'm offline right now - tap the orb to wake me and I'll reply with voice too!");
    }
  };

  const orbState: "idle" | "listening" | "thinking" | "speaking" =
    liveState === "disconnected" ? "idle" : liveState === "connecting" ? "thinking" : liveState;

  // Amplitude hook for orb
  const [amp, setAmp] = useState(0);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const s = sessionRef.current;
      let analyser: AnalyserNode | null = null;
      if (liveState === "speaking" && s?.outputAnalyser) analyser = s.outputAnalyser;
      else if (liveState === "listening" && s?.inputAnalyser) analyser = s.inputAnalyser;
      if (analyser) {
        const arr = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(arr);
        let sum = 0; for (let i = 0; i < arr.length; i++) sum += arr[i];
        setAmp(sum / arr.length / 255);
      } else {
        setAmp((prev) => prev * 0.92);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [liveState]);

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-[var(--bg)] text-[var(--text)]">
      {/* Titlebar */}
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-[var(--border-soft)] bg-[var(--bg-elevated)] px-4">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-[var(--accent)] shadow-[0_0_8px_var(--accent-glow)]" />
          <span className="font-mono text-xs tracking-[0.32em] text-[var(--text-dim)]">NUVI AI</span>
          <span className={`ml-2 h-1.5 w-1.5 rounded-full ${liveState !== "disconnected" ? "bg-emerald-400 shadow-[0_0_6px_rgba(16,185,129,0.6)] animate-pulse" : "bg-white/10"}`} />
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => setShowMemoryDashboard(true)} className="rounded-lg p-1.5 text-[var(--text-faint)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)] transition" title="Memory">
            <Brain size={16} />
          </button>
          <button onClick={() => setShowSettings(true)} className="rounded-lg p-1.5 text-[var(--text-faint)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)] transition" title="Settings">
            <SettingsIcon size={16} />
          </button>
          <button onClick={() => window.close()} className="ml-1 rounded-lg px-2 py-1 text-[var(--text-faint)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]" title="Close">×</button>
        </div>
      </div>

      {/* Main grid: stage + sidebar */}
      <div className="flex flex-1 overflow-hidden">
        {/* Stage */}
        <div className="relative flex flex-1 flex-col items-center justify-center overflow-hidden bg-[var(--bg)]">
          {/* Ambient glows */}
          <div className="pointer-events-none absolute -left-32 -top-32 h-[420px] w-[420px] rounded-full bg-[var(--accent)] opacity-[0.06] blur-[100px]" />
          <div className="pointer-events-none absolute -bottom-32 -right-32 h-[520px] w-[520px] rounded-full bg-[var(--orb-glow)] opacity-[0.05] blur-[120px]" />
          <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.012)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.012)_1px,transparent_1px)] bg-[size:32px_32px] opacity-30" />

          {/* Orb */}
          <div className="relative z-10 flex flex-col items-center gap-6">
            <NuviOrb state={orbState} amplitude={amp} size={260} />
            {/* Cinematic captions */}
            <div className="flex min-h-[3.5rem] max-w-[640px] flex-col items-center justify-center px-6 text-center">
              <AnimatePresence mode="wait">
                {(modelCaption || userCaption) ? (
                  <motion.div
                    key={modelCaption ? "model" : "user"}
                    initial={{ opacity: 0, y: 10, filter: "blur(4px)" }}
                    animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                    exit={{ opacity: 0, y: -10, filter: "blur(4px)" }}
                    transition={{ duration: 0.45 }}
                    className="flex flex-col items-center"
                  >
                    {modelCaption ? (
                      <p className="font-display text-[15px] font-light leading-relaxed tracking-wide text-[var(--text)] drop-shadow-[0_2px_18px_rgba(0,0,0,0.6)]">{modelCaption}</p>
                    ) : (
                      <p className="flex items-center gap-2 font-mono text-sm text-[#7dd3fc] drop-shadow-[0_1px_8px_rgba(0,0,0,0.6)]">
                        <span className="h-1.5 w-1.5 rounded-full bg-[#7dd3fc] animate-pulse" />“{userCaption}”
                      </p>
                    )}
                  </motion.div>
                ) : (
                  <motion.div
                    key="status"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="font-mono text-xs uppercase tracking-[0.18em] text-[var(--text-faint)]"
                  >
                    {liveState === "listening" ? "Listening — speak freely…" : liveState === "connecting" ? "Connecting to Gemini Live…" : liveState === "speaking" ? "Nuvi is speaking…" : "Tap the orb to awake Nuvi"}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
            {/* Error */}
            <AnimatePresence>
              {errorText && (
                <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }} className="flex max-w-md items-start gap-3 rounded-2xl border border-red-500/20 bg-red-950/30 px-4 py-3 backdrop-blur">
                  <AlertCircle size={16} className="mt-0.5 shrink-0 text-red-400" />
                  <div className="flex-1">
                    <div className="font-mono text-xs font-bold uppercase tracking-wide text-red-300">Attention</div>
                    <div className="mt-1 text-xs leading-relaxed text-red-200">{errorText}</div>
                    <button onClick={() => setErrorText(null)} className="mt-2 font-mono text-xs text-red-300 underline">Dismiss</button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Controls */}
          <div className="absolute bottom-6 left-0 right-0 z-10 flex flex-col items-center gap-3">
            {/* Waveform hint */}
            <div className="flex h-6 items-center gap-1">
              {[10, 22, 14, 26, 18, 9].map((h, i) => {
                let hf = 0.3;
                if (liveState === "speaking") hf = 0.3 + Math.sin(Date.now() * 0.015 + i) * 0.5 + amp * 0.6;
                else if (liveState === "listening") hf = 0.2 + Math.sin(Date.now() * 0.008 + i) * 0.3 + amp * 0.4;
                return <div key={i} className={`w-0.5 rounded-full transition-all duration-200 ${liveState === "speaking" ? "bg-[var(--accent)]" : liveState === "listening" ? "bg-emerald-400" : "bg-white/10"}`} style={{ height: `${Math.max(3, h * hf)}px` }} />;
              })}
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={isScreenSharing ? stopScreenSharing : startScreenSharing}
                className={`flex h-10 w-10 items-center justify-center rounded-full border transition ${isScreenSharing ? "border-emerald-500/30 bg-emerald-500/15 text-emerald-300" : "border-[var(--border)] bg-[var(--bg-panel)] text-[var(--text-faint)] hover:border-[var(--accent)]/30 hover:text-[var(--text)]"}`}
                title={isScreenSharing ? "Stop screen share" : "Share screen"}
              >
                <Monitor size={16} />
              </button>
              <button
                onClick={isCameraActive ? stopCameraSession : startCameraSession}
                className={`flex h-10 w-10 items-center justify-center rounded-full border transition ${isCameraActive ? "border-[var(--accent)]/35 bg-[var(--accent)]/10 text-[var(--accent)] shadow-[0_0_18px_var(--accent-glow)]" : "border-[var(--border)] bg-[var(--bg-panel)] text-[var(--text-faint)] hover:border-[var(--accent)]/30 hover:text-[var(--text)]"}`}
                title={isCameraActive ? "Close camera" : "Open camera"}
              >
                <Video size={16} />
              </button>
              <button
                onClick={handleToggleConnection}
                className={`flex h-16 w-16 items-center justify-center rounded-full border transition ${liveState === "disconnected" ? "border-white/10 bg-white/[0.06] text-white hover:bg-white/[0.10] hover:border-white/20" : liveState === "listening" ? "border-emerald-400/60 bg-emerald-500/15 text-emerald-200 shadow-[0_0_24px_rgba(16,185,129,0.25)]" : liveState === "speaking" ? "border-[var(--accent)] bg-[var(--accent)] text-white shadow-[0_0_24px_var(--accent-glow)]" : "border-amber-400/50 bg-amber-500/15 text-amber-200"}`}
                title={liveState === "disconnected" ? "Awake Nuvi" : "Sleep"}
              >
                {liveState === "disconnected" ? <Power size={20} /> : liveState === "connecting" ? <RefreshCw size={20} className="animate-spin" /> : liveState === "listening" ? <Mic size={20} /> : <Volume2 size={20} />}
              </button>
              <button
                onClick={() => setActiveTab("chat")}
                className="flex h-10 w-10 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--bg-panel)] text-[var(--text-faint)] hover:border-[var(--accent)]/30 hover:text-[var(--text)] transition"
                title="Focus chat input"
              >
                <Keyboard size={16} />
              </button>
            </div>
            <div className="font-mono text-[10px] uppercase tracking-widest text-[var(--text-faint)] flex items-center gap-1.5">
              <Sparkles size={10} className="text-[var(--accent)]" />
              {liveState === "disconnected" && settings.wakeWordEnabled ? `Wake word "${settings.wakePhrase}" active — or tap orb` : liveState === "disconnected" ? "Tap orb or press Space to awake" : liveState === "listening" ? "Listening — just talk, tap again to sleep" : liveState === "speaking" ? "Nuvi speaking… tap to interrupt" : "Connecting…"}
            </div>
          </div>

          {/* Screen PIP */}
          <AnimatePresence>
            {isScreenSharing && (
              <motion.div
                initial={{ opacity: 0, scale: 0.92, x: 20 }}
                animate={{ opacity: 1, scale: 1, x: 0 }}
                exit={{ opacity: 0, scale: 0.92, x: 20 }}
                className="absolute bottom-6 right-6 z-20 flex w-72 flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)]/90 p-3 backdrop-blur-xl shadow-2xl"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 font-mono text-[10px] font-bold uppercase tracking-wider text-[var(--text)]">
                    <span className={`h-2 w-2 rounded-full ${isScreenSharingPaused ? "bg-amber-400" : "bg-emerald-400 animate-pulse"}`} />
                    {isScreenSharingPaused ? "Vision Paused" : "Screen Vision Active"}
                  </div>
                  <button onClick={stopScreenSharing} className="rounded-lg p-1 text-[var(--text-faint)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"><X size={14} /></button>
                </div>
                <div className="relative aspect-video overflow-hidden rounded-xl border border-[var(--border-soft)] bg-black">
                  <video
                    ref={(el) => {
                      if (el && screenStreamRef.current && el.srcObject !== screenStreamRef.current) {
                        el.srcObject = screenStreamRef.current;
                        el.play().catch(() => {});
                      }
                    }}
                    autoPlay
                    muted
                    playsInline
                    className={`h-full w-full object-cover ${isScreenSharingPaused ? "opacity-30 blur-sm" : "opacity-90"}`}
                  />
                  {isScreenSharingPaused && (
                    <div className="absolute inset-0 flex items-center justify-center">
                      <span className="rounded-md border border-amber-500/20 bg-amber-950/40 px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-widest text-amber-300">Transmission Paused</span>
                    </div>
                  )}
                </div>
                <div className="flex gap-1.5">
                  {isScreenSharingPaused ? (
                    <button onClick={resumeScreenSharing} className="flex flex-1 items-center justify-center gap-1 rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-2 py-1.5 font-mono text-xs text-emerald-300 hover:bg-emerald-500/15"><Play size={12} />Resume</button>
                  ) : (
                    <button onClick={pauseScreenSharing} className="flex flex-1 items-center justify-center gap-1 rounded-lg border border-amber-500/20 bg-amber-500/10 px-2 py-1.5 font-mono text-xs text-amber-300 hover:bg-amber-500/15"><Pause size={12} />Pause</button>
                  )}
                  <button onClick={switchScreenShare} className="rounded-lg border border-[var(--border)] bg-[var(--bg-panel)] px-2 py-1.5 font-mono text-xs text-[var(--text-dim)] hover:text-[var(--text)]"><RefreshCw size={12} /></button>
                  <button onClick={stopScreenSharing} className="rounded-lg border border-red-500/20 bg-red-500/10 px-2 py-1.5 font-mono text-xs text-red-300 hover:bg-red-500/15"><Square size={10} />Stop</button>
                </div>
                <label className="flex items-center justify-between border-t border-[var(--border-soft)] pt-2 font-mono text-[10px] text-[var(--text-dim)]">
                  <span>Vision Mode</span>
                  <input type="checkbox" checked={screenVisionMode} onChange={(e) => setScreenVisionMode(e.target.checked)} className="accent-[var(--accent)]" />
                </label>
              </motion.div>
            )}
            {isCameraActive && (
              <motion.div
                initial={{ opacity: 0, scale: 0.92, x: -20 }}
                animate={{ opacity: 1, scale: 1, x: 0 }}
                exit={{ opacity: 0, scale: 0.92, x: -20 }}
                className="absolute bottom-6 left-6 z-20 flex w-72 flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)]/90 p-3 backdrop-blur-xl shadow-2xl"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 font-mono text-[10px] font-bold uppercase tracking-wider text-[var(--text)]">
                    <span className="h-2 w-2 rounded-full bg-[var(--accent)] animate-pulse shadow-[0_0_12px_var(--accent-glow)]" />
                    Camera
                  </div>
                  <button onClick={stopCameraSession} className="rounded-lg p-1 text-[var(--text-faint)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"><X size={14} /></button>
                </div>
                <div className="relative aspect-video overflow-hidden rounded-xl border border-[var(--border-soft)] bg-black">
                  <video
                    ref={(el) => {
                      cameraVideoRef.current = el;
                      if (el && cameraStreamRef.current) {
                        if (el.srcObject !== cameraStreamRef.current) el.srcObject = cameraStreamRef.current;
                        el.play().catch(() => {});
                      }
                    }}
                    autoPlay
                    muted
                    playsInline
                    className="h-full w-full object-cover opacity-90"
                  />
                </div>
                <div className="font-mono text-[10px] uppercase tracking-widest text-[var(--text-dim)]">{cameraStatus}</div>
                <div className="flex gap-1.5">
                  <button onClick={() => runCameraAnalysis("analyze")} className="flex-1 rounded-lg border border-[var(--border)] bg-[var(--bg-panel)] px-2 py-1.5 font-mono text-[10px] text-[var(--text)] hover:border-[var(--accent)]/30 hover:text-[var(--accent)]">Analyze</button>
                  <button onClick={() => runCameraAnalysis("ocr")} className="flex-1 rounded-lg border border-[var(--border)] bg-[var(--bg-panel)] px-2 py-1.5 font-mono text-[10px] text-[var(--text)] hover:border-[var(--accent)]/30 hover:text-[var(--accent)]">Read text</button>
                </div>
                {cameraResult && (
                  <div className="rounded-lg border border-[var(--border-soft)] bg-[var(--bg-panel)] p-2 text-[10px] leading-relaxed text-[var(--text)]">
                    <div className="font-mono uppercase tracking-widest text-[var(--text-faint)]">Result</div>
                    {cameraResult.scene_summary && <div className="mt-1">{cameraResult.scene_summary}</div>}
                    {cameraResult.text && <div className="mt-1 whitespace-pre-wrap">{cameraResult.text}</div>}
                    {typeof cameraResult.objects_detected !== "undefined" && <div className="mt-1">Objects: {cameraResult.objects_detected}</div>}
                    {typeof cameraResult.brightness !== "undefined" && <div>Brightness: {cameraResult.brightness}</div>}
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Sidebar — Nuvi reference layout */}
        <div className="flex w-[360px] shrink-0 flex-col border-l border-[var(--border-soft)] bg-[var(--bg-elevated)]">
          <div className="flex border-b border-[var(--border-soft)]">
            {([
              { id: "chat", label: "Chat", icon: MessageSquare },
              { id: "settings", label: "Settings", icon: SlidersHorizontal },
              { id: "memory", label: "Memory", icon: Brain },
            ] as const).map((t) => {
              const Icon = t.icon;
              const active = activeTab === t.id;
              return (
                <button
                  key={t.id}
                  onClick={() => setActiveTab(t.id)}
                  className={`flex flex-1 items-center justify-center gap-1.5 border-b-2 py-3 font-mono text-xs transition ${active ? "border-[var(--accent)] text-[var(--accent)]" : "border-transparent text-[var(--text-faint)] hover:text-[var(--text)]"}`}
                >
                  <Icon size={13} /> {t.label}
                </button>
              );
            })}
          </div>

          {/* Chat panel */}
          {activeTab === "chat" && (
            <div className="flex flex-1 flex-col overflow-hidden">
              <div className="flex-1 space-y-3 overflow-y-auto p-4">
                {chatMessages.length === 0 && (
                  <div className="rounded-xl border border-dashed border-[var(--border)] bg-[var(--bg-panel)]/50 p-4 text-center">
                    <div className="mx-auto mb-2 flex h-8 w-8 items-center justify-center rounded-full bg-[var(--accent)]/15 text-[var(--accent)]"><MessageSquare size={14} /></div>
                    <div className="font-mono text-xs text-[var(--text-dim)]">No messages yet</div>
                    <div className="mt-1 font-mono text-[11px] leading-relaxed text-[var(--text-faint)]">Tap the orb to start talking, or type below. Nuvi can control your desktop, browse the web, and remember what you tell her.</div>
                  </div>
                )}
                {chatMessages.map((m) => (
                  <div key={m.id} className={`max-w-[92%] rounded-2xl px-3.5 py-2.5 text-[13px] leading-relaxed ${m.role === "user" ? "ml-auto bg-[var(--accent)] text-white" : m.role === "assistant" ? "border border-[var(--border-soft)] bg-[var(--bg-panel)] text-[var(--text)]" : "border border-dashed border-[var(--border-soft)] bg-transparent font-mono text-xs text-[var(--text-faint)]"}`}>
                    {m.text}
                  </div>
                ))}
                <div ref={transcriptEndRef} />
              </div>
              <div className="flex gap-2 border-t border-[var(--border-soft)] p-3">
                <input
                  value={textInput}
                  onChange={(e) => setTextInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") sendTypedText(); }}
                  placeholder="Type a message…"
                  className="flex-1 rounded-xl border border-[var(--border)] bg-[var(--bg-panel)] px-3 py-2 font-mono text-sm text-[var(--text)] placeholder:text-[var(--text-faint)] focus:border-[var(--accent)] focus:outline-none"
                />
                <button onClick={sendTypedText} className="flex items-center justify-center rounded-xl bg-[var(--accent)] px-3 py-2 text-white hover:brightness-110 disabled:opacity-40" disabled={!textInput.trim()}>
                  <Send size={16} />
                </button>
              </div>
              {/* Quick theme row */}
              <div className="flex gap-1.5 border-t border-[var(--border-soft)] p-3">
                {["claude-code","midnight","light"].map((th) => (
                  <button
                    key={th}
                    onClick={() => setTheme(th)}
                    className={`flex-1 rounded-lg border py-2 font-mono text-[11px] capitalize transition ${theme === th ? "border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]" : "border-[var(--border)] bg-[var(--bg-panel)] text-[var(--text-faint)] hover:border-[var(--text-faint)]"}`}
                  >
                    {th.replace("-", " ")}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Settings panel — inline */}
          {activeTab === "settings" && (
            <div className="flex-1 space-y-4 overflow-y-auto p-4">
              <div className="space-y-3">
                <div className="font-mono text-[11px] uppercase tracking-widest text-[var(--text-faint)]">Appearance</div>
                <div className="flex gap-1.5">
                  {[
                    { id: "charcoal", label: "Charcoal" },
                    { id: "violet", label: "Violet" },
                    { id: "emerald", label: "Emerald" },
                    { id: "celestial", label: "Celestial" },
                  ].map((c) => (
                    <button key={c.id} onClick={() => setThemeColor(c.id)} className={`flex-1 rounded-lg border px-2 py-1.5 font-mono text-[11px] capitalize ${themeColor === c.id ? "border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]" : "border-[var(--border)] text-[var(--text-faint)] hover:text-[var(--text)]"}`}>{c.label}</button>
                  ))}
                </div>
              </div>

              <div className="space-y-2 border-t border-[var(--border-soft)] pt-4">
                <div className="font-mono text-[11px] uppercase tracking-widest text-[var(--text-faint)]">Wake Word</div>
                <label className="flex items-center justify-between gap-3">
                  <span className="font-mono text-xs text-[var(--text-dim)]">Enable wake word</span>
                  <input type="checkbox" checked={settings.wakeWordEnabled} onChange={(e) => handleSettingsChange({ wakeWordEnabled: e.target.checked })} className="accent-[var(--accent)]" />
                </label>
                <input
                  value={settings.wakePhrase}
                  onChange={(e) => handleSettingsChange({ wakePhrase: e.target.value })}
                  placeholder="hey nuvi"
                  className="w-full rounded-xl border border-[var(--border)] bg-[var(--bg-panel)] px-3 py-2 font-mono text-sm text-[var(--text)] focus:border-[var(--accent)] focus:outline-none"
                />
                <div className="flex items-center justify-between">
                  <span className="font-mono text-xs text-[var(--text-dim)]">Sensitivity</span>
                  <span className="font-mono text-xs text-[var(--accent)]">{settings.sensitivity}</span>
                </div>
                <input type="range" min={0} max={100} value={settings.sensitivity} onChange={(e) => handleSettingsChange({ sensitivity: Number(e.target.value) })} className="w-full accent-[var(--accent)]" />
              </div>

              <div className="space-y-2 border-t border-[var(--border-soft)] pt-4">
                <div className="font-mono text-[11px] uppercase tracking-widest text-[var(--text-faint)]">System</div>
                <label className="flex items-center justify-between">
                  <span className="font-mono text-xs text-[var(--text-dim)]">Launch at startup</span>
                  <input type="checkbox" checked={settings.autoStart} onChange={(e) => handleSettingsChange({ autoStart: e.target.checked })} className="accent-[var(--accent)]" />
                </label>
                <label className="flex items-center justify-between">
                  <span className="font-mono text-xs text-[var(--text-dim)]">UI animations</span>
                  <input type="checkbox" checked={settings.animations} onChange={(e) => handleSettingsChange({ animations: e.target.checked })} className="accent-[var(--accent)]" />
                </label>
                <label className="flex items-center justify-between">
                  <span className="font-mono text-xs text-[var(--text-dim)]">Screen vision</span>
                  <button
                    onClick={isScreenSharing ? stopScreenSharing : startScreenSharing}
                    className={`rounded-full p-1 ${isScreenSharing ? "bg-emerald-500 text-white" : "bg-[var(--bg-panel)] text-[var(--text-faint)]"}`}
                  >
                    <Monitor size={14} />
                  </button>
                </label>
              </div>

              <div className="rounded-xl border border-[var(--border-soft)] bg-[var(--bg-panel)] p-3 font-mono text-[11px] leading-relaxed text-[var(--text-faint)]">
                <div className="font-semibold text-[var(--text)]">Models (Nuvi parity)</div>
                <div>Live: <code className="text-[var(--accent)]">gemini-3.1-flash-live-preview</code> (Aoede)</div>
                <div>Memory: <code className="text-[var(--accent)]">gemini-3.5-flash</code></div>
                <div>Vision: <code className="text-[var(--accent)]">gemini-2.5-flash</code></div>
              </div>

              <button onClick={() => setShowSettings(true)} className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-[var(--accent)] px-4 py-2.5 font-mono text-sm font-semibold text-white hover:brightness-110">
                <SettingsIcon size={14} /> Open Advanced Settings
              </button>
              <div className="rounded-xl border border-[var(--border-soft)] bg-[var(--bg-panel)]/60 p-3 text-center font-mono text-[10px] leading-relaxed tracking-wide text-[var(--text-faint)]">
                Developed with <span className="text-[var(--accent)]">♥</span> by <span className="font-semibold text-[var(--text)]">Naveen Shah and his team</span>
              </div>
            </div>
          )}

          {/* Memory panel — inline */}
          {activeTab === "memory" && (
            <div className="flex flex-1 flex-col overflow-hidden">
              <div className="flex-1 space-y-3 overflow-y-auto p-4">
                {memories.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-[var(--border)] bg-[var(--bg-panel)]/50 p-6 text-center">
                    <Brain size={20} className="mx-auto mb-2 text-[var(--text-faint)]" />
                    <div className="font-mono text-xs text-[var(--text-dim)]">No recollections yet</div>
                    <div className="mt-1 font-mono text-[11px] leading-relaxed text-[var(--text-faint)]">Nuvi will learn as you chat. Teach her something below.</div>
                  </div>
                ) : (
                  (() => {
                    const grouped: Record<string, Memory[]> = {};
                    memories.forEach((m) => { grouped[m.category] = grouped[m.category] || []; grouped[m.category].push(m); });
                    const order: MemoryCategory[] = ["identity","preference","goal","project","relationship","emotional","behavior"];
                    const labels: Record<string,string> = { identity:"Identity", preference:"Preferences", goal:"Goals", project:"Projects", relationship:"Relationships", emotional:"Emotional", behavior:"Behavior" };
                    return order.map((cat) => {
                      const list = grouped[cat] || [];
                      if (list.length === 0) return null;
                      return (
                        <div key={cat} className="space-y-2">
                          <div className="font-mono text-[11px] uppercase tracking-widest text-[var(--accent)]">{labels[cat]} ({list.length})</div>
                          {list.map((m) => (
                            <div key={m.id} className="flex items-start justify-between gap-2 rounded-xl border border-[var(--border-soft)] bg-[var(--bg-panel)] p-3">
                              <span className="flex-1 font-mono text-xs leading-relaxed text-[var(--text)]">{m.text}</span>
                              <button onClick={() => handleDeleteMemory(m.id)} className="shrink-0 rounded-lg p-1 text-[var(--text-faint)] hover:bg-red-500/10 hover:text-red-400"><X size={12} /></button>
                            </div>
                          ))}
                        </div>
                      );
                    });
                  })()
                )}
              </div>
              <div className="border-t border-[var(--border-soft)] p-3">
                <MemoryInlineForm onSave={handleAddMemory} />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Overlays: BrowserAgent, Drawers */}
      <AnimatePresence>
      </AnimatePresence>
      <MemoryDashboard isOpen={showMemoryDashboard} onClose={() => setShowMemoryDashboard(false)} memories={memories} onAddMemory={handleAddMemory} onDeleteMemory={handleDeleteMemory} themeColor={themeColor} />
      <SettingsPanel isOpen={showSettings} onClose={() => setShowSettings(false)} settings={settings} onChange={handleSettingsChange} themeColor={themeColor} />

      {/* Footer - Developer credit */}
      <div className="shrink-0 border-t border-[var(--border-soft)] bg-[var(--bg-elevated)] px-4 py-2 text-center font-mono text-[10px] tracking-widest text-[var(--text-faint)]">
        Developed by <span className="font-semibold text-[var(--text-dim)]">Naveen Shah and his team</span> · Nuvi v1.0.1
      </div>
    </div>
  );
}

function MemoryInlineForm({ onSave }: { onSave: (cat: MemoryCategory, text: string) => Promise<void> }) {
  const [cat, setCat] = useState<MemoryCategory>("preference");
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (!text.trim()) return;
        setSaving(true);
        await onSave(cat, text.trim());
        setText("");
        setSaving(false);
      }}
      className="space-y-2"
    >
      <select value={cat} onChange={(e) => setCat(e.target.value as MemoryCategory)} className="w-full rounded-xl border border-[var(--border)] bg-[var(--bg-panel)] px-3 py-2 font-mono text-xs text-[var(--text)] focus:border-[var(--accent)] focus:outline-none">
        <option value="preference">Preference</option>
        <option value="identity">Identity</option>
        <option value="goal">Goal</option>
        <option value="project">Project</option>
        <option value="relationship">Relationship</option>
        <option value="emotional">Emotional</option>
        <option value="behavior">Behavior</option>
      </select>
      <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. I prefer dark mode and monospace fonts" rows={2} className="w-full resize-none rounded-xl border border-[var(--border)] bg-[var(--bg-panel)] px-3 py-2 font-mono text-xs text-[var(--text)] placeholder:text-[var(--text-faint)] focus:border-[var(--accent)] focus:outline-none" />
      <button type="submit" disabled={saving || !text.trim()} className="w-full rounded-xl bg-[var(--accent)] py-2 font-mono text-xs font-semibold text-white hover:brightness-110 disabled:opacity-40">{saving ? "Saving…" : "Save to memory"}</button>
    </form>
  );
}
