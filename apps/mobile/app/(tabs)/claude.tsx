import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C, FONT, MONO } from '../../src/theme';
import { Banner, Empty, HeaderLink, LargeTitle, Loading } from '../../src/components/ui';
import { SwipeRow } from '../../src/components/SwipeRow';
import { UNCONFIGURED_TEXT, useAssistant } from '../../src/state/assistant';
import { relTime } from '../../src/lib/util';
import type { AssistantSession } from '../../src/api/types';

export default function ClaudeScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const status = useAssistant((s) => s.status);
  const sessions = useAssistant((s) => s.sessions);
  const loading = useAssistant((s) => s.sessionsLoading);
  const error = useAssistant((s) => s.sessionsError);
  const loadStatus = useAssistant((s) => s.loadStatus);
  const loadSessions = useAssistant((s) => s.loadSessions);
  const deleteSession = useAssistant((s) => s.deleteSession);
  const [refreshing, setRefreshing] = useState(false);
  const [loadedOnce, setLoadedOnce] = useState(false);

  const load = useCallback(async () => {
    const st = await loadStatus();
    if (st?.configured !== false) await loadSessions();
    setLoadedOnce(true);
  }, [loadStatus, loadSessions]);

  useEffect(() => {
    void load();
  }, [load]);
  useFocusEffect(
    useCallback(() => {
      if (loadedOnce) void load();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [load]),
  );

  const unconfigured = status?.configured === false;
  const label = (x: AssistantSession) => x.title || x.lastText || '新对话';

  return (
    <View style={{ flex: 1, backgroundColor: C.paper, paddingTop: insets.top }}>
      <LargeTitle
        title="Claude"
        right={
          <View style={{ flexDirection: 'row', gap: 16 }}>
            <HeaderLink title="新对话" onPress={() => router.push('/chat/new')} testID="new-chat" />
            <HeaderLink title="设置" onPress={() => router.push('/settings')} />
          </View>
        }
      />
      {status?.model && !unconfigured ? <Text style={s.model}>{status.model}</Text> : null}
      {error && sessions.length > 0 ? <Banner text={error} tone="warn" /> : null}
      {unconfigured ? (
        <Empty text={UNCONFIGURED_TEXT} />
      ) : !loadedOnce && loading ? (
        <Loading />
      ) : (
        <FlatList
          data={sessions}
          keyExtractor={(x) => x.id}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                setRefreshing(true);
                void load().finally(() => setRefreshing(false));
              }}
              tintColor={C.ink3}
            />
          }
          ListEmptyComponent={<Empty text={error ?? '还没有对话。点右上角「新对话」开始。'} />}
          renderItem={({ item }) => (
            <SwipeRow onLeft={() => void deleteSession(item.id)} leftLabel="删除" leftColor={C.red}>
              <Pressable onPress={() => router.push(`/chat/${item.id}`)} style={({ pressed }) => [s.row, pressed && { backgroundColor: C.paper2 }]} testID={`session-${item.id}`}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={s.title} numberOfLines={1}>
                    {label(item)}
                  </Text>
                  {item.title && item.lastText ? (
                    <Text style={s.last} numberOfLines={1}>
                      {item.lastText}
                    </Text>
                  ) : null}
                </View>
                <Text style={s.time}>{relTime(item.updatedAt ?? item.createdAt)}</Text>
              </Pressable>
            </SwipeRow>
          )}
        />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  model: { fontSize: FONT.tiny, color: C.ink3, fontFamily: MONO, paddingHorizontal: 16, paddingBottom: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderColor: C.line, backgroundColor: C.paper, minHeight: 60 },
  title: { fontSize: FONT.body, fontWeight: '500', color: C.ink },
  last: { fontSize: FONT.tiny, color: C.ink2, marginTop: 2 },
  time: { fontSize: FONT.tiny, color: C.ink3, fontFamily: MONO },
});
