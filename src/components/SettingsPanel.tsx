import React, { useEffect, useState } from "react";
import {
  Settings,
  X,
  Power,
  Mic,
  Cpu,
  Info,
  Check,
  AlertTriangle,
  Volume2,
  Sparkles,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import {
  NuviSettings,
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
} from "../lib/settingsStore";
import { apiUrl } from "../lib/config";

interface SettingsPanelProps {
  isOpen: boolean;
  onClose: () => void;
  /** Current settings (owned by App so wake-word state stays in sync). */
  settings: NuviSettings;
  /** Persist a settings patch (also notifies App of changes). */
  onChange: (patch: Partial<NuviSettings>) => void;
  themeColor: string;
}

type SettingsTab = "general" | "voice" | "system" | "about";

/** A single toggle row matching the existing "Screen Vision Mode" switch style. */
function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="pt-2 border-t border-[var(--border-soft)] flex items-center justify-between text-left">
      <div className="flex flex-col">
        <span className="text-[10px] font-bold font-mono text-slate-200">{label}</span>
        <span className="text-[8px] text-[var(--text-dim)] uppercase font-mono max-w-[200px]">
          {description}
        </span>
      </div>
      <button
        onClick={() => onChange(!checked)}
        className={`w-10 h-5 rounded-full p-0.5 transition-colors duration-200 focus:outline-none cursor-pointer ${
          checked ? "bg-[var(--accent)]" : "bg-[var(--border)]"
        }`}
      >
        <div
          className={`bg-white w-4 h-4 rounded-full shadow-md transform duration-200 ease-in-out ${
            checked ? "translate-x-5" : "translate-x-0"
          }`}
        />
      </button>
    </div>
  );
}

