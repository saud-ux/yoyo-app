import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AppState,
  type AppStateStatus,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { playCue, type CueName } from '../src/audio/cues';
import { startKeepAlive, stopKeepAlive } from '../src/audio/keepAlive';
import { configureAudioSession } from '../src/audio/session';
import {
  buildIntervalSchedule,
  runCueSchedule,
  type CueSchedule,
} from '../src/timing/cueSchedule';
import { colors } from '../src/theme/colors';

const INTERVAL_MS = 5000;
const DURATION_CHOICES = [2, 5, 10] as const;

const CUE_LABELS: { cue: CueName; label: string; hint: string }[] = [
  { cue: 'beep', label: 'صافرة', hint: '880 هرتز · 150 مللي' },
  { cue: 'level', label: 'مستوى جديد', hint: '1320 هرتز · مزدوجة' },
  { cue: 'tick', label: 'عدّ', hint: '660 هرتز · 110 مللي' },
  { cue: 'end', label: 'نهاية', hint: 'نغمة هابطة · ثانية' },
];

type SessionState = 'configuring' | 'ready' | 'error';

export default function AudioLabScreen() {
  const [sessionState, setSessionState] = useState<SessionState>('configuring');
  const [sessionError, setSessionError] = useState<string | null>(null);

  const [running, setRunning] = useState(false);
  const [durationMin, setDurationMin] = useState<number>(5);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [fired, setFired] = useState(0);
  const [firedInBackground, setFiredInBackground] = useState(0);
  const [missed, setMissed] = useState(0);
  const [lastDriftMs, setLastDriftMs] = useState(0);
  const [maxDriftMs, setMaxDriftMs] = useState(0);

  const scheduleRef = useRef<CueSchedule | null>(null);
  const tickerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);

  useEffect(() => {
    let cancelled = false;
    configureAudioSession()
      .then(() => {
        if (!cancelled) setSessionState('ready');
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setSessionError(error instanceof Error ? error.message : String(error));
        setSessionState('error');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      appStateRef.current = next;
    });
    return () => subscription.remove();
  }, []);

  const stopTest = useCallback(() => {
    scheduleRef.current?.stop();
    scheduleRef.current = null;
    if (tickerRef.current) clearInterval(tickerRef.current);
    tickerRef.current = null;
    stopKeepAlive();
    setRunning(false);
  }, []);

  useEffect(() => stopTest, [stopTest]);

  const startTest = useCallback(() => {
    stopTest();

    setElapsedSec(0);
    setFired(0);
    setFiredInBackground(0);
    setMissed(0);
    setLastDriftMs(0);
    setMaxDriftMs(0);

    // Must be playing before the first gap, otherwise iOS can suspend the app
    // between cues and every pending timer stops with it.
    startKeepAlive();

    const totalMs = durationMin * 60_000;
    const schedule = runCueSchedule(
      buildIntervalSchedule('beep', INTERVAL_MS, totalMs),
      {
        onFire: ({ driftMs }) => {
          setFired((count) => count + 1);
          setLastDriftMs(driftMs);
          setMaxDriftMs((max) => (Math.abs(driftMs) > Math.abs(max) ? driftMs : max));
          if (appStateRef.current !== 'active') {
            setFiredInBackground((count) => count + 1);
          }
        },
        onMissed: () => {
          setMissed((count) => count + 1);
        },
        onFinish: () => {
          playCue('end');
          stopTest();
        },
      },
    );
    scheduleRef.current = schedule;

    tickerRef.current = setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - schedule.startedAt) / 1000));
    }, 500);

    setRunning(true);
  }, [durationMin, stopTest]);

  const ready = sessionState === 'ready';

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>مختبر الصوت</Text>
        <Text style={styles.subtitle}>
          تأكّد أن الصافرات تُسمع والشاشة مقفلة ومفتاح الصامت مفعّل
        </Text>

        <View style={[styles.card, !ready && styles.cardWarn]}>
          <Text style={styles.cardLabel}>حالة جلسة الصوت</Text>
          <Text style={[styles.cardValue, !ready && styles.cardValueWarn]}>
            {sessionState === 'configuring' && 'جارٍ التهيئة…'}
            {sessionState === 'ready' && 'مهيّأة: تعمل مع الصامت وفي الخلفية'}
            {sessionState === 'error' && `فشلت التهيئة: ${sessionError ?? ''}`}
          </Text>
        </View>

        <Text style={styles.section}>تجربة الصافرات</Text>
        <View style={styles.grid}>
          {CUE_LABELS.map(({ cue, label, hint }) => (
            <Pressable
              key={cue}
              disabled={!ready}
              onPress={() => playCue(cue)}
              style={({ pressed }) => [
                styles.cueButton,
                pressed && styles.pressed,
                !ready && styles.disabled,
              ]}
            >
              <Text style={styles.cueLabel}>{label}</Text>
              <Text style={styles.cueHint}>{hint}</Text>
            </Pressable>
          ))}
        </View>

        <Text style={styles.section}>اختبار الخلفية</Text>
        <Text style={styles.paragraph}>
          صافرة كل 5 ثوانٍ. شغّله، أقفل الشاشة، ضع الجوال على الأرض، وابتعد 20
          مترًا. عند العودة راجع عدد الصافرات والانحراف.
        </Text>

        <View style={styles.durationRow}>
          {DURATION_CHOICES.map((minutes) => (
            <Pressable
              key={minutes}
              disabled={running}
              onPress={() => setDurationMin(minutes)}
              style={({ pressed }) => [
                styles.durationChip,
                durationMin === minutes && styles.durationChipActive,
                pressed && styles.pressed,
                running && styles.disabled,
              ]}
            >
              <Text
                style={[
                  styles.durationText,
                  durationMin === minutes && styles.durationTextActive,
                ]}
              >
                {minutes} دقائق
              </Text>
            </Pressable>
          ))}
        </View>

        <View style={styles.statsRow}>
          <Stat label="الزمن" value={formatClock(elapsedSec)} />
          <Stat label="الصافرات" value={String(fired)} />
        </View>
        <View style={styles.statsRow}>
          <Stat label="في الخلفية" value={String(firedInBackground)} />
          <Stat
            label="متجاوَزة"
            value={String(missed)}
            tone={missed > 0 ? 'bad' : 'neutral'}
          />
        </View>
        <View style={styles.statsRow}>
          <Stat
            label="أقصى انحراف"
            value={`${maxDriftMs >= 0 ? '+' : ''}${maxDriftMs} م.ث`}
            tone={Math.abs(maxDriftMs) > 150 ? 'bad' : 'good'}
          />
        </View>
        <Text style={styles.footnote}>
          آخر انحراف: {lastDriftMs >= 0 ? '+' : ''}
          {lastDriftMs} مللي ثانية
        </Text>

        <Pressable
          disabled={!ready}
          onPress={running ? stopTest : startTest}
          style={({ pressed }) => [
            styles.bigButton,
            running ? styles.bigButtonStop : styles.bigButtonStart,
            pressed && styles.pressed,
            !ready && styles.disabled,
          ]}
        >
          <Text style={styles.bigButtonText}>{running ? 'إيقاف' : 'ابدأ الاختبار'}</Text>
        </Pressable>

        <Text style={styles.footnote}>
          لا يوجد أي اتصال بالإنترنت في هذه الشاشة. كل الأصوات مولّدة برمجيًا
          ومضمّنة في التطبيق.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function Stat({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  tone?: 'neutral' | 'good' | 'bad';
}) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text
        style={[
          styles.statValue,
          tone === 'good' && styles.statGood,
          tone === 'bad' && styles.statBad,
        ]}
      >
        {value}
      </Text>
    </View>
  );
}

