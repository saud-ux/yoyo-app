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
 * Two players per cue, used alternately, so a cue re-triggered before the
 * previous instance has finished rewinding still starts from a player that is
 * parked at zero.
 */
const POOL_SIZE = 2;

type Subscription = ReturnType<AudioPlayer['addListener']>;

type Pool = { players: AudioPlayer[]; next: number; subscriptions: Subscription[] };

let pools: Record<CueName, Pool> | null = null;

function build(name: CueName): Pool {
  const players: AudioPlayer[] = [];
  const subscriptions: Subscription[] = [];

  for (let i = 0; i < POOL_SIZE; i += 1) {
    // keepAudioSessionActive stops the session from tearing down between cues,
    // which on iOS would suspend the app during the 10 s recovery periods.
    const player = createAudioPlayer(SOURCES[name], { keepAudioSessionActive: true });
    player.volume = 1;

    // Rewind the moment the cue ends, so the seek is never on the critical path
    // of the next one. iOS raises this from AVPlayerItemDidPlayToEndTime rather
    // than from the status poll, so it lands as soon as the sound stops.
    subscriptions.push(
      player.addListener('playbackStatusUpdate', (status) => {
        if (status.didJustFinish) player.seekTo(0).catch(() => {});
      }),
    );

    players.push(player);
  }

  return { players, next: 0, subscriptions };
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
    for (const subscription of pool.subscriptions) subscription.remove();
    for (const player of pool.players) player.remove();
  }
  pools = null;
}

/**
 * Fires a cue now. Synchronous on purpose: an idle player is already parked at
 * zero, so nothing is awaited on the critical path.
 */
export function playCue(name: CueName, withHaptics = true): void {
  if (!pools) loadCues();
  const pool = pools![name];
  const player = pool.players[pool.next];
  pool.next = (pool.next + 1) % pool.players.length;

  // Normally a no-op. It only costs a seek when the rewind never arrived — a
  // cue cut short by an interruption, or one re-triggered inside a pool cycle —
  // which is exactly when playing from the old position would be silent.
  if (player.currentTime > 0) {
    player.seekTo(0).catch(() => {});
  }
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
