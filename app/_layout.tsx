import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';

import { loadCues, releaseCues } from '../src/audio/cues';
import { releaseKeepAlive } from '../src/audio/keepAlive';
import { colors } from '../src/theme/colors';

export default function RootLayout() {
  useEffect(() => {
    loadCues();
    return () => {
      releaseKeepAlive();
      releaseCues();
    };
  }, []);

  return (
    <>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.background },
        }}
      />
    </>
  );
}
