# Bug audit — read-only pass

Commit audited: `25f95a7`
Scope: every file in the repo except `node_modules/` and generated `assets/*.png`.
Nothing was changed. All fixes below are suggestions only.

---

## 1. Project map

**Entry point.** `package.json:4` sets `"main": "expo-router/entry"`. There is no
`index.ts`/`App.tsx`; expo-router owns the root and mounts `app/_layout.tsx`, which
renders a `Stack` with a single route, `app/index.tsx`. expo-router's `ExpoRoot`
already wraps the tree in a `SafeAreaProvider`
(`node_modules/expo-router/build/ExpoRoot.js:79`), so the `SafeAreaView` in
`app/index.tsx:128` has a provider — verified, not a bug.

**Modules.**

| Module | Role |
|---|---|
| `src/audio/session.ts` | One-shot global audio-mode config (silent switch + background) |
| `src/audio/cues.ts` | Module-level pools of `AudioPlayer`s, one pool per cue, plus haptics |
| `src/audio/keepAlive.ts` | Single looping near-silent player that holds the iOS session open |
| `src/timing/cueSchedule.ts` | Absolute-time cue scheduler + interval schedule builder |
| `src/theme/colors.ts` | Constants only |
| `scripts/generate-tones.mjs` | Build-time synthesiser producing `assets/audio/*.wav` |

**Data flow.**

```
app/_layout.tsx  mount ─→ loadCues()            (8 AudioPlayers created)
                 unmount ─→ releaseKeepAlive(), releaseCues()

app/index.tsx    mount ─→ configureAudioSession()  (async, gates the UI via `ready`)
                       ─→ AppState listener writes appStateRef

  press start ─→ stopTest() ─→ startKeepAlive()
              ─→ buildIntervalSchedule() ─→ runCueSchedule()
                    └─ arm() ─→ playCue() ─→ pool player .seekTo(0)/.play() + Haptics
                              └─ onFire() ─→ 4 setState calls (counters, drift)
                    └─ onFinish() ─→ playCue('end') + stopTest()
              ─→ setInterval(500ms) drives the elapsed clock
```

**Build/deploy config.** `app.json` (Expo config, `expo-audio` + `expo-router`
plugins, `UIBackgroundModes: ["audio"]`, `ITSAppUsesNonExemptEncryption: false`)
and `eas.json` (`preview` and `production` build profiles, remote app versioning).
Verified via `expo config --type introspect`: the generated `Info.plist` contains
`UIBackgroundModes: ['audio']` and `UIUserInterfaceStyle: 'Dark'`, and contains no
`NSMicrophoneUsageDescription` (correctly suppressed by the plugin options).

**State model.** All state is in-memory. There is no persistence layer, no network
call, and no third-party SDK. A grep for `api[_-]?key|secret|token|password|bearer|https?://`
across `app/ src/ scripts/ app.json eas.json` returns nothing, so the "works fully
offline, no secrets" claim holds for this commit. **No security findings.**

---

## 2. Findings

No Critical findings. Nothing in this commit crashes on launch, leaks credentials,
or loses persisted data (there is no persisted data yet). The two High findings both
break the app's single acceptance criterion — cues firing correctly while the phone
is on the ground with the screen locked.

---

### HIGH — Missed cues are replayed as one instant burst instead of being dropped

**File:** `src/timing/cueSchedule.ts:60-68`

**What breaks.** The user starts a 20-minute test and a phone call arrives at minute
4. iOS suspends the app, so no timer fires for the 90 seconds of the call. When the
app resumes, `arm()` finds 18 overdue cues and fires all 18 back-to-back within a
couple of milliseconds — a single garbled burst from the speaker — then continues.
The runner, 20 m away, hears one noise instead of the 18 shuttle beeps they missed,
and every one of those cues is logged with a drift of tens of seconds. The same
happens after any suspension: screen lock followed by a low-power stall, a Siri
interruption, an alarm.

**Why it happens.** After firing a cue, `arm()` calls itself synchronously
(line 68) with no check for whether the *next* cue is also already overdue. The
recursion only stops when it reaches a cue in the future, so a backlog of N cues
produces N `playCue()` calls in the same tick. The catch-up path is the same code
path as the normal path; there is no notion of "this cue's moment has passed, skip
it".

