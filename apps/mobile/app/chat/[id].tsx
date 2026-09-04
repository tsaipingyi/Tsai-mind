import { useCallback, useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C, FONT } from '../../src/theme';
import { Banner, Empty, Loading } from '../../src/components/ui';
import { MessageBubble } from '../../src/components/Chat';
import { UNCONFIGURED_TEXT, useAssistant } from '../../src/state/assistant';
import { useProjects } from '../../src/state/project';
import { errorMessage } from '../../src/api/client';

/**
 * One conversation. `id` is a session id or `new`; `projectId` scopes the
 * conversation to a project (the「在项目 X 中」chip), `prefill` seeds the input.
 */
export default function ChatScreen() {
  const { id, projectId, prefill } = useLocalSearchParams<{ id: string; projectId?: string; prefill?: string }>();
  const insets = useSafeAreaInsets();
  const [sessionId, setSessionId] = useState<string | null>(id && id !== 'new' ? id : null);
  const [input, setInput] = useState(prefill ?? '');
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);
  const scrollRef = useRef<ScrollView>(null);

  const status = useAssistant((s) => s.status);
  const statusError = useAssistant((s) => s.statusError);
  const chat = useAssistant((s) => (sessionId ? s.chats[sessionId] : undefined));
  const loadStatus = useAssistant((s) => s.loadStatus);
  const openSession = useAssistant((s) => s.openSession);
  const createSession = useAssistant((s) => s.createSession);
  const send = useAssistant((s) => s.send);

  const projectName = useProjects((s) => (projectId ? s.projects[projectId]?.project?.name : undefined));
  const loadProject = useProjects((s) => s.load);

  useEffect(() => {
    if (!status) void loadStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (sessionId) void openSession(sessionId);
  }, [sessionId, openSession]);
  useEffect(() => {
    if (projectId && !projectName) void loadProject(projectId);
  }, [projectId, projectName, loadProject]);

  const scrollDown = useCallback(() => {
    scrollRef.current?.scrollToEnd({ animated: true });
  }, []);

  const submit = async () => {
    const text = input.trim();
    if (!text || chat?.sending || creating) return;
    let sid = sessionId;
    if (!sid) {
      setCreating(true);
      setCreateErr(null);
      try {
        sid = await createSession(projectId ? { projectId } : {});
        setSessionId(sid);
      } catch (e) {
        setCreateErr(errorMessage(e));
        setCreating(false);
        return;
      }
      setCreating(false);
    }
    setInput('');
    void send(sid, text, projectId);
  };

  const unconfigured = status?.configured === false;
  const title = chat?.session?.title || 'Claude';
  const canSend = !!input.trim() && !chat?.sending && !creating && !unconfigured;

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={insets.top + 44} style={{ flex: 1, backgroundColor: C.paper }}>
      <Stack.Screen options={{ title }} />
      {statusError && !status ? <Banner text={statusError} tone="warn" /> : null}
      {chat?.error ? <Banner text={chat.error} tone="warn" /> : null}
      {unconfigured ? (
        <View style={{ flex: 1 }}>
          <Empty text={UNCONFIGURED_TEXT} />
          <Text style={s.hint}>在服务器的环境变量里设置 ANTHROPIC_API_KEY 后重启，这里就能对话了。</Text>
        </View>
      ) : (
        <ScrollView ref={scrollRef} style={{ flex: 1 }} contentContainerStyle={{ paddingTop: 12, paddingBottom: 12 }} onContentSizeChange={scrollDown} keyboardShouldPersistTaps="handled" testID="chat-scroll">
          {chat?.loading && !chat.messages.length ? <Loading /> : null}
          {!chat?.loading && !chat?.messages.length ? (
            <Text style={s.hint}>{projectName ? `这个对话只看「${projectName}」。` : '问 Claude 任何关于你项目的事：安排、催办、拆任务。'}改关键字段会先进「待确认」。</Text>
          ) : null}
          {chat?.messages.map((m) => (
            <MessageBubble key={m.id} message={m} />
          ))}
        </ScrollView>
      )}
      <View style={[s.bar, { paddingBottom: Math.max(insets.bottom, 8) }]}>
        {projectId ? (
          <View style={s.scope} testID="chat-scope">
            <Text style={s.scopeText}>在项目 {projectName ?? '…'} 中</Text>
          </View>
        ) : null}
        {createErr ? <Text style={s.err}>{createErr}</Text> : null}
        <View style={s.inputRow}>
          <TextInput
            value={input}
            onChangeText={setInput}
            placeholder={unconfigured ? '服务器未配置' : '给 Claude 发消息'}
            placeholderTextColor={C.ink3}
            multiline
            editable={!unconfigured}
            style={s.input}
            testID="chat-input"
            blurOnSubmit={false}
          />
          <Pressable onPress={() => void submit()} disabled={!canSend} style={[s.send, !canSend && { backgroundColor: C.line }]} accessibilityRole="button" accessibilityLabel="发送" testID="chat-send">
            <Text style={s.sendText}>↑</Text>
          </Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  hint: { fontSize: FONT.small, color: C.ink3, paddingHorizontal: 20, paddingVertical: 12, lineHeight: 20 },
  bar: { borderTopWidth: 1, borderColor: C.line, paddingHorizontal: 12, paddingTop: 8, backgroundColor: C.paper, gap: 6 },
  scope: { alignSelf: 'flex-start', borderWidth: 1, borderColor: C.orangeLine, backgroundColor: C.orangeSoft, borderRadius: 99, paddingHorizontal: 10, paddingVertical: 3 },
  scopeText: { fontSize: FONT.tiny, color: C.orangeDeep },
  inputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  input: { flex: 1, minHeight: 40, maxHeight: 120, borderWidth: 1, borderColor: C.line, borderRadius: 20, paddingHorizontal: 14, paddingTop: 10, paddingBottom: 10, fontSize: FONT.body, color: C.ink, backgroundColor: C.paper },
  send: { width: 40, height: 40, borderRadius: 20, backgroundColor: C.orange, alignItems: 'center', justifyContent: 'center' },
  sendText: { color: '#fff', fontSize: 20, fontWeight: '700', lineHeight: 24 },
  err: { fontSize: FONT.tiny, color: C.red },
});
