/**
 * NUVI Settings Store — persistent user preferences (V2).
 *
 * Establishes the persistence pattern for NUVI: settings are mirrored to
 * localStorage (instant local read) AND synced to the backend (settings.json)
 * so auto-start / wake-word preferences survive across browsers and the
 * Python desktop agent can read them too.
 *
 * Pattern follows the existing codebase conventions: plain state + ref mirrors.
 * No Context/Zustand — this is deliberately lightweight to match audio.ts/memoryTypes.ts.
 */

export interface NuviSettings {
  /** Launch NUVI (backends + browser tab) silently on Windows login. */
  autoStart: boolean;
  /** Enable the always-listening wake-word detector. */
  wakeWordEnabled: boolean;
  /** Phrase that activates NUVI (case-insensitive substring match). */
  wakePhrase: string;
  /** Preferred microphone device id ("" = system default). */
  micDeviceId: string;
  /** Wake-word sensitivity: 0 (strict) .. 100 (loose). Affects debounce window. */
  sensitivity: number;
  /** Master toggle for UI animations. */
  animations: boolean;
}

export const DEFAULT_SETTINGS: NuviSettings = {
  autoStart: false,
  wakeWordEnabled: false,
  wakePhrase: "hey nuvi",
  micDeviceId: "",
  sensitivity: 60,
  animations: true,
};

const STORAGE_KEY = "nuvi.settings.v2";

/** Settings keys that the browser should never persist (security). */
const NEVER_PERSIST: ReadonlySet<keyof NuviSettings> = new Set([]);

/**
 * Load settings from localStorage, merged over defaults so new keys always
 * have a sane value even when an older payload is present.
 */
export function loadSettings(): NuviSettings {
  if (typeof window === "undefined") return { ...DEFAULT_SETTINGS };
  try {
    let raw = window.localStorage.getItem(STORAGE_KEY);
    // Legacy fallback: migrate from Myraa storage key
    if (!raw) raw = window.localStorage.getItem("myraa.settings.v2");
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<NuviSettings>;
    // Normalize legacy wake phrase
    if (parsed.wakePhrase?.toLowerCase().includes("myraa")) {
      parsed.wakePhrase = "hey nuvi";
    }
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Persist a full or partial settings update to localStorage.
 * Returns the fully merged settings object.
 */
export function saveSettings(patch: Partial<NuviSettings>): NuviSettings {
  const current = loadSettings();
  const next: NuviSettings = { ...current, ...patch };
  if (typeof window !== "undefined") {
    try {
      // Strip any sensitive keys before writing to localStorage.
      const safe: Record<string, unknown> = {};
      (Object.keys(next) as (keyof NuviSettings)[]).forEach((k) => {
        if (!NEVER_PERSIST.has(k)) safe[k] = next[k];
      });
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(safe));
    } catch {
      /* localStorage may be unavailable (private mode) — fail silently. */
    }
  }
  // Best-effort sync to backend so the Python agent can read auto-start state.
  void syncSettingsToBackend(next).catch(() => {});
  return next;
}

/** Push settings to the backend (server.ts persists to settings.json). */
async function syncSettingsToBackend(settings: NuviSettings): Promise<void> {
  try {
    await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    });
  } catch {
    /* Backend may be briefly unavailable during boot — non-fatal. */
  }
}
