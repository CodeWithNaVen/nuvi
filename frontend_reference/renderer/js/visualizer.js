import * as THREE from "../../node_modules/three/build/three.module.js";
import { gsap } from "../../node_modules/gsap/index.js";

/**
 * A reactive glowing orb: idle breathing, ripples out while listening,
 * and jitters/pulses in sync with audio amplitude while speaking.
 */
export class Visualizer {
  constructor(canvas) {
    this.canvas = canvas;
    this.state = "idle"; // idle | listening | thinking | speaking
    this.amplitude = 0;
    this._targetAmplitude = 0;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    this.camera.position.z = 6;

    this._buildOrb();
    this._buildParticles();
    this._resize();
    window.addEventListener("resize", () => this._resize());

    this.clock = new THREE.Clock();
    this._animate();
  }

  _colors() {
    const style = getComputedStyle(document.documentElement);
    return {
      core: new THREE.Color(style.getPropertyValue("--orb-core").trim() || "#d97757"),
      glow: new THREE.Color(style.getPropertyValue("--orb-glow").trim() || "#f0a080"),
      ring: new THREE.Color(style.getPropertyValue("--orb-ring").trim() || "#8a5a45"),
    };
  }

  _buildOrb() {
    const { core, glow } = this._colors();
    const geometry = new THREE.IcosahedronGeometry(1.4, 24);
    this._basePositions = geometry.attributes.position.array.slice();

    const material = new THREE.MeshStandardMaterial({
      color: core,
      emissive: glow,
      emissiveIntensity: 0.6,
      roughness: 0.25,
      metalness: 0.15,
      wireframe: false,
      transparent: true,
      opacity: 0.95,
    });
    this.orb = new THREE.Mesh(geometry, material);
    this.scene.add(this.orb);

    const wireGeo = new THREE.IcosahedronGeometry(1.85, 2);
    const wireMat = new THREE.MeshBasicMaterial({ color: glow, wireframe: true, transparent: true, opacity: 0.18 });
    this.wireShell = new THREE.Mesh(wireGeo, wireMat);
    this.scene.add(this.wireShell);

    const light1 = new THREE.PointLight(core, 2.2, 12);
    light1.position.set(3, 2, 4);
    this.scene.add(light1);
    const light2 = new THREE.PointLight(glow, 1.4, 12);
    light2.position.set(-3, -2, 3);
    this.scene.add(light2);
    this.scene.add(new THREE.AmbientLight(0x222222, 1));
  }

  _buildParticles() {
    const { glow } = this._colors();
    const count = 180;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const r = 2.4 + Math.random() * 1.6;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      positions[i * 3 + 2] = r * Math.cos(phi);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({ color: glow, size: 0.02, transparent: true, opacity: 0.5 });
    this.particles = new THREE.Points(geo, mat);
    this.scene.add(this.particles);
  }

  _resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  refreshTheme() {
    const { core, glow } = this._colors();
    this.orb.material.color = core;
    this.orb.material.emissive = glow;
    this.wireShell.material.color = glow;
    this.particles.material.color = glow;
  }

  setState(state) {
    this.state = state;
    const targetScale = { idle: 1, listening: 1.08, thinking: 0.95, speaking: 1.0 }[state] ?? 1;
    gsap.to(this.orb.scale, { x: targetScale, y: targetScale, z: targetScale, duration: 0.5, ease: "power2.out" });
  }

  /** amplitude in [0,1] -- feed live mic or TTS playback level for reactive motion */
  setAmplitude(a) {
    this._targetAmplitude = Math.max(0, Math.min(1, a));
  }

  _animate = () => {
    requestAnimationFrame(this._animate);
    const t = this.clock.getElapsedTime();

    this.amplitude += (this._targetAmplitude - this.amplitude) * 0.2;

    const breathing = this.state === "idle" ? Math.sin(t * 0.8) * 0.04 : 0;
    const jitter = (this.state === "speaking" || this.state === "listening") ? this.amplitude * 0.35 : 0;

    const pos = this.orb.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const ix = i * 3;
      const bx = this._basePositions[ix], by = this._basePositions[ix + 1], bz = this._basePositions[ix + 2];
      const len = Math.sqrt(bx * bx + by * by + bz * bz) || 1;
      const noise = Math.sin(bx * 3 + t * 1.6) * Math.cos(by * 3 + t * 1.3) * 0.5 + 0.5;
      const displacement = 1 + breathing + jitter * noise * 0.6;
      pos.setXYZ(i, (bx / len) * len * displacement, (by / len) * len * displacement, (bz / len) * len * displacement);
    }
    pos.needsUpdate = true;

    this.orb.rotation.y = t * 0.15;
    this.orb.rotation.x = Math.sin(t * 0.1) * 0.1;
    this.wireShell.rotation.y = -t * 0.08;
    this.wireShell.rotation.x = t * 0.05;
    this.particles.rotation.y = t * 0.03;

    this.orb.material.emissiveIntensity = 0.5 + this.amplitude * 1.2 + (this.state === "thinking" ? Math.sin(t * 6) * 0.2 + 0.2 : 0);

    this.renderer.render(this.scene, this.camera);
  };
}
