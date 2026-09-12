import React, { useEffect } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, withRepeat, withTiming, Easing, withSequence } from 'react-native-reanimated';

type OrbState = 'idle' | 'listening' | 'thinking' | 'speaking';

interface Props {
  state: OrbState;
  amplitude?: number;
  size?: number;
}

export function NuviOrb({ state, amplitude = 0, size = 220 }: Props) {
  const scale = useSharedValue(1);
  const pulse = useSharedValue(1);

  useEffect(() => {
    if (state === 'idle') {
      pulse.value = withRepeat(withTiming(1.04, { duration: 1800, easing: Easing.inOut(Easing.ease) }), -1, true);
      scale.value = withTiming(1, { duration: 300 });
    } else if (state === 'listening') {
      pulse.value = withRepeat(withSequence(withTiming(1.06, { duration: 380 }), withTiming(1, { duration: 380 })), -1, true);
    } else if (state === 'speaking') {
      pulse.value = 1;
      scale.value = withRepeat(withSequence(withTiming(1 + amplitude * 0.6, { duration: 160 }), withTiming(1, { duration: 160 })), -1, true);
    } else if (state === 'thinking') {
      pulse.value = withRepeat(withTiming(1.08, { duration: 600, easing: Easing.inOut(Easing.ease) }), -1, true);
    }
  }, [state, amplitude, pulse, scale]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value * pulse.value }],
  }));

  const glowOpacity = state === 'speaking' ? 0.22 : state === 'listening' ? 0.18 : 0.1;
  const coreBg = state === 'speaking' ? '#E07A5F' : state === 'listening' ? '#10B981' : '#D97757';

  return (
    <View style={[styles.container, { width: size, height: size }]}>
      {/* Glow rings */}
      <View style={[styles.glow, { width: size * 1.45, height: size * 1.45, borderRadius: size * 0.73, opacity: glowOpacity, backgroundColor: coreBg }]} />
      <View style={[styles.glow, { width: size * 1.75, height: size * 1.75, borderRadius: size * 0.875, opacity: glowOpacity * 0.5, backgroundColor: coreBg }]} />
      <Animated.View style={[{ width: size * 0.7, height: size * 0.7, borderRadius: size * 0.35, backgroundColor: coreBg, shadowColor: coreBg, shadowOpacity: 0.4, shadowRadius: 24, elevation: 8 }, animatedStyle]}>
        <View style={styles.innerHighlight} />
      </Animated.View>
      {(state === 'listening' || state === 'speaking') && (
        <View style={styles.badge}>
          <View style={[styles.dot, { backgroundColor: state === 'listening' ? '#10B981' : coreBg }]} />
          <Text style={styles.badgeText}>{state === 'listening' ? 'LISTENING' : 'SPEAKING'}</Text>
        </View>
      )}
      {state === 'thinking' && (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>THINKING</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { alignItems: 'center', justifyContent: 'center' },
  glow: { position: 'absolute', opacity: 0.1 },
  innerHighlight: {
    position: 'absolute',
    top: 18,
    left: 22,
    width: 36,
    height: 28,
    borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.22)',
    transform: [{ rotate: '-18deg' }],
  },
  badge: {
    position: 'absolute',
    bottom: 6,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
  },
  dot: { width: 6, height: 6, borderRadius: 3 },
  badgeText: { color: 'rgba(255,255,255,0.85)', fontSize: 9, letterSpacing: 1.2, fontWeight: '700' },
});