**Suggested fix.** Before firing, drop cues whose target is more than one tolerance
window (say 500 ms) in the past, reporting them through a new `onMissed` handler; only
fire the cue whose target is within tolerance, and yield to a real timer between
iterations rather than recursing synchronously.

---

### HIGH — No audio-interruption handling, so the test dies silently after a phone call

**File:** `src/audio/session.ts:14-22`, with no counterpart anywhere in
`app/index.tsx:51-65`

**What breaks.** A call comes in at minute 4 of a 20-minute test. iOS deactivates the
app's audio session for the duration. When the call ends, iOS does **not** resume a
paused player on its own unless the app handles the interruption-ended notification
and explicitly restarts playback. The keep-alive loop
(`src/audio/keepAlive.ts:16-23`) is therefore left paused, the audio session goes
idle, the app is suspended again, and no further cue is ever heard. The screen still
reads `مهيّأة` and, whenever the app is briefly resumed, the counters keep ticking —
so the UI reports a healthy run while the runner in the field hears silence for the
remaining 16 minutes.

**Why it happens.** `configureAudioSession()` sets the audio mode once and returns.
Nothing subscribes to interruption events or to player status
(`expo-audio` exposes `playbackStatusUpdate` on each player, and `AppState` is only
used to write `appStateRef` at `app/index.tsx:67-72` — it is read for statistics and
never acted on). There is no code path anywhere that restarts the keep-alive player
or re-activates the session.

**Suggested fix.** Subscribe to the keep-alive player's `playbackStatusUpdate` and,
on an `AppState` return to `active` or a status showing it stopped unexpectedly,
re-call `configureAudioSession()` and `startKeepAlive()`; surface an interrupted
state in the UI with an explicit resume action rather than continuing silently.

---

### MEDIUM — The player pool does not actually prevent the seek race it was built for

**File:** `src/audio/cues.ts:70-71` (contradicting the comment at `src/audio/cues.ts:20-24`)

**What breaks.** Each cue is fired by calling `player.seekTo(0)` and then, without
waiting, `player.play()`. After a player has been used once its position is at the
end of the file, so the `play()` on the next use is issued against a player that is
still at (or seeking away from) the end. The audible result is a clipped or missing
beep on reuse — most likely on the closely spaced cues, i.e. the 3-2-1 `tick`
sequence planned for the 10-second recovery in step 2.

**Why it happens.** `POOL_SIZE = 2` exists specifically so a cue can be re-triggered
while the previous instance is still rewinding, but the rewind is never moved off the
critical path: line 70 issues the seek at fire time, on the very player that is about
to play, so the second player in the pool buys nothing. The comment describes an
optimisation the code does not implement.

**Suggested fix.** Rewind after playing, not before: call `player.play()` first, then
`pool.players[pool.next].seekTo(0)` to pre-position the *next* player, so every fire
starts from an already-rewound player.

---

### MEDIUM — Every audio error is swallowed, so a dead cue path looks identical to a healthy one

**File:** `src/audio/cues.ts:70` and `src/audio/cues.ts:74`

**What breaks.** If `seekTo` starts rejecting — a released shared object, a player
that failed to load its asset, an audio session the OS has taken away — `.catch(() => {})`
discards the reason. On the diagnostic screen the run still shows the expected cue
count and a drift near zero, because `onFire` is invoked by the scheduler regardless
of whether the player made a sound. The user walks 20 m away, hears nothing, comes
back to a screen reporting a clean run, and has no information to report.

**Why it happens.** Two empty catch blocks on lines 70 and 74. `playCue` is `void`
and deliberately synchronous, so there is no channel for a failure to reach the
caller, and the scheduler treats "I called playCue" as "a cue was heard".

**Suggested fix.** Route both catches into a module-level error counter plus a
`console.warn`, expose the counter on the lab screen next to the cue count, and treat
a non-zero count as a failed run.

---

### MEDIUM — An empty or fully-overdue schedule leaks the elapsed-time interval and leaves `running` stuck true

**File:** `src/timing/cueSchedule.ts:47-50` and `71`, consumed at `app/index.tsx:99-122`

