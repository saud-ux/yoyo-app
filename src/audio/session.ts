import { setAudioModeAsync, setIsAudioActiveAsync } from 'expo-audio';

/**
 * The whole app depends on this call. The user puts the phone on the ground,
 * locks it, and walks 20 m away, so:
 *
 * - `playsInSilentMode` makes the cues survive the iPhone's silent switch.
 * - `shouldPlayInBackground` keeps the audio session alive once the screen
 *   locks, which is also what keeps our JavaScript timers running.
 *
 * Paired with `UIBackgroundModes: ["audio"]` in app.json. Both are required —
 * either one alone leaves the audio dead in the pocket.
 */
export async function configureAudioSession(): Promise<void> {
  await setAudioModeAsync({
    playsInSilentMode: true,
    shouldPlayInBackground: true,
    interruptionMode: 'duckOthers',
    shouldRouteThroughEarpiece: false,
    allowsRecording: false,
  });
}

/**
 * Recovery path after an interruption — a call, an alarm, Siri.
 *
 * Re-applying the audio mode is not enough on its own: once something else has
 * taken the session, iOS leaves it deactivated until someone asks for it back.
 */
export async function reactivateAudioSession(): Promise<void> {
  await configureAudioSession();
  await setIsAudioActiveAsync(true);
}
