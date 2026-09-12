import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import Constants from 'expo-constants';

export interface NuviSettings {
  autoStart: boolean;
  wakeWordEnabled: boolean;
  wakePhrase: string;
  micDeviceId: string;
  sensitivity: number;
  animations: boolean;
  /** Mobile-specific: server URL (e.g. http://192.168.1.5:3000) */
  serverUrl: string;
}

// Env var is injected at build time via EXPO_PUBLIC_SERVER_URL (see mobile/.env.example)
const ENV_SERVER_URL = (typeof process !== 'undefined' && (process.env as any)?.EXPO_PUBLIC_SERVER_URL) || '';

function getInferredServerUrl(): string | null {
  // Web: prefer current host on :3000 (Expo web runs on :8081, server on :3000)
  if (Platform.OS === 'web' && typeof window !== 'undefined' && window.location?.hostname) {
    const h = window.location.hostname;
    if (h && h !== 'localhost' && h !== '127.0.0.1') return `http://${h}:3000`;
    // localhost web dev: server is also localhost:3000
    if (h === 'localhost' || h === '127.0.0.1') return 'http://localhost:3000';
  }
  // Native: derive LAN IP from Expo debugger hostUri (e.g. 192.168.1.5:8081)
  try {
    const hostUri =
      (Constants.expoConfig as any)?.hostUri ||
      (Constants.manifest as any)?.hostUri ||
      (Constants as any)?.manifest2?.extra?.expoGo?.debuggerHost ||
      '';
    if (hostUri) {
      const host = String(hostUri).split(':')[0];
      if (host && host !== '127.0.0.1' && host !== 'localhost') return `http://${host}:3000`;
    }
  } catch {}
  return null;
}

const FALLBACK_URL = 'http://192.168.1.71:3000';

export const DEFAULT_SETTINGS: NuviSettings = {
  autoStart: false,
  wakeWordEnabled: false,
  wakePhrase: 'hey nuvi',
  micDeviceId: '',
  sensitivity: 60,
  animations: true,
  serverUrl: (ENV_SERVER_URL && String(ENV_SERVER_URL).trim()) || getInferredServerUrl() || FALLBACK_URL,
};

const STORAGE_KEY = 'nuvi.settings.v2.mobile';

export async function loadSettings(): Promise<NuviSettings> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<NuviSettings>;
    const merged = { ...DEFAULT_SETTINGS, ...parsed };
    // Migrate old placeholder (192.168.x.x) if we can now infer a better LAN IP and user never manually set URL
    const isOldPlaceholder =
      parsed.serverUrl === FALLBACK_URL ||
      parsed.serverUrl === 'http://192.168.1.10:3000' ||
      (parsed.serverUrl && /^http:\/\/192\.168\.\d+\.\d+:3000$/.test(parsed.serverUrl));
    if (isOldPlaceholder) {
      const inferred = getInferredServerUrl();
      if (inferred && inferred !== merged.serverUrl && !ENV_SERVER_URL) {
        merged.serverUrl = inferred;
      } else if (ENV_SERVER_URL && String(ENV_SERVER_URL).trim() !== parsed.serverUrl) {
        merged.serverUrl = String(ENV_SERVER_URL).trim();
      }
    }
    return merged;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(patch: Partial<NuviSettings>): Promise<NuviSettings> {
  const current = await loadSettings();
  const next: NuviSettings = { ...current, ...patch };
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {}
  // Best-effort sync to backend
  void syncSettingsToBackend(next).catch(() => {});
  return next;
}

async function syncSettingsToBackend(settings: NuviSettings): Promise<void> {
  try {
    const base = settings.serverUrl.replace(/\/$/, '');
    await fetch(`${base}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    });
  } catch {}
}

export async function getServerUrl(): Promise<string> {
  const s = await loadSettings();
  return s.serverUrl.replace(/\/$/, '');
}
