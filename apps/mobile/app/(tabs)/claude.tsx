import { useCallback, useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import { C, FONT, PAGE_PAD } from '../../src/theme';
import { useInsets } from '../../src/components/layout';
import { Empty, HeaderLink, Loading } from '../../src/components/ui';
import { ArrowUpIcon, ChevronDownIcon } from '../../src/components/icons';
import { MessageBubble } from '../../src/components/Chat';
import { SwipeRow } from '../../src/components/SwipeRow';
import { UNCONFIGURED_TEXT, useAssistant } from '../../src/state/assistant';
import { useProjects } from '../../src/state/project';
import { errorMessage } from '../../src/api/client';
import { relTime } from '../../src/lib/util';
import type { AssistantSession } from '../../src/api/types';

/**
 * Claude tab (design/mobile-v2/Claude.dc.html): opens straight into the latest conversation
 * (or a new one). `?projectId=&prefill=&t=` from 问 Claude starts a new conversation scoped to that project;
 * the session list is the「历史」sheet behind the title.
 */
export default function ClaudeScreen() {
  const params = useLocalSearchParams<{ projectId?: string; prefill?: string; t?: string }>();
  const { top } = useInsets();
  const [conv, setConv] = useState<{ sessionId: string | null; fresh: boolean; scope?: string }>({ sessionId: null, fresh: false });
  const [input, setInput] = useState('');
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [ready, setReady] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const seenT = useRef<string | undefined>(undefined);

  const status = useAssistant((s) => s.status);
  const statusError = useAssistant((s) => s.statusError);
  const sessions = useAssistant((s) => s.sessions);
  const sessionsError = useAssistant((s) => s.sessionsError);
  const chat = useAssistant((s) => (conv.sessionId ? s.chats[conv.sessionId] : undefined));
  const loadStatus = useAssistant((s) => s.loadStatus);
  const loadSessions = useAssistant((s) => s.loadSessions);
  const openSession = useAssistant((s) => s.openSession);
  const createSession = useAssistant((s) => s.createSession);
  const deleteSession = useAssistant((s) => s.deleteSession);
  const send = useAssistant((s) => s.send);

  const scopeId = chat?.session?.projectId ?? conv.scope;
  const scopeName = useProjects((s) => (scopeId ? s.projects[scopeId]?.project?.name : undefined));
  const loadProject = useProjects((s) => s.load);

  const boot = useCallback(async () => {
    const st = await loadStatus();
    if (st?.configured !== false) await loadSessions();
    setReady(true);
  }, [loadStatus, loadSessions]);
  useEffect(() => {
    void boot();
  }, [boot]);
  useFocusEffect(
    useCallback(() => {
      if (ready) void loadSessions();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ready]),
  );

  // 问 Claude from a project / node: a new conversation scoped to that project, input prefilled
  useEffect(() => {
    if (!params.t || params.t === seenT.current) return;
    seenT.current = params.t;
    setConv({ sessionId: null, fresh: true, scope: params.projectId || undefined });
    setInput(params.prefill ?? '');
    setHistoryOpen(false);
  }, [params.t, params.projectId, params.prefill]);

  // default: the latest conversation
  useEffect(() => {
    if (ready && !conv.fresh && !conv.sessionId && sessions.length) setConv({ sessionId: sessions[0]!.id, fresh: false });
  }, [ready, conv, sessions]);

  useEffect(() => {
    if (conv.sessionId) void openSession(conv.sessionId);
  }, [conv.sessionId, openSession]);
  useEffect(() => {
    if (scopeId && !scopeName) void loadProject(scopeId);
  }, [scopeId, scopeName, loadProject]);

  const scrollDown = useCallback(() => {
    scrollRef.current?.scrollToEnd({ animated: true });
  }, []);

  const submit = async () => {
    const text = input.trim();
    if (!text || chat?.sending || creating) return;
    let sid = conv.sessionId;
    if (!sid) {
      setCreating(true);
      setCreateErr(null);
      try {
        sid = await createSession(conv.scope ? { projectId: conv.scope } : {});
        setConv({ sessionId: sid, fresh: false, scope: conv.scope });
      } catch (e) {
        setCreateErr(errorMessage(e));
        setCreating(false);
        return;
      }
      setCreating(false);
    }
    setInput('');
    void send(sid, text, conv.scope);
  };

  const newChat = () => {
    setConv({ sessionId: null, fresh: true });
    setInput('');
    setHistoryOpen(false);
  };
  const pick = (id: string) => {
    setConv({ sessionId: id, fresh: false });
    setHistoryOpen(false);
  };

  const unconfigured = status?.configured === false;
  const canSend = !!input.trim() && !chat?.sending && !creating && !unconfigured;
  const label = (x: AssistantSession) => x.title || x.lastText || '新对话';
  const empty = !chat?.loading && !chat?.messages.length;

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, backgroundColor: C.paper }}>
      <View style={{ flex: 1, paddingTop: top + 17, paddingHorizontal: PAGE_PAD, gap: 16 }}>
        <View style={s.head}>
          <Pressable onPress={() => setHistoryOpen(true)} hitSlop={8} accessibilityRole="button" accessibilityLabel="历史对话" style={s.titleRow} testID="chat-history">
            <Text style={s.h1} accessibilityRole="header">
              Claude
            </Text>
            <ChevronDownIcon color={C.ink3} />
          </Pressable>
          <HeaderLink title="新对话" tone="orange" onPress={newChat} testID="new-chat" />
        </View>
        {scopeId ? (
          <View style={s.chip} testID="chat-scope">
            <Text style={s.chipText} numberOfLines={1}>
              {scopeName ?? '…'}
            </Text>
          </View>
        ) : null}
        {statusError && !status ? <Text style={s.err}>{statusError}</Text> : null}
        {chat?.error ? <Text style={s.err}>{chat.error}</Text> : null}
        {createErr ? <Text style={s.err}>{createErr}</Text> : null}

        {unconfigured ? (
          <View style={{ flex: 1 }}>
            <Empty text={UNCONFIGURED_TEXT} />
            <Text style={s.hint}>在服务器的环境变量里设置 ANTHROPIC_API_KEY 后重启，这里就能对话了。</Text>
          </View>
        ) : (
          <ScrollView ref={scrollRef} style={{ flex: 1 }} contentContainerStyle={{ gap: 14, paddingBottom: 8 }} onContentSizeChange={scrollDown} keyboardShouldPersistTaps="handled" testID="chat-scroll">
            {!ready || (chat?.loading && !chat.messages.length) ? <Loading /> : null}
            {ready && empty ? <Text style={s.hint}>{scopeName ? `这个对话只看「${scopeName}」。` : '问 Claude 任何关于你项目的事：安排、催办、拆任务。'}改关键字段会先进「待确认」。</Text> : null}
            {chat?.messages.map((m) => (
              <MessageBubble key={m.id} message={m} />
            ))}
          </ScrollView>
        )}

        <View style={s.inputRow}>
          <TextInput
            value={input}
            onChangeText={setInput}
            placeholder={unconfigured ? '服务器未配置' : '说点什么'}
            placeholderTextColor={C.ink3}
            multiline
            editable={!unconfigured}
            style={s.input}
            testID="chat-input"
            blurOnSubmit={false}
          />
          <Pressable onPress={() => void submit()} disabled={!canSend} style={[s.send, !canSend && { opacity: 0.5 }]} accessibilityRole="button" accessibilityLabel="发送" testID="chat-send">
            <ArrowUpIcon />
          </Pressable>
        </View>
      </View>

      <Modal visible={historyOpen} transparent animationType="fade" onRequestClose={() => setHistoryOpen(false)}>
        <Pressable style={s.backdrop} onPress={() => setHistoryOpen(false)}>
          <View style={s.sheet}>
            <View style={s.sheetHead}>
              <Text style={s.sheetTitle}>历史</Text>
              <HeaderLink title="新对话" tone="orange" onPress={newChat} testID="history-new-chat" />
            </View>
            {sessionsError && !sessions.length ? <Text style={[s.err, { paddingHorizontal: PAGE_PAD }]}>{sessionsError}</Text> : null}
            <ScrollView style={{ maxHeight: 420 }}>
              {sessions.length ? (
                sessions.map((item) => (
                  <SwipeRow key={item.id} onLeft={() => void deleteSession(item.id)} leftLabel="删除" leftColor={C.red}>
                    <Pressable onPress={() => pick(item.id)} style={({ pressed }) => [s.row, pressed && { backgroundColor: C.paper2 }]} testID={`session-${item.id}`}>
                      <View style={{ flexGrow: 1, flexShrink: 1, minWidth: 0, gap: 2 }}>
                        <Text style={[s.rowTitle, item.id === conv.sessionId && { color: C.orangeDeep }]} numberOfLines={1}>
                          {label(item)}
                        </Text>
                        {item.title && item.lastText ? (
                          <Text style={s.rowLast} numberOfLines={1}>
                            {item.lastText}
                          </Text>
                        ) : null}
                      </View>
                      <Text style={s.rowTime}>{relTime(item.updatedAt ?? item.createdAt)}</Text>
                    </Pressable>
                  </SwipeRow>
                ))
              ) : (
                <View style={{ paddingHorizontal: PAGE_PAD }}>
                  <Empty text="还没有对话。" />
                </View>
              )}
            </ScrollView>
          </View>
        </Pressable>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  h1: { fontSize: FONT.large, fontWeight: '700', color: C.ink, letterSpacing: -0.3, lineHeight: 41 },
  chip: { alignSelf: 'flex-start', borderWidth: 1, borderColor: C.orangeLine, borderRadius: 999, paddingVertical: 4, paddingHorizontal: 10 },
  chipText: { fontSize: FONT.small, color: C.orangeDeep },
  hint: { fontSize: FONT.small, color: C.ink3, lineHeight: 20 },
  err: { fontSize: FONT.small, color: C.red },
  inputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 10, paddingBottom: 16 },
  input: { flexGrow: 1, flexShrink: 1, minHeight: 44, maxHeight: 120, borderWidth: 1, borderColor: C.line, borderRadius: 22, paddingHorizontal: 16, paddingTop: 11, paddingBottom: 11, fontSize: FONT.input, lineHeight: 20, color: C.ink, backgroundColor: C.paper },
  send: { width: 44, height: 44, borderRadius: 22, backgroundColor: C.orange, alignItems: 'center', justifyContent: 'center' },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.25)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: C.paper, borderTopLeftRadius: 14, borderTopRightRadius: 14, paddingBottom: 32, paddingTop: 8 },
  sheetHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: PAGE_PAD, paddingVertical: 10 },
  sheetTitle: { fontSize: FONT.small, color: C.ink2 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: PAGE_PAD, minHeight: 56, paddingVertical: 8, borderTopWidth: 1, borderColor: C.line, backgroundColor: C.paper },
  rowTitle: { fontSize: FONT.body, fontWeight: '500', color: C.ink },
  rowLast: { fontSize: FONT.small, color: C.ink2 },
  rowTime: { fontSize: FONT.small, color: C.ink3 },
});
