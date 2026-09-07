import { createAudioPlayer, type AudioPlayer } from 'expo-audio';
import * as Haptics from 'expo-haptics';

export type CueName = 'beep' | 'level' | 'tick' | 'end';

const SOURCES = {
  beep: require('../../assets/audio/beep.wav'),
  level: require('../../assets/audio/level.wav'),
  tick: require('../../assets/audio/tick.wav'),
  end: require('../../assets/audio/end.wav'),
} as const;

const HAPTICS: Record<CueName, Haptics.ImpactFeedbackStyle> = {
  beep: Haptics.ImpactFeedbackStyle.Heavy,
  level: Haptics.ImpactFeedbackStyle.Rigid,
  tick: Haptics.ImpactFeedbackStyle.Light,
  end: Haptics.ImpactFeedbackStyle.Heavy,
};

/**
 * Two players per cue, used alternately. A cue can be re-triggered before the
 * previous one has finished rewinding, and `seekTo` is async — one player would
 * mean either a swallowed beep or an unpredictable delay.
 */
const POOL_SIZE = 2;

type Pool = { players: AudioPlayer[]; next: number };

let pools: Record<CueName, Pool> | null = null;

function build(name: CueName): Pool {
  const players = Array.from({ length: POOL_SIZE }, () =>
    // keepAudioSessionActive stops the session from tearing down between cues,
    // which on iOS would suspend the app during the 10 s recovery periods.
    createAudioPlayer(SOURCES[name], { keepAudioSessionActive: true }),
  );
  for (const player of players) player.volume = 1;
  return { players, next: 0 };
}

/** Loads every cue up front so the first beep is not late. */
export function loadCues(): void {
  if (pools) return;
  pools = {
    beep: build('beep'),
    level: build('level'),
    tick: build('tick'),
    end: build('end'),
  };
}

export function releaseCues(): void {
  if (!pools) return;
  for (const pool of Object.values(pools)) {
    for (const player of pool.players) player.remove();
  }
  pools = null;
}

/**
 * Fires a cue now. Synchronous on purpose: the rewind of the player we just
 * used happens afterwards, so nothing is awaited on the critical path.
 */
export function playCue(name: CueName, withHaptics = true): void {
  if (!pools) loadCues();
  const pool = pools![name];
  const player = pool.players[pool.next];
  pool.next = (pool.next + 1) % pool.players.length;

  player.seekTo(0).catch(() => {});
  player.play();

  if (withHaptics) {
    Haptics.impactAsync(HAPTICS[name]).catch(() => {});
  }
}

export function setCueVolume(volume: number): void {
  if (!pools) return;
  for (const pool of Object.values(pools)) {
    for (const player of pool.players) player.volume = volume;
  }
}
