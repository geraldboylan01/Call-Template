import { ThinkingTone } from './thinking_tone.js';

const PALETTE = {
  off:                { hi: '#c3dcf0', lo: '#2c4d6d', glow: '90,140,185' },
  connecting:         { hi: '#a8dcff', lo: '#2f6f9e', glow: '110,180,235' },
  listening:          { hi: '#8dd3ff', lo: '#2b7fb8', glow: '141,211,255' },
  user_speaking:      { hi: '#dff2ff', lo: '#4eb0ff', glow: '120,200,255' },
  thinking:           { hi: '#bfd6e8', lo: '#3b5f80', glow: '150,190,225' },
  responding:         { hi: '#b6ecdc', lo: '#2f8f8c', glow: '130,225,205' },
  assistant_speaking: { hi: '#7ad7b4', lo: '#248f75', glow: '122,215,180' },
  muted:              { hi: '#e2b765', lo: '#7d5c24', glow: '226,183,101' },
  error:              { hi: '#ff9c91', lo: '#8e3f37', glow: '255,156,145' },
  budget_exhausted:   { hi: '#9fe0c6', lo: '#2e6b5c', glow: '122,215,180' }
};

const PHASE_ALIAS = {
  interrupted: 'listening',
  reconnecting: 'connecting',
  audio_blocked: 'muted'
};

export class RealtimeOrb {
  constructor(canvas, { shell } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.shell = shell || canvas.closest('.realtime-voice-shell');
    this.phase = 'off';
    this.amp = 0;
    this.micLevel = 0;
    this.remoteLevel = 0;
    this.width = 0;
    this.height = 0;
    this.dpr = 1;
    this.raf = null;
    this.micAnalyser = null;
    this.remoteAnalyser = null;
    this.reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.tick = this.tick.bind(this);
    this.resize = this.resize.bind(this);
    this.handleVisibilityChange = this.handleVisibilityChange.bind(this);
    this.handleMotionChange = this.handleMotionChange.bind(this);

    this.observer = new MutationObserver(() => {
      this.syncPhase();
      if (this.shell?.hidden) {
        this.stop();
        return;
      }
      this.resize();
      this.start();
    });
    if (this.shell) {
      this.observer.observe(this.shell, {
        attributes: true,
        attributeFilter: ['data-realtime-phase', 'hidden']
      });
      this.syncPhase();
    }

    this.resizeObserver = typeof ResizeObserver === 'function'
      ? new ResizeObserver(this.resize)
      : null;
    this.resizeObserver?.observe(this.canvas);
    window.addEventListener('resize', this.resize);
    document.addEventListener('visibilitychange', this.handleVisibilityChange);
    if (typeof this.reduced.addEventListener === 'function') {
      this.reduced.addEventListener('change', this.handleMotionChange);
    } else {
      this.reduced.addListener?.(this.handleMotionChange);
    }
    this.resize();
    if (!document.hidden) this.start();
  }

  syncPhase() {
    const raw = this.shell?.dataset.realtimePhase || 'off';
    this.phase = PHASE_ALIAS[raw] || (PALETTE[raw] ? raw : 'listening');
    this.paintLabel();
    // A thinking pause is several seconds of silence, which a caller reads as
    // a dropped line unless something tells them otherwise. The tone is driven
    // from the same phase as the orb so the two can never disagree.
    this.thinkingTone = this.thinkingTone || new ThinkingTone({ audioContext: this.audioCtx });
    this.thinkingTone.syncPhase(this.phase);
    this.start();
  }

  paintLabel() {
    const p = PALETTE[this.phase];
    const el = document.getElementById('realtimeVoiceOrbLabel');
    if (!el || !p) return;
    el.style.color = p.hi;
    el.style.borderColor = `rgba(${p.glow},.42)`;
    el.style.boxShadow = `0 0 24px rgba(${p.glow},.16)`;
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.round(rect.width * dpr);
    const height = Math.round(rect.height * dpr);
    this.width = rect.width;
    this.height = rect.height;
    this.dpr = dpr;
    if (this.canvas.width === width && this.canvas.height === height) {
      this.start();
      return;
    }
    this.canvas.width = width;
    this.canvas.height = height;
    this.start();
  }

