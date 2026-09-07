import { playCue, type CueName } from '../audio/cues';

export type ScheduledCue = {
  /** Milliseconds after the schedule starts. */
  atMs: number;
  cue: CueName;
  label?: string;
};

export type CueFired = {
  item: ScheduledCue;
  index: number;
  /** Positive = fired late, in milliseconds. */
  driftMs: number;
};

export type CueSchedule = {
  startedAt: number;
  stop: () => void;
};

/** Below this we stop chaining timers and just wait out the remainder. */
const HANDOVER_MS = 20;
/** Wake this early so the final timer lands on, not after, the target. */
const GUARD_MS = 12;

/**
 * Fires cues against absolute wall-clock targets.
 *
 * A chain of `setTimeout(interval)` accumulates every timer's lateness — after
 * 20 minutes of shuttles that is seconds of error, which invalidates the test.
 * Here every cue is aimed at `startedAt + atMs`, so a late timer costs that one
 * cue and nothing after it.
 */
export function runCueSchedule(
  items: ScheduledCue[],
  handlers: { onFire?: (fired: CueFired) => void; onFinish?: () => void } = {},
): CueSchedule {
  const queue = [...items].sort((a, b) => a.atMs - b.atMs);
  const startedAt = Date.now();
  let index = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const arm = () => {
    if (stopped) return;
    if (index >= queue.length) {
      handlers.onFinish?.();
      return;
    }

    const item = queue[index];
    const target = startedAt + item.atMs;
    const remaining = target - Date.now();

    if (remaining > HANDOVER_MS) {
      timer = setTimeout(arm, remaining - GUARD_MS);
      return;
    }
    if (remaining > 1) {
      timer = setTimeout(arm, remaining);
      return;
    }

    playCue(item.cue);
    handlers.onFire?.({ item, index, driftMs: Date.now() - target });
    index += 1;
    arm();
  };

  arm();

  return {
    startedAt,
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

/** Evenly spaced cues, used by the background-audio test. */
export function buildIntervalSchedule(
  cue: CueName,
  intervalMs: number,
  totalMs: number,
): ScheduledCue[] {
  const items: ScheduledCue[] = [];
  for (let atMs = intervalMs; atMs <= totalMs; atMs += intervalMs) {
    items.push({ atMs, cue });
  }
  return items;
}
