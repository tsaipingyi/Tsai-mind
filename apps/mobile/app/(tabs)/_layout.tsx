import { Tabs } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import { C } from '../../src/theme';
import { pendingCount, usePending } from '../../src/state/pending';

function TodayIcon({ color }: { color: string }) {
  return (
    <Svg width={24} height={24} viewBox="0 0 24 24" fill="none">
      <Rect x={3} y={5} width={18} height={16} rx={3} stroke={color} strokeWidth={1.8} />
      <Path d="M3 10h18M8 3v4M16 3v4" stroke={color} strokeWidth={1.8} strokeLinecap="round" />
      <Circle cx={12} cy={15.5} r={1.6} fill={color} />
    </Svg>
  );
}

function PendingIcon({ color }: { color: string }) {
  return (
    <Svg width={24} height={24} viewBox="0 0 24 24" fill="none">
      <Rect x={3.5} y={3.5} width={17} height={17} rx={4} stroke={color} strokeWidth={1.8} />
      <Path d="M8 12.5l2.6 2.6L16.5 9" stroke={color} strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

function ProjectsIcon({ color }: { color: string }) {
  return (
    <Svg width={24} height={24} viewBox="0 0 24 24" fill="none">
      <Rect x={2.5} y={9} width={7} height={6} rx={2} stroke={color} strokeWidth={1.8} />
      <Rect x={14.5} y={3.5} width={7} height={6} rx={2} stroke={color} strokeWidth={1.8} />
      <Rect x={14.5} y={14.5} width={7} height={6} rx={2} stroke={color} strokeWidth={1.8} />
      <Path d="M9.5 12h2.5c1 0 1.5-.5 1.5-1.5V6.5h1M12 12h1.5c1 0 1.5.5 1.5 1.5v4h-.5" stroke={color} strokeWidth={1.6} strokeLinecap="round" />
    </Svg>
  );
}

function ClaudeIcon({ color }: { color: string }) {
  return (
    <Svg width={24} height={24} viewBox="0 0 24 24" fill="none">
      <Path d="M4 6.5A3.5 3.5 0 0 1 7.5 3h9A3.5 3.5 0 0 1 20 6.5v6a3.5 3.5 0 0 1-3.5 3.5H10l-4.2 3.6c-.5.4-1.3.1-1.3-.6V16A3.5 3.5 0 0 1 4 12.5v-6Z" stroke={color} strokeWidth={1.8} strokeLinejoin="round" />
      <Circle cx={9} cy={9.7} r={1.1} fill={color} />
      <Circle cx={12} cy={9.7} r={1.1} fill={color} />
      <Circle cx={15} cy={9.7} r={1.1} fill={color} />
    </Svg>
  );
}

export default function TabsLayout() {
  const badge = usePending(pendingCount);
  const insets = useSafeAreaInsets();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: C.orange,
        tabBarInactiveTintColor: C.ink2,
        tabBarStyle: { backgroundColor: C.paper, borderTopColor: C.line, borderTopWidth: 1, height: 54 + insets.bottom, paddingTop: 4, paddingBottom: insets.bottom },
        tabBarLabelStyle: { fontSize: 11, fontWeight: '500', lineHeight: 16 },
        sceneStyle: { backgroundColor: C.paper },
      }}
    >
      <Tabs.Screen name="index" options={{ title: '今天', tabBarIcon: ({ color }) => <TodayIcon color={String(color)} /> }} />
      <Tabs.Screen
        name="pending"
        options={{
          title: '待确认',
          tabBarIcon: ({ color }) => <PendingIcon color={String(color)} />,
          tabBarBadge: badge > 0 ? badge : undefined,
          tabBarBadgeStyle: { backgroundColor: C.orange, color: '#fff', fontSize: 11 },
        }}
      />
      <Tabs.Screen name="projects" options={{ title: '项目', tabBarIcon: ({ color }) => <ProjectsIcon color={String(color)} /> }} />
      <Tabs.Screen name="claude" options={{ title: 'Claude', tabBarIcon: ({ color }) => <ClaudeIcon color={String(color)} /> }} />
    </Tabs>
  );
}
