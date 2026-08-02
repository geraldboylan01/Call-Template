/**
 * The sound the meeting makes while it is thinking.
 *
 * A live call goes quiet for several seconds after the client stops speaking,
 * while the planner reads what they said. Silence in a conversation means one of
 * two things -- the other person is thinking, or the line has dropped -- and a
 * caller with no way to tell assumes the second and starts talking over it.
 * A soft, unmistakably deliberate pulse removes the ambiguity.
 *
 * SYNTHESISED, NOT A FILE. This repo ships no audio assets and has no
 * dependencies, and a downloaded sound is one more thing to host, cache and get
 * wrong on a flaky connection. Two quiet sine tones and a slow envelope cost
 * nothing and start instantly.
 *
 * The sound is deliberately dull: low, soft-edged, well under the voice, and
 * pulsing slowly enough to read as patience rather than urgency. It should be
 * possible to stop noticing it. Anything brighter starts to feel like an alarm
 * on the tenth turn of a real conversation.
 */

/** Root of the pulse, in Hz. Low enough to sit under speech without masking it. */
const ROOT_HZ = 196;
/** A fifth above, quieter, to give the pulse a little warmth rather than a beep. */
const FIFTH_HZ = 294;
/** Seconds between pulses. Slow: this is patience, not a progress bar. */
const PULSE_SECONDS = 1.9;
/** Peak gain. Quiet enough to talk over comfortably. */
const PEAK_GAIN = 0.035;

export class ThinkingTone {
  /**
   * @param {object} [options]
   * @param {AudioContext} [options.audioContext] an existing context to share.
   *   The call already has one for the microphone; making a second is wasteful
   *   and can be blocked outright on some browsers.
   */
  constructor({ audioContext = null } = {}) {
    this.audioContext = audioContext;
    this.ownsContext = false;
    this.nodes = null;
    this.timer = null;
    this.muted = false;
  }

  /** Someone who has asked for less motion has asked for less of everything. */
  get suppressed() {
    if (this.muted) return true;
    try {
      return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (_error) {
      return false;
    }
  }

  setMuted(muted) {
    this.muted = muted === true;
    if (this.muted) this.stop();
  }

  ensureContext() {
    if (this.audioContext) return this.audioContext;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return null;
    try {
      this.audioContext = new AudioContextClass();
      this.ownsContext = true;
      return this.audioContext;
    } catch (_error) {
      return null;
    }
  }

  start() {
    if (this.nodes || this.suppressed) return;
    const context = this.ensureContext();
    if (!context) return;
    // A context created before the first gesture starts suspended; resuming is
    // a no-op when it is already running.
    context.resume?.().catch(() => {});

    const gain = context.createGain();
    gain.gain.value = 0;
    gain.connect(context.destination);

    const root = context.createOscillator();
    root.type = 'sine';
    root.frequency.value = ROOT_HZ;
    const fifth = context.createOscillator();
    fifth.type = 'sine';
    fifth.frequency.value = FIFTH_HZ;
    const fifthGain = context.createGain();
    fifthGain.gain.value = 0.4;

    root.connect(gain);
    fifth.connect(fifthGain);
    fifthGain.connect(gain);
    root.start();
    fifth.start();

    this.nodes = { gain, root, fifth, fifthGain };
    this.pulse();
    this.timer = setInterval(() => this.pulse(), PULSE_SECONDS * 1000);
  }

  /** One soft swell. Long attack and release so it never clicks or startles. */
  pulse() {
    if (!this.nodes || !this.audioContext) return;
    const { gain } = this.nodes;
    const now = this.audioContext.currentTime;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.linearRampToValueAtTime(PEAK_GAIN, now + 0.45);
    gain.gain.linearRampToValueAtTime(0.0001, now + 1.35);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (!this.nodes) return;
    const { gain, root, fifth } = this.nodes;
    const now = this.audioContext?.currentTime ?? 0;
    try {
      // Fade rather than cut: stopping an oscillator at full gain clicks.
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(gain.gain.value, now);
      gain.gain.linearRampToValueAtTime(0.0001, now + 0.18);
      root.stop(now + 0.2);
      fifth.stop(now + 0.2);
    } catch (_error) { /* best effort */ }
    this.nodes = null;
  }

  /**
   * Drive the tone from the meeting's own phase, so it can never disagree with
   * what the orb is showing.
   */
  syncPhase(phase) {
    if (phase === 'thinking') this.start();
    else this.stop();
  }

  destroy() {
    this.stop();
    if (this.ownsContext) {
      try { this.audioContext?.close?.(); } catch (_error) { /* best effort */ }
    }
    this.audioContext = null;
  }
}
