import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C, FONT, MONO, RADIUS } from '../src/theme';
import { Btn } from '../src/components/ui';
import { useSession } from '../src/state/session';
import { DEFAULT_SERVER, errorMessage } from '../src/api/client';

export default function LoginScreen() {
  const insets = useSafeAreaInsets();
  const savedServer = useSession((s) => s.serverUrl);
  const login = useSession((s) => s.login);
  const [server, setServer] = useState(savedServer || DEFAULT_SERVER);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (savedServer) setServer(savedServer);
  }, [savedServer]);

  const paste = async () => {
    try {
      const Clipboard = await import('expo-clipboard');
      const t = await Clipboard.getStringAsync();
      if (t) setToken(t.trim());
    } catch {
      /* clipboard unavailable */
    }
  };

  const submit = async () => {
    if (!token.trim()) {
      setErr('请粘贴访问令牌');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await login(server, token);
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, backgroundColor: C.paper }}>
      <ScrollView contentContainerStyle={[s.wrap, { paddingTop: insets.top + 64, paddingBottom: insets.bottom + 24 }]} keyboardShouldPersistTaps="handled">
        <View style={s.logo}>
          <View style={s.logoBox} />
          <Text style={s.brand}>Tsai Mind</Text>
        </View>
        <Text style={s.lead}>登录你的服务器。令牌在网页版「设置 → 访问令牌」里生成。</Text>

        <Text style={s.label}>服务器地址</Text>
        <TextInput
          value={server}
          onChangeText={setServer}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          placeholder={DEFAULT_SERVER}
          placeholderTextColor={C.ink3}
          style={s.input}
          testID="login-server"
        />
        <Text style={s.hint}>本地开发：http://127.0.0.1:3000（真机请用电脑的局域网 IP）</Text>

        <Text style={s.label}>访问令牌</Text>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <TextInput
            value={token}
            onChangeText={setToken}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            placeholder="tm_…"
            placeholderTextColor={C.ink3}
            style={[s.input, { flex: 1, fontFamily: MONO }]}
            onSubmitEditing={() => void submit()}
            testID="login-token"
          />
          <Pressable onPress={() => void paste()} style={s.paste} accessibilityRole="button">
            <Text style={{ color: C.ink2, fontSize: FONT.small }}>粘贴</Text>
          </Pressable>
        </View>

        {err ? (
          <Text style={s.err} testID="login-error">
            {err}
          </Text>
        ) : null}
        <Btn title="登录" kind="primary" onPress={() => void submit()} busy={busy} style={{ marginTop: 20 }} testID="login-submit" />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  wrap: { paddingHorizontal: 24, gap: 6 },
  logo: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8 },
  logoBox: { width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: C.orange },
  brand: { fontSize: 26, fontWeight: '700', color: C.ink },
  lead: { fontSize: FONT.small, color: C.ink2, marginBottom: 20, lineHeight: 20 },
  label: { fontSize: FONT.tiny, color: C.ink2, fontWeight: '500', marginTop: 10 },
  input: { borderWidth: 1, borderColor: C.line, borderRadius: RADIUS, paddingHorizontal: 12, paddingVertical: 11, fontSize: FONT.body, color: C.ink, backgroundColor: C.paper },
  hint: { fontSize: FONT.tiny, color: C.ink3 },
  paste: { borderWidth: 1, borderColor: C.line, borderRadius: RADIUS, paddingHorizontal: 12, justifyContent: 'center' },
  err: { color: C.red, fontSize: FONT.small, marginTop: 8 },
});