  canRun() {
    return !document.hidden
      && !this.shell?.hidden
      && this.width > 0
      && this.height > 0;
  }

  start() {
    if (this.canRun() && this.raf === null && this.ctx) {
      this.t0 = this.t0 || performance.now();
      this.raf = requestAnimationFrame(this.tick);
    }
  }

  stop() {
    if (this.raf === null) return;
    cancelAnimationFrame(this.raf);
    this.raf = null;
  }

  handleVisibilityChange() {
    if (document.hidden) this.stop();
    else {
      this.resize();
      this.start();
    }
  }

  handleMotionChange() {
    this.stop();
    this.amp = 0;
    this.start();
  }

  destroy() {
    this.stop();
    // The tone must not outlive the call: an orb torn down mid-pulse would
    // otherwise keep sounding with nothing on screen to explain it.
    this.thinkingTone?.destroy();
    this.thinkingTone = null;
    this.observer.disconnect();
    this.resizeObserver?.disconnect();
    window.removeEventListener('resize', this.resize);
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    if (typeof this.reduced.removeEventListener === 'function') {
      this.reduced.removeEventListener('change', this.handleMotionChange);
    } else {
      this.reduced.removeListener?.(this.handleMotionChange);
    }
    this.disconnectAnalyser(this.micAnalyser);
    this.disconnectAnalyser(this.remoteAnalyser);
    this.micAnalyser = null;
    this.remoteAnalyser = null;
    this.audioCtx?.close();
    this.audioCtx = null;
  }

  attachMicStream(stream) {
    this.micAnalyser = this.replaceAnalyser(this.micAnalyser, stream);
  }

  attachRemoteStream(stream) {
    this.remoteAnalyser = this.replaceAnalyser(this.remoteAnalyser, stream);
  }

  replaceAnalyser(current, stream) {
    if (current?.__stream === stream) return current;
    this.disconnectAnalyser(current);
    return this.analyserFor(stream);
  }

  disconnectAnalyser(analyser) {
    try { analyser?.__source?.disconnect(); } catch (_error) { /* best effort */ }
    try { analyser?.disconnect(); } catch (_error) { /* best effort */ }
  }

  analyserFor(stream) {
    if (!stream) return null;
    try {
      this.audioCtx = this.audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const node = this.audioCtx.createAnalyser();
      const source = this.audioCtx.createMediaStreamSource(stream);
      node.fftSize = 1024;
      source.connect(node);
      node.__source = source;
      node.__stream = stream;
      return node;
    } catch (_error) {
      return null;
    }
  }