**What breaks.** When `runCueSchedule` is given a queue that completes immediately,
`arm()` runs `onFinish` synchronously at line 71 — *inside* the `runCueSchedule(...)`
call on `app/index.tsx:99`, before line 116 assigns `scheduleRef.current` and before
line 118 creates the ticker. `onFinish` calls `stopTest`, which clears refs that are
still null. Control then returns and `startTest` proceeds to create the
`setInterval` and call `setRunning(true)`. The result is a permanently running
interval with nothing to clear it, a button stuck on `إيقاف` whose `stopTest` finds a
null schedule, and a keep-alive player that is never paused.

**Why it happens.** `runCueSchedule` invokes its first `arm()` synchronously (line 71)
while `startTest` assumes every callback arrives asynchronously, after its own
bookkeeping is finished.

**Reachability.** Not reachable through today's UI: `DURATION_CHOICES` is
`[2, 5, 10]` minutes against a 5-second interval, so `buildIntervalSchedule` always
returns at least 24 items and the first is 5 seconds in the future. It becomes
reachable in step 2, where a real protocol has zero-length or already-elapsed
segments (a resumed test, a level with `shuttles: 0`, a schedule rebuilt after a
pause).

**Suggested fix.** Defer the first `arm()` by one tick (`setTimeout(arm, 0)`), or have
`startTest` assign `scheduleRef.current` and the ticker before any handler can run.

---

### LOW — The keep-alive waveform sits exactly at Nyquist, so it does not do what its comment claims

**File:** `scripts/generate-tones.mjs:76` (comment at `:74-75`)

**What breaks.** The comment says the file must not be digital silence because "some
audio stacks treat [that] as nothing is playing". The generated samples alternate
`+1, -1, +1, -1…`, which is a square wave at 22.05 kHz — exactly the Nyquist
frequency. A reconstruction filter removes it entirely, so the analogue output is
silence and, to anything measuring output rather than player state, the file is
indistinguishable from the digital silence it was meant to avoid.

Practical impact is likely nil: iOS grants background execution based on an active
audio session with a running player, not on output amplitude, so the keep-alive
almost certainly still works. But the safeguard the comment describes is not present.

**Why it happens.** `(i % 2 === 0 ? 1 : -1)` alternates every single sample rather
than describing a low-frequency tone.

**Suggested fix.** Generate a low-frequency sine at the same 1-LSB amplitude (for
example 50 Hz), which survives the reconstruction filter while staying ~90 dB below
anything audible.

---

### LOW — `envelope()` produces a click for any segment shorter than 24 ms

**File:** `scripts/generate-tones.mjs:52-59`

**What breaks.** For a segment shorter than `ATTACK_MS + RELEASE_MS` (24 ms), the
attack branch on line 55 matches for indices that also belong to the release window,
so the release branch on line 57 is never reached and the tone is cut at full
amplitude — an audible click. Shorter than 6 ms and the envelope never even reaches
1, so the cue is both quiet and clicky.

**Why it happens.** The two windows are tested independently with an early return,
with no check that they do not overlap and no scaling for short segments.

**Reachability.** Not reachable today — the shortest segment in `CUES` is the 110 ms
`tick`. It fires the first time anyone adds a short cue, which is likely in step 2.

**Suggested fix.** Clamp both windows to `total / 2` before use, e.g.
`const attack = Math.min(msToSamples(ATTACK_MS), Math.floor(total / 2))` and the same
for release.

---

### LOW — The drift stat reads green "+0 م.ث" before any measurement exists

**File:** `app/index.tsx:200-204`

**What breaks.** On a fresh launch, before a test has ever run, "أقصى انحراف" renders
`+0 م.ث` in the accent colour, because `Math.abs(0) > 150` is false. On a screen whose
only purpose is to tell the user whether background timing held, a green zero reads as
a passing result rather than as "no data".

**Why it happens.** `maxDriftMs` initialises to `0` (line 45) and the tone is derived
purely from its magnitude, with no separate "not measured yet" state.

**Suggested fix.** Initialise the drift states to `null` and render `—` with the
neutral tone until the first `onFire`.

---

### LOW — Dead exports and one unreferenced asset