export function SettingsPanel({ isOpen, onClose, settings, onChange, themeColor }: SettingsPanelProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>("general");
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [agentHealth, setAgentHealth] = useState<{
    online: boolean;
    toolCount?: number;
    cpu?: string;
    ram?: string;
  }>({ online: false });

  // Enumerate microphones (mirrors how audio.ts grabs getUserMedia).
  useEffect(() => {
    if (!isOpen) return;
    const enumerate = async () => {
      try {
        if (!navigator.mediaDevices?.enumerateDevices) return;
        const devices = await navigator.mediaDevices.enumerateDevices();
        setMics(devices.filter((d) => d.kind === "audioinput"));
      } catch {
        /* permission may be needed first */
      }
    };
    enumerate();
  }, [isOpen]);

  // Probe desktop agent health (port 8765) via the server-side logs/health proxy.
  useEffect(() => {
    if (!isOpen) return;
    const probe = async () => {
      try {
        // Re-use the local agent directly (same machine, same browser).
        const res = await fetch("http://127.0.0.1:8765/health", { cache: "no-store" });
        if (!res.ok) {
          setAgentHealth({ online: false });
          return;
        }
        const data = await res.json();
        setAgentHealth({ online: true, toolCount: data.tool_count });
      } catch {
        // Cross-origin may fail; try the server proxy (Vercel or same-origin) as fallback.
        try {
          const res2 = await fetch(apiUrl("/api/agent-health"), { cache: "no-store" });
          if (res2.ok) {
            const d = await res2.json();
            setAgentHealth({ online: !!d.online, toolCount: d.tool_count });
            return;
          }
        } catch {
          /* ignore */
        }
        setAgentHealth({ online: false });
      }
    };
    probe();
    const id = setInterval(probe, 5000);
    return () => clearInterval(id);
  }, [isOpen]);

  const getThemeBadgeGlow = () => {
    switch (themeColor) {
      case "violet": return "border-purple-500/30 text-purple-400 bg-purple-500/10";
      case "crimson": return "border-rose-500/30 text-rose-400 bg-rose-500/10";
      case "emerald": return "border-emerald-500/30 text-emerald-400 bg-emerald-500/10";
      case "celestial": return "border-sky-500/30 text-sky-400 bg-sky-500/10";
      case "gold": return "border-amber-500/30 text-amber-400 bg-amber-500/10";
      case "rose": return "border-pink-500/30 text-pink-400 bg-pink-500/10";
      case "charcoal":
      default:
        return "border-indigo-500/30 text-indigo-400 bg-indigo-500/10";
    }
  };

  const tabs: { id: SettingsTab; label: string; icon: any }[] = [
    { id: "general", label: "GENERAL", icon: Power },
    { id: "voice", label: "VOICE", icon: Mic },
    { id: "system", label: "SYSTEM", icon: Cpu },
    { id: "about", label: "ABOUT", icon: Info },
  ];

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop Overlay — identical to MemoryDashboard */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="absolute inset-0 bg-[var(--bg)]/60 z-40 backdrop-blur-sm"
          />

          {/* Slide-over Container — identical shell to MemoryDashboard */}
          <motion.div
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "spring", damping: 25, stiffness: 200 }}
            className="absolute inset-y-0 right-0 w-full max-w-lg bg-[var(--bg-elevated)]/95 border-l border-[var(--border-soft)] backdrop-blur-2xl z-50 flex flex-col shadow-[0_0_50px_rgba(0,0,0,0.8)]"
          >
            {/* Header */}
            <div className="p-6 border-b border-[var(--border-soft)] flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className={`p-2.5 rounded-xl border ${getThemeBadgeGlow()}`}>
                  <Settings size={22} className="animate-spin [animation-duration:6s]" />
                </div>
                <div>
                  <h3 className="font-display font-medium text-lg tracking-tight text-[var(--text)] flex items-center gap-2">
                    Nuvi Configuration
                    <Sparkles size={14} className="text-[var(--accent)]" />
                  </h3>
                  <p className="text-[10px] font-mono uppercase tracking-widest text-[var(--text-dim)] mt-0.5">
                    System settings &amp; preferences
                  </p>
                </div>
              </div>
              <button
                onClick={onClose}
                className="p-2 rounded-xl border border-[var(--border-soft)] bg-[var(--bg-panel)] hover:bg-[var(--bg-hover)] text-[var(--text-dim)] hover:text-[var(--text)] transition cursor-pointer"
              >
                <X size={18} />
              </button>
            </div>

            {/* Tab selector row — mirrors MemoryDashboard pill style */}
            <div className="px-6 py-4 border-b border-[var(--border-soft)] flex items-center gap-2 overflow-x-auto">
              {tabs.map((t) => {
                const Icon = t.icon;
                const active = activeTab === t.id;
                return (
                  <button
                    key={t.id}
                    onClick={() => setActiveTab(t.id)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-xs font-mono tracking-wider transition shrink-0 cursor-pointer ${
                      active
                        ? "border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]"
                        : "border-[var(--border-soft)] bg-[var(--bg-panel)] text-[var(--text-dim)] hover:bg-[var(--bg-hover)]"
                    }`}
                  >
                    <Icon size={12} />
                    <span>{t.label}</span>
                  </button>
                );
              })}
            </div>

            {/* Scrollable content area */}
            <div className="flex-1 overflow-y-auto p-6 space-y-5">
              {/* ---------------- GENERAL ---------------- */}
              {activeTab === "general" && (
                <div className="space-y-4">
                  <div className="text-[10px] font-mono uppercase tracking-widest text-[var(--text-faint)]">
                    Startup &amp; Appearance
                  </div>

                  <ToggleRow
                    label="LAUNCH AT STARTUP"
                    description="Start Nuvi silently when Windows logs in"
                    checked={settings.autoStart}
                    onChange={(v) => {
                      onChange({ autoStart: v });
                      // Persist + push to backend; the desktop agent flips the
                      // HKCU Run registry key. We just record intent here.
                      void fetch(apiUrl("/api/settings"), {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ autoStart: v }),
                      }).catch(() => {});
                    }}
                  />

                  <ToggleRow
                    label="UI ANIMATIONS"
                    description="Enable motion and orb transitions"
                    checked={settings.animations}
                    onChange={(v) => onChange({ animations: v })}
                  />

                  {settings.autoStart && (
                    <div className="mt-2 p-3 rounded-xl border border-emerald-500/20 bg-emerald-500/5 flex items-center gap-2">
                      <Check size={14} className="text-emerald-400 shrink-0" />
                      <span className="text-[10px] font-mono text-emerald-300/80">
                        Nuvi will auto-launch on next Windows login.
                      </span>
                    </div>
                  )}
                </div>
              )}

              {/* ---------------- VOICE ---------------- */}
              {activeTab === "voice" && (
                <div className="space-y-4">
                  <div className="text-[10px] font-mono uppercase tracking-widest text-[var(--text-faint)]">
                    Wake Word &amp; Microphone
                  </div>

                  <ToggleRow
                    label="WAKE WORD"
                    description="Always-listen for the activation phrase"
                    checked={settings.wakeWordEnabled}
                    onChange={(v) => onChange({ wakeWordEnabled: v })}
                  />

                  <div className="space-y-1.5">
                    <label className="block text-[10px] font-mono tracking-wider text-[var(--text)] uppercase">
                      Wake Phrase
                    </label>
                    <input
                      type="text"
                      value={settings.wakePhrase}
                      onChange={(e) => onChange({ wakePhrase: e.target.value })}
                      placeholder="hey nuvi"
                      className="w-full px-3 py-2 rounded-xl border border-[var(--border-soft)] bg-[var(--bg-panel)] text-sm text-[var(--text)] font-mono focus:outline-none focus:border-[var(--accent)]/50 transition"
                    />
                    <span className="text-[8px] text-[var(--text-faint)] uppercase font-mono">
                      Say this phrase to activate Nuvi
                    </span>
                  </div>

                  <div className="space-y-1.5">
                    <label className="block text-[10px] font-mono tracking-wider text-[var(--text)] uppercase">
                      Microphone
                    </label>
                    <select
                      value={settings.micDeviceId}
                      onChange={(e) => onChange({ micDeviceId: e.target.value })}
                      className="w-full px-3 py-2 rounded-xl border border-[var(--border-soft)] bg-[var(--bg-panel)] text-sm text-[var(--text)] font-mono focus:outline-none focus:border-[var(--accent)]/50 transition cursor-pointer"
                    >
                      <option value="">System Default</option>
                      {mics.map((m, i) => (
                        <option key={m.deviceId || i} value={m.deviceId}>
                          {m.label || `Microphone ${i + 1}`}
                        </option>
                      ))}
                    </select>
                    <span className="text-[8px] text-[var(--text-faint)] uppercase font-mono">
                      {mics.length === 0
                        ? "Grant mic permission to list devices"
                        : `${mics.length} device(s) detected`}
                    </span>
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <label className="block text-[10px] font-mono tracking-wider text-[var(--text)] uppercase">
                        Sensitivity
                      </label>
                      <span className="text-[10px] font-mono text-[var(--accent)]">
                        {settings.sensitivity}
                      </span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={settings.sensitivity}
                      onChange={(e) => onChange({ sensitivity: Number(e.target.value) })}
                      className="w-full accent-[var(--accent)] cursor-pointer"
                    />
                    <span className="text-[8px] text-[var(--text-faint)] uppercase font-mono">
                      Higher = faster re-arm &amp; more matches
                    </span>
                  </div>
                </div>
              )}

              {/* ---------------- SYSTEM ---------------- */}
              {activeTab === "system" && (
                <div className="space-y-4">
                  <div className="text-[10px] font-mono uppercase tracking-widest text-[var(--text-faint)]">
                    Desktop Control Agent
                  </div>

                  <div
                    className={`p-4 rounded-xl border flex items-center gap-3 ${
                      agentHealth.online
                        ? "border-emerald-500/20 bg-emerald-500/5"
                        : "border-rose-500/20 bg-rose-500/5"
                    }`}
                  >
                    <div
                      className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                        agentHealth.online ? "bg-emerald-400 animate-pulse" : "bg-rose-400"
                      }`}
                    />
                    <div className="flex-1">
                      <div className="text-xs font-mono text-[var(--text)]">
                        {agentHealth.online ? "Agent Online" : "Agent Offline"}
                      </div>
                      <div className="text-[10px] font-mono text-[var(--text-dim)]">
                        {agentHealth.online
                          ? `${agentHealth.toolCount ?? 0} tools registered`
                          : "Start the Python agent on port 8765"}
                      </div>
                    </div>
                    <Cpu size={16} className="text-[var(--text-faint)]" />
                  </div>

                  <div className="p-3 rounded-xl border border-[var(--border-soft)] bg-[var(--bg-panel)] space-y-2">
                    <div className="flex items-center gap-2 text-[10px] font-mono text-[var(--text-dim)] uppercase tracking-wider">
                      <Volume2 size={12} /> Capabilities
                    </div>
                    <div className="grid grid-cols-2 gap-1.5 text-[10px] font-mono text-[var(--text)]">
                      <span className="inline-flex items-center gap-1"><Check size={10} className="text-emerald-400" /> App control</span>
                      <span className="inline-flex items-center gap-1"><Check size={10} className="text-emerald-400" /> Browser</span>
                      <span className="inline-flex items-center gap-1"><Check size={10} className="text-emerald-400" /> Volume</span>
                      <span className="inline-flex items-center gap-1"><Check size={10} className="text-emerald-400" /> Brightness</span>
                      <span className="inline-flex items-center gap-1"><Check size={10} className="text-emerald-400" /> Power</span>
                      <span className="inline-flex items-center gap-1"><Check size={10} className="text-emerald-400" /> Files</span>
                      <span className="inline-flex items-center gap-1"><Check size={10} className="text-emerald-400" /> Screenshot</span>
                      <span className="inline-flex items-center gap-1"><Check size={10} className="text-emerald-400" /> Clipboard</span>
                    </div>
                  </div>
                </div>
              )}

              {/* ---------------- ABOUT ---------------- */}
              {activeTab === "about" && (
                <div className="space-y-4">
                  <div className="text-[10px] font-mono uppercase tracking-widest text-[var(--text-faint)]">
                    About Nuvi
                  </div>

                  <div className="p-4 rounded-xl border border-[var(--border-soft)] bg-[var(--bg-panel)] space-y-3">
                    <div className="flex items-center gap-2">
                      <Info size={14} className="text-[var(--accent)]" />
                      <span className="text-sm font-display text-[var(--text)]">NUVI AI Assistant</span>
                    </div>
                    <div className="space-y-1.5 text-[10px] font-mono text-[var(--text-dim)]">
                      <div className="flex justify-between">
                        <span>VERSION</span>
                        <span className="text-[var(--text)]">V2.0.0</span>
                      </div>
                      <div className="flex justify-between">
                        <span>ENGINE</span>
                        <span className="text-[var(--text)]">Gemini Live</span>
                      </div>
                      <div className="flex justify-between">
                        <span>DESKTOP</span>
                        <span className="text-[var(--text)]">FastAPI Agent</span>
                      </div>
                      <div className="flex justify-between">
                        <span>WAKE WORD</span>
                        <span className="text-[var(--text)]">Web Speech API</span>
                      </div>
                    </div>
                  </div>

                  <div className="p-3 rounded-xl border border-amber-500/15 bg-amber-500/5 flex items-start gap-2">
                    <AlertTriangle size={12} className="text-amber-400 shrink-0 mt-0.5" />
                    <span className="text-[10px] font-mono text-amber-300/70 leading-relaxed">
                      Keep this tab active for wake-word detection. Microphone access
                      is required for voice activation.
                    </span>
                  </div>
                </div>
              )}
            </div>

            {/* Footer status bar — mirrors MemoryDashboard */}
            <div className="px-6 py-3 border-t border-[var(--border-soft)] bg-[var(--bg-panel)] flex items-center justify-between">
              <span className="text-[9px] font-mono uppercase tracking-widest text-[var(--text-faint)]">
                Preferences auto-save
              </span>
              <span className="text-[9px] font-mono uppercase tracking-widest text-[var(--text-faint)]">
                Nuvi V2
              </span>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