function formatClock(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  content: { padding: 20, paddingBottom: 48, gap: 12 },
  title: {
    color: colors.text,
    fontSize: 34,
    fontWeight: '800',
    textAlign: 'center',
    writingDirection: 'rtl',
  },
  subtitle: {
    color: colors.textMuted,
    fontSize: 16,
    textAlign: 'center',
    lineHeight: 24,
    writingDirection: 'rtl',
  },
  section: {
    color: colors.text,
    fontSize: 20,
    fontWeight: '700',
    marginTop: 16,
    textAlign: 'center',
    writingDirection: 'rtl',
  },
  paragraph: {
    color: colors.textMuted,
    fontSize: 15,
    lineHeight: 24,
    textAlign: 'center',
    writingDirection: 'rtl',
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 16,
    gap: 6,
  },
  cardWarn: { borderColor: colors.warning },
  cardLabel: {
    color: colors.textMuted,
    fontSize: 14,
    textAlign: 'center',
    writingDirection: 'rtl',
  },
  cardValue: {
    color: colors.accent,
    fontSize: 16,
    fontWeight: '700',
    textAlign: 'center',
    writingDirection: 'rtl',
  },
  cardValueWarn: { color: colors.warning },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  cueButton: {
    flexGrow: 1,
    flexBasis: '45%',
    backgroundColor: colors.surfaceAlt,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 22,
    alignItems: 'center',
    gap: 4,
  },
  cueLabel: { color: colors.text, fontSize: 20, fontWeight: '700' },
  cueHint: { color: colors.textMuted, fontSize: 12 },
  durationRow: { flexDirection: 'row', gap: 10 },
  durationChip: {
    flex: 1,
    backgroundColor: colors.surfaceAlt,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 14,
    alignItems: 'center',
  },
  durationChipActive: { backgroundColor: colors.accentDark, borderColor: colors.accent },
  durationText: { color: colors.textMuted, fontSize: 16, fontWeight: '600' },
  durationTextActive: { color: colors.text },
  statsRow: { flexDirection: 'row', gap: 12 },
  stat: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 14,
    alignItems: 'center',
    gap: 4,
  },
  statLabel: { color: colors.textMuted, fontSize: 13 },
  statValue: { color: colors.text, fontSize: 26, fontWeight: '800' },
  statGood: { color: colors.accent },
  statBad: { color: colors.danger },
  bigButton: {
    marginTop: 12,
    borderRadius: 24,
    paddingVertical: 34,
    alignItems: 'center',
  },
  bigButtonStart: { backgroundColor: colors.accentDark },
  bigButtonStop: { backgroundColor: colors.danger },
  bigButtonText: { color: colors.text, fontSize: 30, fontWeight: '800' },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.4 },
  footnote: {
    color: colors.textMuted,
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 22,
    writingDirection: 'rtl',
  },
});
