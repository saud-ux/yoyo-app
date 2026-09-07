import { createAudioPlayer, type AudioPlayer } from 'expo-audio';

const SILENCE = require('../../assets/audio/silence.wav');

export type KeepAliveState = 'playing' | 'stalled';

type Subscription = ReturnType<AudioPlayer['addListener']>;

/**
 * An inaudible looping track that plays for the whole session.
 *
 * iOS only keeps a backgrounded app running while its audio session is
 * actually producing sound. Between two shuttles there are up to 10 seconds of
 * silence — long enough for the app to be suspended and every pending timer to
 * stop. Looping one second of near-silence keeps the session continuously
 * active, so the cues after the recovery period still fire on time.
 *
 * It doubles as the app's interruption detector. This is the one player we
 * never stop ourselves, so if it reports that it is not playing while a
 * session is running, something outside the app took the audio away.
 */
let player: AudioPlayer | null = null;
let subscription: Subscription | null = null;
/** What we asked for, as opposed to what the system is currently doing. */
let wantPlaying = false;
/** Set once the loop has actually been heard from, so start-up is not a stall. */
let confirmedPlaying = false;

const listeners = new Set<(state: KeepAliveState) => void>();

function emit(state: KeepAliveState): void {
  for (const listener of listeners) listener(state);
}

function ensurePlayer(): AudioPlayer {
  if (player) return player;

  const created = createAudioPlayer(SILENCE, { keepAudioSessionActive: true });
  created.loop = true;
  subscription = created.addListener('playbackStatusUpdate', (status) => {
    if (status.playing) {
      confirmedPlaying = true;
      emit('playing');
      return;
    }
    if (wantPlaying && confirmedPlaying) emit('stalled');
  });

  player = created;
  return created;
}

export function startKeepAlive(): void {
  wantPlaying = true;
  const current = ensurePlayer();
  // Reassert the volume on every start, not just on creation: expo-audio halves
  // every player's volume when an interruption begins and restores it only if
  // iOS reports shouldResume, so this is also the recovery path.
  current.volume = 1; // the file itself is 1 LSB — inaudible at any volume
  current.play();
}

export function stopKeepAlive(): void {
  wantPlaying = false;
  confirmedPlaying = false;
  player?.pause();
}

export function releaseKeepAlive(): void {
  wantPlaying = false;
  confirmedPlaying = false;
  subscription?.remove();
  subscription = null;
  player?.remove();
  player = null;
}

/** True only while the loop is actually producing audio. */
export function isKeepAliveRunning(): boolean {
  return player?.playing ?? false;
}

/** Subscribe to keep-alive health. Returns an unsubscribe function. */
export function addKeepAliveListener(
  listener: (state: KeepAliveState) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