**Files:** `src/audio/cues.ts:78-83`, `src/audio/keepAlive.ts:34-36`,
`src/timing/cueSchedule.ts:7`, `assets/splash-icon.png`

**What breaks.** Nothing at runtime, but each one implies behaviour that does not
exist. `setCueVolume` suggests the volume setting promised in the spec is wired up —
it has no caller. `isKeepAliveRunning` suggests something checks keep-alive health —
nothing does, which is precisely the gap behind the second High finding.
`ScheduledCue.label` is never read. `assets/splash-icon.png` is committed but
referenced nowhere in `app.json`, so the build currently ships Expo's default splash.

**Why it happens.** Scaffolding written ahead of its consumers, plus a template asset
copied in without the matching `expo-splash-screen` configuration.

**Suggested fix.** Delete the three unused symbols until a caller exists, and either
configure `expo-splash-screen` with `splash-icon.png` or drop the file.

---

### LOW — `eas.json` declares update channels the project cannot use, and `app.json`'s `buildNumber` is inert

**Files:** `eas.json:9`, `eas.json:17`, `app.json:26`

**What breaks.** Both build profiles set `"channel"`, which is an EAS Update concept,
but `expo-updates` is not a dependency (confirmed: no `node_modules/expo-updates`) and
no updates config exists in `app.json`. Separately, `eas.json:4` sets
`"appVersionSource": "remote"`, under which EAS manages the build number on its
servers and ignores `app.json`'s `"buildNumber": "1"` — a reader editing that field to
control the submitted build number will find it has no effect.

**Why it happens.** Both fields were written from the shape of a typical `eas.json`
rather than from this project's actual dependency set.

**Suggested fix.** Drop both `channel` keys until `expo-updates` is added, and remove
`ios.buildNumber` from `app.json` so the remote version source is the single source of
truth.

---

## 3. Needs verification (device or EAS required — do not treat as confirmed)

1. **Does the keep-alive actually keep JS timers alive with the screen locked?** The
   whole design rests on it and it cannot be tested without an iPhone. The number to
   watch is "في الخلفية" versus "الصافرات" on the lab screen.
2. **Severity of the seek race (Medium finding 3).** Whether an un-awaited
   `seekTo(0)` truly clips the first frames depends on AVPlayer behaviour in
   `expo-audio 57.0.4`. The design flaw — the pool not being used as designed — is
   confirmed by reading the code; the audible symptom is not.
3. **Does `eas build` warn or hard-fail on a `channel` with no `expo-updates`?** I
   could not run `eas-cli` here. The mismatch is confirmed; the consequence is not.
4. **Cue loudness at 20 m.** Untestable here, and the harmonic content in `PARTIALS`
   was chosen from speaker-efficiency reasoning, not measurement.
5. **Whether iOS reports `inactive` rather than `background` on screen lock in this
   configuration.** `app/index.tsx:106` counts anything `!== 'active'`, so the
   counter is correct either way, but the distinction matters for finding 2's fix.

---

## 4. Summary

**Overall health: good for what it is.** This is roughly 350 lines of first-milestone
code with no persistence, no network, and no third-party services, and it shows —
there are no security findings, no unvalidated input, no `JSON.parse` without a guard,
no duplicated listeners, and the timer and listener cleanup in `app/index.tsx` is
correct on every path I traced. Type checking is clean and the Metro bundle builds.

The defects that exist cluster in exactly one place: **what happens when iOS takes the
audio session away.** The code sets up the happy path carefully and has no answer for
the interrupted one — and the interrupted path is the normal path for a phone left on
the ground for 20 minutes.

**Fix these three first:**

1. **Interruption handling (High #2).** Nothing detects or recovers from a phone call
   or an OS-level audio interruption. Without it the app can go silent mid-test while
   still reporting success, which is worse than crashing.
2. **The catch-up burst (High #1).** Add a drop-if-late rule to `arm()`. This is a
   ~5-line change and it is much cheaper to make now than after the YYIR1 engine is
   built on top of this scheduler.
3. **Surface audio errors instead of swallowing them (Medium #4).** Until the two
   empty catch blocks report something, on-device test results cannot be trusted —
   including the results of testing fixes 1 and 2.

Fix 3 arguably belongs first, since it is what makes the other two verifiable on a
device you have and I do not.
