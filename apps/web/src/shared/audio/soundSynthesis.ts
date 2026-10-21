export type SoundCue = "move" | "capture" | "win" | "step";

let audioCtxInstance: AudioContext | null = null;

/**
 * Returns the lazily initialized AudioContext or null if unsupported.
 */
export function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") {
    return null;
  }
  const AudioCtxConstructor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

  if (!AudioCtxConstructor) {
    return null;
  }

  if (!audioCtxInstance || audioCtxInstance.state === "closed") {
    try {
      audioCtxInstance = new AudioCtxConstructor();
    } catch {
      return null;
    }
  }

  return audioCtxInstance;
}

/**
 * Closes the active AudioContext instance if one exists.
 * Primarily used in test teardown or complete app reset.
 */
export async function closeAudioContext(): Promise<void> {
  if (audioCtxInstance && audioCtxInstance.state !== "closed") {
    try {
      await audioCtxInstance.close();
    } catch {
      // Ignore cleanup error
    }
    audioCtxInstance = null;
  }
}

/**
 * Resets the cached AudioContext instance (useful in tests when mocking).
 */
export function resetAudioContextForTesting(): void {
  audioCtxInstance = null;
}

/**
 * Plays a synthesized procedural audio cue using the Web Audio API.
 * Never requires external network assets.
 */
export function playSynthesizedSound(cue: SoundCue): void {
  const ctx = getAudioContext();
  if (!ctx) return;

  if (ctx.state === "suspended") {
    ctx.resume().catch(() => {
      // Browser autoplay restriction prevented resume
    });
  }

  try {
    const now = ctx.currentTime;

    switch (cue) {
      case "move": {
        // Soft sine tone sliding 440Hz -> 520Hz over 40ms
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(440, now);
        osc.frequency.exponentialRampToValueAtTime(520, now + 0.04);

        gain.gain.setValueAtTime(0.12, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.045);

        osc.connect(gain);
        gain.connect(ctx.destination);

        osc.start(now);
        osc.stop(now + 0.05);
        break;
      }

      case "capture": {
        // Punchy triangle tone decaying 320Hz -> 140Hz over 80ms
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "triangle";
        osc.frequency.setValueAtTime(320, now);
        osc.frequency.exponentialRampToValueAtTime(140, now + 0.08);

        gain.gain.setValueAtTime(0.18, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.085);

        osc.connect(gain);
        gain.connect(ctx.destination);

        osc.start(now);
        osc.stop(now + 0.09);
        break;
      }

      case "step": {
        // Subtle tick: short 600Hz blip
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(600, now);

        gain.gain.setValueAtTime(0.08, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.02);

        osc.connect(gain);
        gain.connect(ctx.destination);

        osc.start(now);
        osc.stop(now + 0.025);
        break;
      }

      case "win": {
        // Three ascending triad notes: C5 (523Hz), E5 (659Hz), G5 (784Hz)
        const notes = [523.25, 659.25, 783.99];
        notes.forEach((freq, idx) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          const noteTime = now + idx * 0.08;

          osc.type = "triangle";
          osc.frequency.setValueAtTime(freq, noteTime);

          gain.gain.setValueAtTime(0.15, noteTime);
          gain.gain.exponentialRampToValueAtTime(0.001, noteTime + 0.12);

          osc.connect(gain);
          gain.connect(ctx.destination);

          osc.start(noteTime);
          osc.stop(noteTime + 0.13);
        });
        break;
      }
    }
  } catch {
    // Audio synthesis failure should never crash the game
  }
}
