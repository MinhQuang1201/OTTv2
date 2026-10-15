// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeAudioContext,
  getAudioContext,
  playSynthesizedSound,
  resetAudioContextForTesting,
} from "./soundSynthesis";

describe("soundSynthesis", () => {
  beforeEach(() => {
    resetAudioContextForTesting();
  });

  afterEach(async () => {
    await closeAudioContext();
    vi.restoreAllMocks();
  });

  it("returns null when window.AudioContext is not present", () => {
    const originalAudioContext = window.AudioContext;
    // @ts-expect-error simulating missing API
    delete window.AudioContext;

    expect(getAudioContext()).toBeNull();
    // playSynthesizedSound should no-op safely without errors
    expect(() => playSynthesizedSound("move")).not.toThrow();

    window.AudioContext = originalAudioContext;
  });

  it("synthesizes move sound with oscillator and gain nodes", () => {
    const startSpy = vi.fn();
    const stopSpy = vi.fn();
    const connectSpy = vi.fn();
    const setValueAtTimeSpy = vi.fn();
    const expRampSpy = vi.fn();

    const mockOsc = {
      type: "sine",
      frequency: {
        setValueAtTime: setValueAtTimeSpy,
        exponentialRampToValueAtTime: expRampSpy,
      },
      connect: connectSpy,
      start: startSpy,
      stop: stopSpy,
    };

    const mockGain = {
      gain: {
        setValueAtTime: setValueAtTimeSpy,
        exponentialRampToValueAtTime: expRampSpy,
      },
      connect: connectSpy,
    };

    const mockCtx = {
      state: "running",
      currentTime: 10,
      createOscillator: vi.fn(() => mockOsc),
      createGain: vi.fn(() => mockGain),
      destination: {},
      resume: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };

    window.AudioContext = vi.fn(() => mockCtx) as unknown as typeof AudioContext;

    playSynthesizedSound("move");

    expect(mockCtx.createOscillator).toHaveBeenCalled();
    expect(mockCtx.createGain).toHaveBeenCalled();
    expect(startSpy).toHaveBeenCalled();
    expect(stopSpy).toHaveBeenCalled();
  });

  it("resumes suspended audio context on play", () => {
    const resumeSpy = vi.fn().mockResolvedValue(undefined);
    const mockCtx = {
      state: "suspended",
      currentTime: 0,
      createOscillator: vi.fn(() => ({
        frequency: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      })),
      createGain: vi.fn(() => ({
        gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
        connect: vi.fn(),
      })),
      destination: {},
      resume: resumeSpy,
      close: vi.fn().mockResolvedValue(undefined),
    };

    window.AudioContext = vi.fn(() => mockCtx) as unknown as typeof AudioContext;

    playSynthesizedSound("capture");
    expect(resumeSpy).toHaveBeenCalled();
  });
});
