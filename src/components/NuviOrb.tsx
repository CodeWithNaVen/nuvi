import { useEffect, useRef } from "react";
import { motion } from "motion/react";

type OrbState = "idle" | "listening" | "thinking" | "speaking";

interface Props {
  state: OrbState;
  amplitude?: number;
  size?: number;
}

export function NuviOrb({ state, amplitude = 0, size = 240 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ampRef = useRef(0);

  useEffect(() => {
    ampRef.current = amplitude;
  }, [amplitude]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    const dpr = Math.min(window.devicePixelRatio, 2);
    const w = size * dpr;
    const h = size * dpr;
    canvas.width = w;
    canvas.height = h;
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;

    const style = getComputedStyle(document.documentElement);
    const core = style.getPropertyValue("--orb-core").trim() || "#d97757";
    const glow = style.getPropertyValue("--orb-glow").trim() || "#f0a080";

    let t = 0;

    const draw = () => {
      t += 0.016;
      ctx.clearRect(0, 0, w, h);

      const cx = w / 2;
      const cy = h / 2;
      const baseR = (size * 0.35) * dpr;

      // Smooth amplitude follow
      const target = ampRef.current;
      const isActive = state === "speaking" || state === "listening";
      const jitter = isActive ? target * 0.5 : 0;
      const breath = state === "idle" ? Math.sin(t * 0.8) * 0.04 : 0;

      // Outer glow rings
      const rings = state === "thinking" ? 3 : 2;
      for (let i = 0; i < rings; i++) {
        const r = baseR * (1.35 + i * 0.18 + breath + jitter * 0.3);
        const alpha = state === "idle" ? 0.08 - i * 0.03 : 0.14 - i * 0.05;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.strokeStyle = glow;
        (ctx as any).globalAlpha = Math.max(0, alpha + jitter * 0.15);
        ctx.lineWidth = (1.5 + jitter * 4) * dpr;
        ctx.stroke();
      }
      (ctx as any).globalAlpha = 1;

      // Core gradient
      const grad = ctx.createRadialGradient(cx - baseR * 0.3, cy - baseR * 0.3, baseR * 0.2, cx, cy, baseR * 1.1);
      grad.addColorStop(0, glow);
      grad.addColorStop(0.45, core);
      grad.addColorStop(1, core + "cc");

      const pulseScale = 1 + breath + jitter * 0.55;
      const coreR = baseR * pulseScale;

      // Core circle with subtle noise deformation
      ctx.beginPath();
      const points = 64;
      for (let i = 0; i <= points; i++) {
        const ang = (i / points) * Math.PI * 2;
        const noise = Math.sin(ang * 3 + t * 1.6) * Math.cos(ang * 2 + t * 1.2) * 0.03;
        const r = coreR * (1 + noise * (isActive ? 1.8 : 0.5));
        const x = cx + Math.cos(ang) * r;
        const y = cy + Math.sin(ang) * r;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();

      // Inner highlight
      ctx.beginPath();
      ctx.ellipse(cx - baseR * 0.25, cy - baseR * 0.28, baseR * 0.22, baseR * 0.18, -0.3, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,255,255,0.18)";
      ctx.fill();

      // Thinking shimmer
      if (state === "thinking") {
        const shimmerAlpha = 0.12 + Math.sin(t * 6) * 0.08;
        ctx.beginPath();
        ctx.arc(cx, cy, coreR * 1.08, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(255,255,255,${shimmerAlpha})`;
        ctx.lineWidth = 1 * dpr;
        ctx.stroke();
      }

      raf = requestAnimationFrame(draw);
    };

    draw();
    return () => cancelAnimationFrame(raf);
  }, [state, size]);

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
      className="relative flex items-center justify-center select-none"
      style={{ width: size, height: size }}
    >
      <canvas ref={canvasRef} className="block" />
      {/* Subtle dot when listening */}
      {state === "listening" && (
        <motion.div
          className="absolute bottom-1 left-1/2 -translate-x-1/2 flex items-center gap-1.5 rounded-full bg-black/40 border border-white/10 px-2.5 py-1 backdrop-blur"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
          <span className="text-[9px] font-mono tracking-widest text-white/70">LISTENING</span>
        </motion.div>
      )}
      {state === "speaking" && (
        <motion.div
          className="absolute bottom-1 left-1/2 -translate-x-1/2 flex items-center gap-1.5 rounded-full bg-black/40 border border-white/10 px-2.5 py-1 backdrop-blur"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent)] animate-pulse" />
          <span className="text-[9px] font-mono tracking-widest text-white/70">SPEAKING</span>
        </motion.div>
      )}
    </motion.div>
  );
}
