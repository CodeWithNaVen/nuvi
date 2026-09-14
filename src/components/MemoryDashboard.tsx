import React, { useState } from "react";
import { Memory, MemoryCategory } from "../lib/memoryTypes";
import { 
  Brain, 
  X, 
  Trash2, 
  Plus, 
  User, 
  Heart, 
  Target, 
  Briefcase, 
  Users, 
  Flame, 
  Sparkles,
  RefreshCw
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

interface MemoryDashboardProps {
  isOpen: boolean;
  onClose: () => void;
  memories: Memory[];
  onAddMemory: (category: MemoryCategory, text: string) => Promise<void>;
  onDeleteMemory: (id: string) => Promise<void>;
  themeColor: string;
}

export function MemoryDashboard({
  isOpen,
  onClose,
  memories,
  onAddMemory,
  onDeleteMemory,
  themeColor
}: MemoryDashboardProps) {
  const [activeTab, setActiveTab] = useState<MemoryCategory | "all">("all");
  const [newText, setNewText] = useState("");
  const [newCategory, setNewCategory] = useState<MemoryCategory>("identity");
  const [isAdding, setIsAdding] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Category Configuration
  const categoryConfig: Record<MemoryCategory, { label: string; icon: any; color: string; bg: string }> = {
    identity: { 
      label: "Identity Core", 
      icon: User, 
      color: "text-amber-400 border-amber-500/25", 
      bg: "bg-amber-500/5 hover:bg-amber-500/10" 
    },
    preference: { 
      label: "Preferences", 
      icon: Heart, 
      color: "text-pink-400 border-pink-500/25", 
      bg: "bg-pink-500/5 hover:bg-pink-500/10" 
    },
    goal: { 
      label: "Life Goals", 
      icon: Target, 
      color: "text-emerald-400 border-emerald-500/25", 
      bg: "bg-emerald-500/5 hover:bg-emerald-500/10" 
    },
    project: { 
      label: "Active Projects", 
      icon: Briefcase, 
      color: "text-[var(--accent)] border-[var(--accent)]/30", 
      bg: "bg-[var(--accent)]/5 hover:bg-[var(--accent)]/10" 
    },
    relationship: { 
      label: "Relationships", 
      icon: Users, 
      color: "text-purple-400 border-purple-500/25", 
      bg: "bg-purple-500/5 hover:bg-purple-500/10" 
    },
    emotional: { 
      label: "Milestones", 
      icon: Flame, 
      color: "text-red-400 border-red-500/25", 
      bg: "bg-red-500/5 hover:bg-red-500/10" 
    },
    behavior: { 
      label: "Behaviors & Habits", 
      icon: Brain, 
      color: "text-indigo-400 border-indigo-500/25", 
      bg: "bg-indigo-500/5 hover:bg-indigo-500/10" 
    },
  };

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

  const filteredMemories = activeTab === "all" 
    ? memories 
    : memories.filter(m => m.category === activeTab);

  const handleManualAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newText.trim()) return;

    setSubmitting(true);
    try {
      await onAddMemory(newCategory, newText.trim());
      setNewText("");
      setIsAdding(false);
    } catch (e) {
      console.error(e);
    } finally {
      setSubmitting(false);
    }
  };

  const formatDate = (isoStr: string) => {
    try {
      const d = new Date(isoStr);
      return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    } catch (e) {
      return "Durable Record";
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop Overlay */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="absolute inset-0 bg-[var(--bg)]/60 z-40 backdrop-blur-sm"
          />

          {/* Slide-over Container */}
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
                  <Brain size={22} className="animate-pulse" />
                </div>
                <div>
                  <h3 className="font-display font-medium text-lg tracking-tight text-[var(--text)] flex items-center gap-2">
                    Nuvi Memory Core
                    <Sparkles size={14} className="text-[var(--accent)]" />
                  </h3>
                  <p className="text-[10px] font-mono uppercase tracking-widest text-[var(--text-dim)] mt-0.5">
                    Persistent recollect files ({memories.length})
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

            {/* Quick stats & action row */}
            <div className="px-6 py-4 bg-[var(--bg-panel)] border-b border-[var(--border-soft)] flex items-center justify-between gap-2.5">
              <span className="text-[10px] text-[var(--text-dim)] font-mono">
                Nuvi remembers these details naturally as you chat.
              </span>
              {!isAdding && (
                <button
                  onClick={() => setIsAdding(true)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-[var(--accent)]/30 bg-[var(--accent)]/10 hover:bg-[var(--accent)]/20 text-xs font-mono tracking-wider text-[var(--accent)] transition shrink-0 cursor-pointer"
                >
                  <Plus size={12} />
                  <span>MANUAL SEED</span>
                </button>
              )}
            </div>

            {/* Manual entry card drawer inside dashboard */}
            <AnimatePresence>
              {isAdding && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  className="overflow-hidden border-b border-[var(--border-soft)] bg-[var(--bg-panel)]"
                >
                  <form onSubmit={handleManualAdd} className="p-5 space-y-4">
                    <div>
                      <label className="block text-[11px] font-mono tracking-wider text-[var(--text)] uppercase mb-2">
                        Memory Archetype Category
                      </label>
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                        {(Object.keys(categoryConfig) as MemoryCategory[]).map((cat) => {
                          const Icon = categoryConfig[cat].icon;
                          const active = newCategory === cat;
                          return (
                            <button
                              key={cat}
                              type="button"
                              onClick={() => setNewCategory(cat)}
                              className={`flex items-center gap-2 p-1.5 rounded-lg border text-xs tracking-wide transition cursor-pointer ${
                                active 
                                  ? "border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]"
                                  : "border-[var(--border-soft)] bg-[var(--bg-panel)] text-[var(--text-dim)] hover:bg-[var(--bg-hover)]"
                              }`}
                            >
                              <Icon size={12} />
                              <span className="truncate">{categoryConfig[cat].label.split(" ")[0]}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    <div>
                      <label className="block text-[11px] font-mono tracking-wider text-[var(--text)] uppercase mb-2">
                        Recollection Statement (3rd Person declarative)
                      </label>
                      <textarea
                        value={newText}
                        onChange={(e) => setNewText(e.target.value)}
                        placeholder="e.g. The user's startup is called Nuvi, a voice AI platform."
                        required
                        className="w-full h-18 text-xs p-3 rounded-lg border border-[var(--border-soft)] bg-[var(--bg-panel)] text-[var(--text)] placeholder-slate-500 focus:outline-none focus:border-cyan-500/60 resize-none font-sans"
                      />
                    </div>

                    <div className="flex gap-2.5 justify-end">
                      <button
                        type="button"
                        onClick={() => setIsAdding(false)}
                        className="px-3.5 py-1.5 rounded-lg border border-[var(--border-soft)] text-xs font-mono tracking-wide text-[var(--text-dim)] hover:text-[var(--text)] transition cursor-pointer"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        disabled={submitting}
                        className="px-4 py-1.5 rounded-lg bg-[var(--accent)] hover:bg-[var(--accent)] text-white font-bold text-xs uppercase font-mono tracking-widest transition disabled:opacity-50 cursor-pointer"
                      >
                        {submitting ? "Saving..." : "Commit Memory"}
                      </button>
                    </div>
                  </form>
                </motion.div>
              )}
            </AnimatePresence>

            {/* TAB SELECTOR SCROLLER */}
            <div className="px-6 py-4 flex gap-1.5 overflow-x-auto no-scrollbar border-b border-light border-[var(--border-soft)] shrink-0">
              <button
                onClick={() => setActiveTab("all")}
                className={`px-3 py-1.5 rounded-full border text-[11px] tracking-wider uppercase transition cursor-pointer shrink-0 ${
                  activeTab === "all"
                    ? "border-white bg-white text-white font-bold"
                    : "border-[var(--border-soft)] bg-[var(--bg-panel)] text-[var(--text-dim)] hover:border-[var(--border-soft)]"
                }`}
              >
                All Memories
              </button>
              {(Object.keys(categoryConfig) as MemoryCategory[]).map((cat) => {
                const config = categoryConfig[cat];
                const active = activeTab === cat;
                return (
                  <button
                    key={cat}
                    onClick={() => setActiveTab(cat)}
                    className={`px-3 py-1.5 rounded-full border text-[11px] tracking-wider uppercase transition shrink-0 cursor-pointer ${
                      active
                        ? "border-white bg-white text-white font-bold"
                        : "border-[var(--border-soft)] bg-[var(--bg-panel)] text-[var(--text-dim)] hover:border-[var(--border-soft)]"
                    }`}
                  >
                    {config.label.split(" ")[0]}
                  </button>
                );
              })}
            </div>

            {/* RECOLLECTION ITEMS CARDS CONTAINER */}
            <div className="flex-1 overflow-y-auto p-6 space-y-3.5">
              <AnimatePresence initial={false}>
                {filteredMemories.length === 0 ? (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="h-full flex flex-col items-center justify-center p-8 text-center text-[var(--text-faint)]"
                  >
                    <div className="p-4 rounded-full border border-dashed border-[var(--border-soft)] bg-[var(--bg-panel)] mb-4">
                      <Brain size={32} className="opacity-40" />
                    </div>
                    <h4 className="text-sm font-semibold tracking-wide text-[var(--text)]">No memories recorded yet</h4>
                    <p className="text-xs max-w-xs mt-1.5 leading-relaxed font-mono">
                      {activeTab === "all" 
                        ? "Start talking aloud with Nuvi! Her background consolidator analyzes transcript slices and builds a life context naturally."
                        : `No persistent recollections saved in Category "${categoryConfig[activeTab as MemoryCategory]?.label}". Add one or speak with Nuvi.`}
                    </p>
                  </motion.div>
                ) : (
                  filteredMemories.map((m) => {
                    const cfg = categoryConfig[m.category];
                    const Icon = cfg.icon;

                    return (
                      <motion.div
                        key={m.id}
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.95 }}
                        className={`flex items-start justify-between gap-4 p-4 rounded-xl border border-[var(--border-soft)] backdrop-blur-md bg-[var(--bg-panel)] ${cfg.bg} transition-colors group relative`}
                      >
                        <div className="flex gap-3.5 overflow-hidden">
                          <div className={`p-2 rounded-lg border mt-0.5 shrink-0 bg-[var(--bg-panel)] ${cfg.color}`}>
                            <Icon size={14} />
                          </div>
                          <div className="overflow-hidden">
                            <span className={`text-[9px] font-mono uppercase tracking-wider block ${cfg.color}`}>
                              {cfg.label}
                            </span>
                            <p className="text-xs text-[var(--text)] mt-1 font-sans leading-relaxed break-words font-medium">
                              {m.text}
                            </p>
                            <span className="text-[9px] font-mono text-[var(--text-faint)] mt-2 block">
                              Recalled: {formatDate(m.createdAt)}
                            </span>
                          </div>
                        </div>

                        {/* Forget / Delete trigger button */}
                        <button
                          onClick={() => onDeleteMemory(m.id)}
                          className="opacity-0 group-hover:opacity-100 p-2 rounded-lg border border-red-500/25 bg-red-950/15 text-red-400 hover:bg-red-500 hover:text-[var(--text)] transition duration-150 absolute top-4 right-4 sm:relative sm:top-0 sm:right-0 shrink-0 cursor-pointer"
                          title="Forget this memory"
                        >
                          <Trash2 size={13} />
                        </button>
                      </motion.div>
                    );
                  })
                )}
              </AnimatePresence>
            </div>

            {/* Technical visual core footprint footer */}
            <div className="p-5 border-t border-[var(--border-soft)] bg-[var(--bg-panel)] flex items-center justify-between text-[9px] font-mono text-slate-600 tracking-wider">
              <span className="flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] shadow-[0_0_5px_var(--accent-glow)] animate-pulse" />
                <span>MEM-SYNC STREAM ACTIVE</span>
              </span>
              <span>DURABLE LOCAL JSON DB SEED</span>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
