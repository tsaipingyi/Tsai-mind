import { Tabs } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { C, FONT, TAB_BAR } from '../../src/theme';
import { useInsets } from '../../src/components/layout';
import { ClaudeIcon, ProjectsIcon, TodayIcon } from '../../src/components/icons';

const TABS: Record<string, { title: string; Icon: (p: { color: string }) => React.ReactElement }> = {
  index: { title: '今天', Icon: TodayIcon },
  projects: { title: '项目', Icon: ProjectsIcon },
  claude: { title: 'Claude', Icon: ClaudeIcon },
};

interface TabBarProps {
  state: { index: number; routes: { key: string; name: string }[] };
  navigation: {
    emit: (e: { type: 'tabPress'; target: string; canPreventDefault: true }) => { defaultPrevented: boolean };
    navigate: (name: string) => void;
  };
}

/** The three-tab bar from the artboards: 83 high (49 + home indicator), 1px top line, 26px stroke icons, 11px labels, active orange. */
function TabBar({ state, navigation }: TabBarProps) {
  const { bottom } = useInsets();
  return (
    <View style={[s.bar, { height: TAB_BAR + bottom, paddingBottom: bottom }]}>
      {state.routes.map((route, i) => {
        const meta = TABS[route.name];
        if (!meta) return null;
        const focused = state.index === i;
        const color = focused ? C.orange : C.ink3;
        return (
          <Pressable
            key={route.key}
            accessibilityRole="tab"
            accessibilityState={{ selected: focused }}
            aria-selected={focused}
            accessibilityLabel={meta.title}
            testID={`tab-${route.name}`}
            onPress={() => {
              const ev = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
              if (!focused && !ev.defaultPrevented) navigation.navigate(route.name);
            }}
            style={s.item}
          >
            <meta.Icon color={color} />
            <Text style={[s.label, { color }]}>{meta.title}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export default function TabsLayout() {
  return (
    <Tabs tabBar={(props) => <TabBar {...(props as unknown as TabBarProps)} />} screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: C.paper } }}>
      <Tabs.Screen name="index" options={{ title: '今天' }} />
      <Tabs.Screen name="projects" options={{ title: '项目' }} />
      <Tabs.Screen name="claude" options={{ title: 'Claude' }} />
    </Tabs>
  );
}

const s = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'flex-start', borderTopWidth: 1, borderColor: C.line, backgroundColor: C.paper },
  item: { flexGrow: 1, flexBasis: 0, alignItems: 'center', gap: 4, paddingTop: 10 },
  label: { fontSize: FONT.tiny, lineHeight: 14 },
});
