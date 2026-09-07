import { createAudioPlayer, type AudioPlayer } from 'expo-audio';

const SILENCE = require('../../assets/audio/silence.wav');

/**
 * An inaudible looping track that plays for the whole session.
 *
 * iOS only keeps a backgrounded app running while its audio session is
 * actually producing sound. Between two shuttles there are up to 10 seconds of
 * silence — long enough for the app to be suspended and every pending timer to
 * stop. Looping one second of near-silence keeps the session continuously
 * active, so the cues after the recovery period still fire on time.
 */
let player: AudioPlayer | null = null;

export function startKeepAlive(): void {
  if (!player) {
    player = createAudioPlayer(SILENCE, { keepAudioSessionActive: true });
    player.loop = true;
    player.volume = 1; // the file itself is 1 LSB — inaudible at any volume
  }
  player.play();
}

export function stopKeepAlive(): void {
  player?.pause();
}

export function releaseKeepAlive(): void {
  player?.remove();
  player = null;
}

export function isKeepAliveRunning(): boolean {
  return player?.playing ?? false;
}
