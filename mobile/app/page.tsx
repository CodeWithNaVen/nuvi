import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  TextInput,
  ScrollView,
  ActivityIndicator,
  Platform,
  Alert,
  Modal,
  KeyboardAvoidingView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Ionicons } from '@expo/vector-icons';
import { NuviOrb } from '@/components/NuviOrb';
import { NuviAudioSession, LiveState } from '@/lib/audio';
import { Memory, MemoryCategory } from '@/lib/memoryTypes';
import { loadSettings, saveSettings, DEFAULT_SETTINGS, NuviSettings } from '@/lib/settingsStore';

export default function Page() {
  const [serverUrl, setServerUrl] = useState(DEFAULT_SETTINGS.serverUrl);
  const [liveState, setLiveState] = useState<LiveState>('disconnected');
  const [userCaption, setUserCaption] = useState('');
  const [modelCaption, setModelCaption] = useState('');
  const [errorText, setErrorText] = useState<string | null>(null);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [chatMessages, setChatMessages] = useState<{ id: string; role: 'user' | 'assistant' | 'tool'; text: string }[]>([]);
  const [textInput, setTextInput] = useState('');
  const [showChat, setShowChat] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showMemory, setShowMemory] = useState(false);
  const [settings, setSettingsState] = useState<NuviSettings>(DEFAULT_SETTINGS);

  // Camera
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraStatus, setCameraStatus] = useState('Camera off');
  const [cameraResult, setCameraResult] = useState<Record<string, any> | null>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);
  const cameraIntervalRef = useRef<any>(null);
  const liveStateRef = useRef<LiveState>('disconnected');
  const cameraActiveRef = useRef(false);

  const sessionRef = useRef<NuviAudioSession | null>(null);
  const scrollEndRef = useRef<ScrollView>(null);
  const [amp, setAmp] = useState(0);

  useEffect(() => { liveStateRef.current = liveState; }, [liveState]);
  useEffect(() => { cameraActiveRef.current = cameraActive; }, [cameraActive]);

  // Load settings + memories
  useEffect(() => {
    (async () => {
      const s = await loadSettings();
      setSettingsState(s);
      setServerUrl(s.serverUrl);
      try {
        const res = await fetch(`${s.serverUrl.replace(/\/$/, '')}/api/memories`);
        const data = await res.json();
        if (Array.isArray(data)) setMemories(data);
      } catch {}
    })();
  }, []);

  const addChatMsg = (role: 'user' | 'assistant' | 'tool', text: string) => {
    setChatMessages(prev => [...prev, { id: Math.random().toString(36).slice(2, 8), role, text }]);
    setTimeout(() => scrollEndRef.current?.scrollToEnd({ animated: true }), 80);
  };

  const captureCameraFrame = useCallback(async (): Promise<string | null> => {
    if (!cameraRef.current || !cameraActive) return null;
    try {
      const pic = await cameraRef.current.takePictureAsync({ base64: true, quality: 0.6, skipProcessing: true });
      return (pic as any)?.base64 || null;
    } catch { return null; }
  }, [cameraActive]);

  // Camera handlers
  const sendCameraFrameToSession = useCallback(async () => {
    if (!cameraActiveRef.current || liveStateRef.current === 'disconnected') return;
    const b64 = await captureCameraFrame();
    if (b64) sessionRef.current?.sendVideoFrame(b64);
  }, [captureCameraFrame]);

  const handleOpenCamera = async () => {
    if (!permission?.granted) {
      const res = await requestPermission();
      if (!res.granted) { setCameraStatus('Camera permission denied'); return; }
    }
    setCameraActive(true);
    cameraActiveRef.current = true;
    setCameraStatus('Camera live');
    setCameraResult(null);
    if (cameraIntervalRef.current) clearInterval(cameraIntervalRef.current);
    cameraIntervalRef.current = setInterval(sendCameraFrameToSession, 2000);
    setTimeout(sendCameraFrameToSession, 400);
  };

  const handleCloseCamera = () => {
    if (cameraIntervalRef.current) { clearInterval(cameraIntervalRef.current); cameraIntervalRef.current = null; }
    cameraActiveRef.current = false;
    setCameraActive(false);
    setCameraStatus('Camera off');
  };

  // Audio session
  useEffect(() => {
    // defer until serverUrl known
    if (!serverUrl) return;
    sessionRef.current = new NuviAudioSession(serverUrl, {
      onStateChange: s => {
        setLiveState(s);
        if (s === 'disconnected') { setUserCaption(''); setModelCaption(''); }
      },
      onTranscription: (role, text) => {
        if (role === 'user') {
          setUserCaption(text);
          setModelCaption('');
          addChatMsg('user', text);
        } else {
          setModelCaption(prev => prev + text);
          setUserCaption('');
          setChatMessages(prev => {
            const last = prev[prev.length - 1];
            if (last && last.role === 'assistant') return [...prev.slice(0, -1), { ...last, text: last.text + text }];
            return [...prev, { id: Math.random().toString(36).slice(2, 8), role: 'assistant', text }];
          });
        }
      },
      onToolCall: (name, args, callback) => {
        addChatMsg('tool', `${name}(${JSON.stringify(args).slice(0, 80)})`);
        if (name === 'openCamera' || name === 'startCamera' || name === 'enableCamera') {
          handleOpenCamera().then(() => callback({ result: 'Camera opened on mobile – preview live.' }))
            .catch(e => callback({ error: String(e) }));
          return;
        }
        if (name === 'closeCamera' || name === 'stopCamera') {
          handleCloseCamera();
          callback({ result: 'Camera closed.' });
          return;
        }
        if (['captureCameraFrame','analyzeCameraFrame','readCameraText'].includes(name)) {
          (async () => {
            if (!cameraActiveRef.current) {
              await handleOpenCamera();
              await new Promise(r => setTimeout(r, 700));
            }
            const b64 = await captureCameraFrame();
            const fwdArgs: any = { ...(args || {}) };
            if (b64) fwdArgs.image_base64 = b64;
            try {
              const res = await fetch(`${serverUrl.replace(/\/$/, '')}/api/desktop/execute`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tool: name, args: fwdArgs }),
              });
              const data = await res.json();
              if (res.ok && data.ok) {
                if (data.result) setCameraResult(data.result);
                callback({ result: data.result });
              } else {
                if (String(data.error||'').toLowerCase().includes('not running') && b64) {
                  const fallback = { result: 'Browser preview only (desktop agent offline)', image_base64: b64 };
                  setCameraResult(fallback); callback({ result: fallback });
                } else callback({ error: data.error || 'Camera failed' });
              }
            } catch (e:any) {
              if (b64) {
                const fallback = { result: 'Captured mobile frame (offline)', image_base64: b64 };
                setCameraResult(fallback); callback({ result: fallback });
              } else callback({ error: e.message });
            }
          })();
          return;
        }
        if (name === 'changeBackground') {
          callback({ result: `Theme ${args.color} acknowledged on mobile.` });
          return;
        }
        callback({ result: `Mobile handling ${name}` });
      },
      onError: msg => setErrorText(msg),
      onMemorySync: updated => { if (Array.isArray(updated)) setMemories(updated); },
    });
    return () => sessionRef.current?.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverUrl]);

  const handleToggleConnection = async () => {
    setErrorText(null);
    if (!sessionRef.current) return;
    // update serverUrl if changed
    sessionRef.current.updateServerUrl(serverUrl);
    if (liveState === 'disconnected') await sessionRef.current.connect();
    else sessionRef.current.disconnect();
  };

  const runCameraAnalysis = async (mode: 'analyze' | 'ocr') => {
    try {
      setCameraStatus(mode === 'analyze' ? 'Analyzing…' : 'Reading…');
      const tool = mode === 'analyze' ? 'analyzeCameraFrame' : 'readCameraText';
      let b64 = await captureCameraFrame();
      if (!b64 && cameraActive) { await new Promise(r => setTimeout(r, 350)); b64 = await captureCameraFrame(); }
      const args: any = { camera_id: 0, include_image: true, max_dim: 1280, max_chars: 2000 };
      if (b64) args.image_base64 = b64;
      const res = await fetch(`${serverUrl.replace(/\/$/, '')}/api/desktop/execute`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tool, args }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        if (String(data.error||'').toLowerCase().includes('not running') && b64) {
          setCameraResult({ result: 'Mobile preview only (desktop agent offline)', image_base64: b64 });
          setCameraStatus('Visible (mobile-only)');
          return;
        }
        throw new Error(data.error || 'Camera failed');
      }
      setCameraResult(data.result || {});
      setCameraStatus(mode === 'analyze' ? 'Scene analyzed' : 'Text read');
    } catch (e:any) { setCameraStatus(e.message || 'Failed'); }
  };

  const sendTypedText = () => {
    const t = textInput.trim();
    if (!t) return;
    setTextInput('');
    addChatMsg('user', t);
    if (liveState !== 'disconnected' && sessionRef.current) {
      try { (sessionRef.current as any).sendText?.(t); } catch {}
    } else {
      setErrorText('Not connected — tap power to awake Nuvi, then type again.');
    }
  };

  const handleAddMemory = async (cat: MemoryCategory, text: string) => {
    try {
      const res = await fetch(`${serverUrl.replace(/\/$/, '')}/api/memories`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category: cat, text }),
      });
      const saved = await res.json();
      if (saved?.id) setMemories(prev => [...prev, saved]);
    } catch {}
  };
  const handleDeleteMemory = async (id: string) => {
    try { await fetch(`${serverUrl.replace(/\/$/, '')}/api/memories/${id}`, { method: 'DELETE' }); setMemories(prev => prev.filter(m => m.id !== id)); } catch {}
  };

  // Amplitude for orb (use input/output analyser when on web; on native fallback to timer)
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const s = sessionRef.current;
      let analyser: any = null;
      if (liveState === 'speaking' && (s as any)?.outputAnalyser) analyser = (s as any).outputAnalyser;
      else if (liveState === 'listening' && (s as any)?.inputAnalyser) analyser = (s as any).inputAnalyser;
      if (analyser) {
        const arr = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(arr);
        let sum = 0; for (let i = 0; i < arr.length; i++) sum += arr[i];
        setAmp(sum / arr.length / 255);
      } else {
        // fake subtle animation for native without analyser
        setAmp(prev => (liveState === 'speaking' || liveState === 'listening' ? Math.min(0.85, prev*0.9 + Math.random()*0.15) : prev*0.88));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [liveState]);

  const orbState: 'idle'|'listening'|'thinking'|'speaking' =
    liveState === 'disconnected' ? 'idle' : liveState === 'connecting' ? 'thinking' : liveState;

  return (
    <SafeAreaView style={styles.root}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <View style={styles.dot} />
          <Text style={styles.headerTitle}>NUVI</Text>
          <View style={[styles.liveDot, { backgroundColor: liveState !== 'disconnected' ? '#10B981' : 'rgba(255,255,255,0.12)' }]} />
        </View>
        <View style={styles.headerRight}>
          <Pressable onPress={() => setShowMemory(true)} style={styles.headerBtn}><Ionicons name="book-outline" size={18} color="rgba(255,255,255,0.85)" /></Pressable>
          <Pressable onPress={() => setShowSettings(true)} style={styles.headerBtn}><Ionicons name="settings-outline" size={18} color="rgba(255,255,255,0.85)" /></Pressable>
        </View>
      </View>

      {/* Orb Stage */}
      <View style={styles.stage}>
        <NuviOrb state={orbState} amplitude={amp} size={240} />
        <View style={styles.captionBox}>
          {modelCaption || userCaption ? (
            <Text style={[styles.caption, userCaption ? styles.userCaption : styles.modelCaption]}>
              {modelCaption ? modelCaption : `“${userCaption}”`}
            </Text>
          ) : (
            <Text style={styles.statusText}>
              {liveState === 'listening' ? 'Listening — speak freely…' : liveState === 'connecting' ? 'Connecting…' : liveState === 'speaking' ? 'Nuvi is speaking…' : 'Tap orb to awake Nuvi'}
            </Text>
          )}
        </View>
        {errorText && (
          <View style={styles.errorBox}>
            <Text style={styles.errorTitle}>Attention</Text>
            <Text style={styles.errorText}>{errorText}</Text>
            <Pressable onPress={() => setErrorText(null)}><Text style={styles.errorDismiss}>Dismiss</Text></Pressable>
          </View>
        )}
      </View>

      {/* Camera Preview */}
      {cameraActive && (
        <View style={styles.cameraCard}>
          <View style={styles.cameraHeader}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <View style={styles.cameraDot} />
              <Text style={styles.cameraTitle}>Camera</Text>
            </View>
            <Pressable onPress={handleCloseCamera} style={styles.closeBtn}><Ionicons name="close" size={18} color="rgba(255,255,255,0.7)" /></Pressable>
          </View>
          <View style={styles.cameraPreview}>
            <CameraView ref={cameraRef} style={StyleSheet.absoluteFill} facing="front" />
          </View>
          <Text style={styles.cameraStatus}>{cameraStatus}</Text>
          <View style={styles.cameraActions}>
            <Pressable onPress={() => runCameraAnalysis('analyze')} style={styles.camBtn}><Text style={styles.camBtnText}>Analyze</Text></Pressable>
            <Pressable onPress={() => runCameraAnalysis('ocr')} style={styles.camBtn}><Text style={styles.camBtnText}>Read text</Text></Pressable>
          </View>
          {cameraResult && (
            <View style={styles.resultBox}>
              <Text style={styles.resultLabel}>Result</Text>
              {cameraResult.scene_summary && <Text style={styles.resultText}>{cameraResult.scene_summary}</Text>}
              {cameraResult.text && <Text style={styles.resultText}>{cameraResult.text}</Text>}
              {typeof cameraResult.objects_detected !== 'undefined' && <Text style={styles.resultText}>Objects: {cameraResult.objects_detected}</Text>}
              {typeof cameraResult.brightness !== 'undefined' && <Text style={styles.resultText}>Brightness: {cameraResult.brightness}</Text>}
            </View>
          )}
        </View>
      )}

      {/* Bottom Controls */}
      <View style={styles.controls}>
        <View style={styles.waveRow}>
          {[10,22,14,26,18,9].map((h,i) => {
            let hf = 0.3;
            const phase = (i + 1) * 1.4 + amp * 2.4;
            if (liveState === 'speaking') hf = 0.3 + Math.sin(phase) * 0.5 + amp * 0.6;
            else if (liveState === 'listening') hf = 0.2 + Math.sin(phase * 0.7) * 0.3 + amp * 0.4;
            return <View key={i} style={[styles.waveBar, { height: Math.max(3, h*hf), backgroundColor: liveState==='speaking' ? '#E07A5F' : liveState==='listening' ? '#10B981' : 'rgba(255,255,255,0.12)' }]} />;
          })}
        </View>
        <View style={styles.controlRow}>
          <Pressable onPress={() => setShowChat(true)} style={styles.circleBtn}><Ionicons name="chatbubble-ellipses-outline" size={20} color="rgba(255,255,255,0.9)" /></Pressable>
          <Pressable onPress={cameraActive ? handleCloseCamera : handleOpenCamera} style={[styles.circleBtn, cameraActive && styles.circleActive]}><Ionicons name="camera-outline" size={20} color="rgba(255,255,255,0.9)" /></Pressable>
          <Pressable onPress={handleToggleConnection} style={[styles.powerBtn,
            liveState==='disconnected' ? styles.powerIdle : liveState==='listening' ? styles.powerListening : liveState==='speaking' ? styles.powerSpeaking : styles.powerThinking
          ]}>
            {liveState === 'disconnected' ? <Ionicons name="power" size={26} color="#fff" /> : liveState === 'connecting' ? <ActivityIndicator color="#fff" /> : liveState === 'listening' ? <Ionicons name="mic" size={26} color="#fff" /> : <Ionicons name="volume-high" size={26} color="#fff" />}
          </Pressable>
          <Pressable onPress={() => Alert.alert('Coming soon','Screen share is desktop-only')} style={styles.circleBtn}><Ionicons name="desktop-outline" size={20} color="rgba(255,255,255,0.9)" /></Pressable>
        </View>
        <Text style={styles.hintText}>{liveState==='disconnected' ? 'Tap power to awake' : liveState==='listening' ? 'Listening — just talk' : liveState==='speaking' ? 'Nuvi speaking — tap to interrupt' : 'Connecting…'}</Text>
      </View>

      {/* Chat Modal */}
      <Modal visible={showChat} animationType="slide" onRequestClose={() => setShowChat(false)}>
        <SafeAreaView style={styles.modalRoot}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Chat</Text>
            <Pressable onPress={() => setShowChat(false)} style={styles.closeBtn}><Ionicons name="close" size={18} color="rgba(255,255,255,0.7)" /></Pressable>
          </View>
          <ScrollView ref={scrollEndRef} style={styles.chatList} contentContainerStyle={{ padding: 16, gap: 10 }}>
            {chatMessages.length===0 && <View style={styles.emptyChat}><Text style={styles.emptyText}>No messages yet</Text></View>}
            {chatMessages.map(m => (
              <View key={m.id} style={[styles.bubble, m.role==='user'?styles.bubbleUser:m.role==='assistant'?styles.bubbleAssistant:styles.bubbleTool]}>
                <Text style={[styles.bubbleText, m.role==='user' && { color: '#fff' }]}>{m.text}</Text>
              </View>
            ))}
          </ScrollView>
          <KeyboardAvoidingView behavior={Platform.OS==='ios'?'padding':undefined} style={styles.chatFooter}>
            <TextInput value={textInput} onChangeText={setTextInput} placeholder="Type a message…" placeholderTextColor="rgba(255,255,255,0.4)" style={styles.input} onSubmitEditing={sendTypedText} />
            <Pressable onPress={sendTypedText} style={[styles.sendBtn, !textInput.trim() && { opacity: 0.4 }]} disabled={!textInput.trim()}><Ionicons name="send" size={18} color="#fff" /></Pressable>
          </KeyboardAvoidingView>
        </SafeAreaView>
      </Modal>

      {/* Memory Modal */}
      <Modal visible={showMemory} animationType="slide" onRequestClose={() => setShowMemory(false)}>
        <SafeAreaView style={styles.modalRoot}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Memory ({memories.length})</Text>
            <Pressable onPress={() => setShowMemory(false)} style={styles.closeBtn}><Ionicons name="close" size={18} color="rgba(255,255,255,0.7)" /></Pressable>
          </View>
          <ScrollView style={styles.chatList} contentContainerStyle={{ padding: 16, gap: 12 }}>
            {memories.length===0 ? <Text style={styles.emptyText}>No recollections yet</Text> :
              memories.map(m => (
                <View key={m.id} style={styles.memoryRow}>
                  <View style={{ flex: 1 }}><Text style={styles.memoryCat}>{m.category}</Text><Text style={styles.memoryText}>{m.text}</Text></View>
                  <Pressable onPress={() => handleDeleteMemory(m.id)}><Ionicons name="trash-outline" size={18} color="#EF4444" /></Pressable>
                </View>
              ))
            }
          </ScrollView>
          <AddMemoryForm onSave={handleAddMemory} />
        </SafeAreaView>
      </Modal>

      {/* Settings Modal */}
      <Modal visible={showSettings} animationType="slide" onRequestClose={() => setShowSettings(false)}>
        <SafeAreaView style={styles.modalRoot}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Settings</Text>
            <Pressable onPress={() => setShowSettings(false)} style={styles.closeBtn}><Ionicons name="close" size={18} color="rgba(255,255,255,0.7)" /></Pressable>
          </View>
          <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
            <View style={styles.settingGroup}>
              <Text style={styles.settingLabel}>Server URL</Text>
              <Text style={styles.settingHint}>Point to your desktop Nuvi server (e.g. http://192.168.1.5:3000). Must be reachable from phone.</Text>
              <TextInput value={serverUrl} onChangeText={setServerUrl} placeholder="http://192.168.1.71:3000" placeholderTextColor="rgba(255,255,255,0.4)" style={styles.input} />
              <Pressable onPress={async () => { const next = await saveSettings({ serverUrl }); setSettingsState(next); Alert.alert('Saved','Server URL updated. Reconnect to apply.'); }} style={styles.primaryBtn}><Text style={styles.primaryText}>Save</Text></Pressable>
            </View>
            <View style={styles.settingGroup}>
              <Text style={styles.settingLabel}>Models (Nuvi parity)</Text>
              <Text style={styles.settingHint}>Live: gemini-3.1-flash-live-preview (Aoede) • Memory: gemini-3.5-flash • Vision: gemini-2.5-flash</Text>
            </View>
            <View style={styles.settingGroup}>
              <Text style={styles.settingLabel}>Wake Word</Text>
              <View style={styles.rowBetween}><Text style={styles.settingText}>Enable</Text><Text style={styles.settingValue}>{settings.wakeWordEnabled ? 'On' : 'Off'}</Text></View>
              <TextInput value={settings.wakePhrase} onChangeText={async v => { const n = await saveSettings({ wakePhrase: v }); setSettingsState(n); }} style={styles.input} placeholder="hey nuvi" />
            </View>
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

function AddMemoryForm({ onSave }: { onSave: (c: MemoryCategory, t: string) => Promise<void> }) {
  const [cat, setCat] = useState<MemoryCategory>('preference');
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  return (
    <View style={styles.addForm}>
      <View style={styles.catRow}>
        {(['preference','identity','goal','project','relationship','emotional','behavior'] as MemoryCategory[]).map(c => (
          <Pressable key={c} onPress={() => setCat(c)} style={[styles.catChip, cat===c && styles.catChipActive]}><Text style={[styles.catText, cat===c && { color: '#E07A5F' }]}>{c}</Text></Pressable>
        ))}
      </View>
      <TextInput value={text} onChangeText={setText} placeholder="e.g. I prefer dark mode" placeholderTextColor="rgba(255,255,255,0.4)" style={styles.input} multiline />
      <Pressable disabled={saving || !text.trim()} onPress={async () => { setSaving(true); await onSave(cat, text.trim()); setText(''); setSaving(false); }} style={[styles.primaryBtn, (!text.trim()||saving) && { opacity: 0.5 }]}><Text style={styles.primaryText}>{saving?'Saving…':'Save to memory'}</Text></Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0A0A0F' },
  header: { height: 56, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.06)', backgroundColor: 'rgba(18,18,24,0.9)' },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#E07A5F', shadowColor: '#E07A5F', shadowOpacity: 0.6, shadowRadius: 6 },
  headerTitle: { color: 'rgba(255,255,255,0.6)', fontSize: 12, letterSpacing: 4, fontWeight: '700' },
  liveDot: { width: 6, height: 6, borderRadius: 3, marginLeft: 6 },
  headerRight: { flexDirection: 'row', gap: 8 },
  headerBtn: { width: 36, height: 36, borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.06)', alignItems: 'center', justifyContent: 'center' },
  headerBtnText: { fontSize: 16 },
  iconText: { fontSize: 14 },
  stage: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24, gap: 18 },
  captionBox: { minHeight: 48, alignItems: 'center', justifyContent: 'center', maxWidth: 340 },
  caption: { textAlign: 'center', fontSize: 15, lineHeight: 22, fontWeight: '300' },
  modelCaption: { color: '#FFFFFF', letterSpacing: 0.3 },
  userCaption: { color: '#7DD3FC', fontFamily: Platform.OS==='ios'?'Menlo':'monospace', fontSize: 13 },
  statusText: { color: 'rgba(255,255,255,0.35)', fontSize: 10, letterSpacing: 1.6, textTransform: 'uppercase', textAlign: 'center' },
  errorBox: { maxWidth: 340, backgroundColor: 'rgba(127,29,29,0.4)', borderWidth: 1, borderColor: 'rgba(239,68,68,0.25)', padding: 12, borderRadius: 16, gap: 6 },
  errorTitle: { color: '#FCA5A5', fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  errorText: { color: '#FECACA', fontSize: 11, lineHeight: 16 },
  errorDismiss: { color: '#F87171', fontSize: 11, textDecorationLine: 'underline' },
  cameraCard: { position: 'absolute', bottom: 128, left: 16, right: 16, backgroundColor: 'rgba(18,18,24,0.96)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)', borderRadius: 20, padding: 12, gap: 10 },
  cameraHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cameraDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#E07A5F' },
  cameraTitle: { color: '#fff', fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  closeBtn: { padding: 6 },
  closeText: { color: 'rgba(255,255,255,0.5)', fontSize: 14 },
  cameraPreview: { height: 190, borderRadius: 12, overflow: 'hidden', backgroundColor: '#000' },
  cameraStatus: { color: 'rgba(255,255,255,0.5)', fontSize: 9, letterSpacing: 1, textTransform: 'uppercase' },
  cameraActions: { flexDirection: 'row', gap: 8 },
  camBtn: { flex: 1, backgroundColor: 'rgba(255,255,255,0.06)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)', paddingVertical: 10, borderRadius: 10, alignItems: 'center' },
  camBtnText: { color: '#fff', fontSize: 10, letterSpacing: 0.8 },
  resultBox: { backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)', borderRadius: 10, padding: 10, gap: 4 },
  resultLabel: { color: 'rgba(255,255,255,0.4)', fontSize: 9, letterSpacing: 1 },
  resultText: { color: '#fff', fontSize: 11, lineHeight: 16 },
  controls: { paddingBottom: 16, paddingTop: 8, alignItems: 'center', gap: 10, backgroundColor: 'transparent' },
  waveRow: { flexDirection: 'row', gap: 4, height: 16, alignItems: 'center' },
  waveBar: { width: 3, borderRadius: 2 },
  controlRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  circleBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(255,255,255,0.06)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)', alignItems: 'center', justifyContent: 'center' },
  circleActive: { backgroundColor: 'rgba(224,122,95,0.14)', borderColor: 'rgba(224,122,95,0.35)' },
  circleText: { fontSize: 18 },
  powerBtn: { width: 68, height: 68, borderRadius: 34, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  powerIdle: { backgroundColor: 'rgba(255,255,255,0.06)', borderColor: 'rgba(255,255,255,0.1)' },
  powerListening: { backgroundColor: 'rgba(16,185,129,0.15)', borderColor: 'rgba(16,185,129,0.6)' },
  powerSpeaking: { backgroundColor: '#E07A5F', borderColor: '#E07A5F' },
  powerThinking: { backgroundColor: 'rgba(245,158,11,0.15)', borderColor: 'rgba(245,158,11,0.5)' },
  powerText: { fontSize: 24, color: '#fff' },
  hintText: { color: 'rgba(255,255,255,0.3)', fontSize: 9, letterSpacing: 1, textTransform: 'uppercase', textAlign: 'center' },
  modalRoot: { flex: 1, backgroundColor: '#0A0A0F' },
  modalHeader: { height: 56, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.06)' },
  modalTitle: { color: '#fff', fontSize: 14, fontWeight: '700', letterSpacing: 1 },
  chatList: { flex: 1 },
  emptyChat: { padding: 24, alignItems: 'center' },
  emptyText: { color: 'rgba(255,255,255,0.35)', fontSize: 12 },
  bubble: { maxWidth: '88%', paddingHorizontal: 14, paddingVertical: 10, borderRadius: 16 },
  bubbleUser: { alignSelf: 'flex-end', backgroundColor: '#E07A5F' },
  bubbleAssistant: { alignSelf: 'flex-start', backgroundColor: 'rgba(255,255,255,0.08)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)' },
  bubbleTool: { alignSelf: 'flex-start', borderWidth: 1, borderStyle: 'dashed', borderColor: 'rgba(255,255,255,0.12)', backgroundColor: 'transparent' },
  bubbleText: { color: 'rgba(255,255,255,0.9)', fontSize: 13, lineHeight: 18 },
  chatFooter: { flexDirection: 'row', gap: 8, padding: 12, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.06)' },
  input: { flex: 1, backgroundColor: 'rgba(255,255,255,0.06)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)', borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, color: '#fff', fontSize: 13 },
  sendBtn: { width: 44, height: 44, borderRadius: 12, backgroundColor: '#E07A5F', alignItems: 'center', justifyContent: 'center' },
  sendText: { color: '#fff', fontSize: 16 },
  memoryRow: { flexDirection: 'row', gap: 12, backgroundColor: 'rgba(255,255,255,0.06)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)', borderRadius: 12, padding: 12, alignItems: 'center' },
  memoryCat: { color: '#E07A5F', fontSize: 9, letterSpacing: 1, textTransform: 'uppercase', fontWeight: '700' },
  memoryText: { color: '#fff', fontSize: 12, lineHeight: 16, marginTop: 2 },
  addForm: { padding: 16, gap: 10, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.06)' },
  catRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  catChip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999, backgroundColor: 'rgba(255,255,255,0.06)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)' },
  catChipActive: { backgroundColor: 'rgba(224,122,95,0.14)', borderColor: 'rgba(224,122,95,0.4)' },
  catText: { color: 'rgba(255,255,255,0.6)', fontSize: 10, textTransform: 'capitalize' },
  primaryBtn: { backgroundColor: '#E07A5F', paddingVertical: 12, borderRadius: 12, alignItems: 'center' },
  primaryText: { color: '#fff', fontWeight: '700', fontSize: 12, letterSpacing: 0.5 },
  settingGroup: { gap: 8, backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)', borderRadius: 12, padding: 14 },
  settingLabel: { color: '#fff', fontSize: 12, fontWeight: '700', letterSpacing: 0.8 },
  settingHint: { color: 'rgba(255,255,255,0.4)', fontSize: 11, lineHeight: 16 },
  settingText: { color: 'rgba(255,255,255,0.6)', fontSize: 12 },
  settingValue: { color: '#E07A5F', fontSize: 12, fontWeight: '700' },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between' },
});