  levelOf(analyser) {
    if (!analyser) return 0;
    const buf = analyser.__buf || (analyser.__buf = new Uint8Array(analyser.fftSize));
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i += 1) {
      const v = (buf[i] - 128) / 128;
      sum += v * v;
    }
    return Math.min(1, Math.sqrt(sum / buf.length) * 4.2);
  }

  energy(t, useLiveAudio = true) {
    const n = (frequency, phase) => 0.5 + 0.5 * Math.sin(t * frequency + phase);
    if (useLiveAudio && this.phase === 'user_speaking' && this.micAnalyser) {
      return 0.28 + 0.66 * this.micLevel;
    }
    if (useLiveAudio && this.phase === 'assistant_speaking' && this.remoteAnalyser) {
      return 0.28 + 0.66 * this.remoteLevel;
    }
    switch (this.phase) {
      case 'off': return 0.10 + 0.05 * n(0.8, 0);
      case 'connecting': return 0.26 + 0.16 * n(3.4, 0);
      case 'listening': return 0.19 + 0.09 * n(1.15, 0);
      case 'user_speaking':
        return 0.30 + 0.58 * (0.5 * n(9.1, 0) + 0.3 * n(14.3, 1.2) + 0.2 * n(5.1, 2.4));
      case 'thinking': return 0.30 + 0.07 * n(2.3, 0);
      case 'responding': return 0.42 + 0.20 * n(4.6, 0);
      case 'assistant_speaking':
        return 0.38 + 0.50 * (0.55 * n(7.4, 0.4) + 0.25 * n(12.7, 1.9) + 0.2 * n(3.3, 3));
      case 'muted': return 0.05;
      case 'error': return 0.09 + 0.04 * n(6.2, 0);
      default: return 0.13 + 0.03 * n(0.6, 0);
    }
  }

  direction() {
    if (['listening', 'user_speaking', 'responding'].includes(this.phase)) return -1;
    if (['assistant_speaking', 'connecting'].includes(this.phase)) return 1;
    return 0;
  }

  spec(t, angle, amp = this.amp) {
    if (['muted', 'off', 'budget_exhausted'].includes(this.phase)) {
      return 0.18 + 0.1 * Math.sin(angle * 3 + t * 0.5);
    }
    if (this.phase === 'error') return 0;
    const value = 0.45 * Math.sin(angle * 3 + t * 1.7)
      + 0.30 * Math.sin(angle * 5 - t * 2.3 + 1.1)
      + 0.25 * Math.sin(angle * 8 + t * 3.1 + 2.2);
    return Math.max(0, 0.35 + 0.65 * amp * (0.5 + 0.5 * value));
  }

  tick(now) {
    const reduced = this.reduced.matches;
    const t = reduced ? 0 : (now - this.t0) / 1000;
    if (reduced) {
      this.micLevel = 0;
      this.remoteLevel = 0;
      this.amp = this.energy(0, false);
    } else {
      this.micLevel = this.levelOf(this.micAnalyser);
      this.remoteLevel = this.levelOf(this.remoteAnalyser);
      this.amp += (this.energy(t) - this.amp) * 0.18;
    }
    this.draw(t, this.amp);
    if (reduced || !this.canRun()) {
      this.raf = null;
      return;
    }
    this.raf = requestAnimationFrame(this.tick);
  }

  draw(t, amp = this.amp) {
    const { ctx, canvas } = this;
    if (!ctx || canvas.width <= 0 || canvas.height <= 0 || this.width <= 0 || this.height <= 0) return;
    const w = this.width;
    const h = this.height;
    const cx = w / 2;
    const cy = h / 2;
    const R = Math.min(w, h) / 2 - 8;
    if (R <= 0) return;
    const p = PALETTE[this.phase] || PALETTE.listening;
    const dir = this.reduced.matches ? 0 : this.direction();

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.save();
    ctx.translate(cx, cy);

    let glow = ctx.createRadialGradient(0, 0, R * 0.2, 0, 0, R * 1.1);
    glow.addColorStop(0, `rgba(${p.glow},${(0.14 + 0.16 * amp).toFixed(3)})`);
    glow.addColorStop(1, `rgba(${p.glow},0)`);
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(0, 0, R * 1.1, 0, Math.PI * 2);
    ctx.fill();

    if (dir !== 0) {
      const speed = this.phase === 'assistant_speaking' ? 0.55 : 0.42;
      for (let i = 0; i < 3; i += 1) {
        let fraction = (t * speed + i / 3) % 1;
        if (dir < 0) fraction = 1 - fraction;
        const radius = R * (0.62 + 0.36 * fraction);
        const fade = dir > 0 ? 1 - fraction : fraction;
        ctx.strokeStyle = `rgba(${p.glow},${(0.42 * fade * (0.4 + amp)).toFixed(3)})`;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(0, 0, radius, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    const discRadius = R * 0.62;
    const disc = ctx.createLinearGradient(0, -discRadius, 0, discRadius);
    disc.addColorStop(0, `rgba(${p.glow},.10)`);
    disc.addColorStop(1, 'rgba(4,11,19,.86)');
    ctx.fillStyle = disc;
    ctx.beginPath();
    ctx.arc(0, 0, discRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = `rgba(${p.glow},.34)`;
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.arc(0, 0, discRadius, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(149,188,225,.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(0, 0, R * 0.92, 0, Math.PI * 2);
    ctx.stroke();
    const sweep = this.phase === 'thinking' ? 2.2 : this.phase === 'connecting' ? 3.1 : 0;
    ctx.lineCap = 'round';
    if (sweep) {
      ctx.strokeStyle = p.hi;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(0, 0, R * 0.92, t * sweep, t * sweep + 1.1);
      ctx.stroke();
    } else {
      ctx.strokeStyle = `rgba(${p.glow},${(0.3 + 0.5 * amp).toFixed(3)})`;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(0, 0, R * 0.92, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (0.25 + 0.7 * amp));
      ctx.stroke();
    }

    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, discRadius - 2, 0, Math.PI * 2);
    ctx.clip();
    const halfWidth = discRadius * 0.94;

    if (this.phase === 'thinking') {
      for (let i = 0; i < 3; i += 1) {
        const progress = (t * 1.15 + i / 3) % 1;
        ctx.globalAlpha = Math.sin(progress * Math.PI);
        ctx.fillStyle = p.hi;
        ctx.beginPath();
        ctx.arc(-halfWidth + 2 * halfWidth * progress, 0, R * 0.035, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    } else if (this.phase === 'user_speaking') {
      const bars = 26;
      for (let i = 0; i < bars; i += 1) {
        const x = -halfWidth + (i / (bars - 1)) * 2 * halfWidth;
        const value = this.spec(t, i * 0.5, amp) * (1 - Math.abs(i / (bars - 1) - 0.5) * 0.7);
        const barHeight = Math.max(R * 0.02, R * 0.34 * value);
        const barWidth = R * 0.028;
        const barRadius = R * 0.014;
        ctx.fillStyle = p.hi;
        ctx.globalAlpha = 0.55 + 0.45 * value;
        ctx.beginPath();
        if (typeof ctx.roundRect === 'function') {
          ctx.roundRect(x - barWidth / 2, -barHeight / 2, barWidth, barHeight, barRadius);
        } else {
          ctx.rect(x - barWidth / 2, -barHeight / 2, barWidth, barHeight);
        }
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    } else {
      const flat = ['muted', 'error', 'budget_exhausted'].includes(this.phase);
      const layers = flat ? 1 : (this.phase === 'assistant_speaking' ? 2 : 3);
      for (let layer = 0; layer < layers; layer += 1) {
        ctx.beginPath();
        for (let x = -halfWidth; x <= halfWidth; x += 2) {
          const u = x / halfWidth;
          const damp = Math.cos((u * Math.PI) / 2);
          let y = 0;
          if (!flat && this.phase === 'assistant_speaking') {
            y = damp * R * 0.30 * amp * (
              0.78 * Math.sin(u * 3.4 - t * 1.65 + layer * 0.8)
              + 0.22 * Math.sin(u * 6.2 + t * 0.7 + layer * 1.5)
            );
          } else if (!flat) {
            y = damp * R * 0.30 * amp * (
              0.6 * Math.sin(u * 5.5 - t * 1.5 + layer * 0.9)
              + 0.4 * Math.sin(u * 9.2 + t * 2.1 + layer * 1.7)
            );
          }
          if (x === -halfWidth) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = layer === 0 ? p.hi : `rgba(${p.glow},${(0.3 - layer * 0.09).toFixed(2)})`;
        ctx.lineWidth = layer === 0 ? 2.6 : 1.6;
        ctx.lineJoin = 'round';
        ctx.stroke();
      }
    }
    ctx.restore();
    ctx.restore();
  }
}
