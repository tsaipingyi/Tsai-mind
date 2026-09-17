import { useEffect, useMemo, useState } from 'react';
import { DEFAULT_KEY_FIELDS } from '@tsai-mind/core';
import type { KeyField } from '@tsai-mind/core';
import { api, errorMessage } from '../api/client';
import type { AccountSettings, NotificationToggles, TokenSummary } from '../api/types';
import { useSession } from '../state/session';
import { toast } from '../state/toast';
import { FIELD_LABEL, relTime } from '../lib/util';
import { makeLock, rememberUnlocked, verifyLock } from '../lib/lock';
import { useLock } from '../state/lock';

const DEFAULT_NUDGE_TEMPLATE = '关于「{title}」，原定 {due}，现在进度 {progress}%，方便同步一下进展吗？';

const NOTIFICATIONS: { key: keyof NotificationToggles; label: string; hint: string }[] = [
  { key: 'dueSoon', label: '到期提醒', hint: '到期前 1 天和当天各推一条' },
  { key: 'overdue', label: '逾期汇总', hint: '每天 09:00 一条' },
  { key: 'nudgeDue', label: '该催了', hint: '逾期超过 3 天且 3 天没催' },
  { key: 'digest', label: '周摘要', hint: '周一 08:00' },
];

const KEY_FIELDS: KeyField[] = ['dueDate', 'startDate', 'ownerId', 'delete', 'status_done'];

const COMMON_TZ = ['Asia/Shanghai', 'Asia/Taipei', 'Asia/Hong_Kong', 'Asia/Tokyo', 'Asia/Singapore', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles', 'UTC'];

export function SettingsPage() {
  const account = useSession((s) => s.account);
  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState('');
  const [notif, setNotif] = useState<NotificationToggles>({});
  const [template, setTemplate] = useState('');
  const [keyFields, setKeyFields] = useState<KeyField[]>([...DEFAULT_KEY_FIELDS]);
  const [requireConfirmation, setRequireConfirmation] = useState(true);
  const [busy, setBusy] = useState(false);
  const [tokens, setTokens] = useState<TokenSummary[] | null>(null);
  const [tokenErr, setTokenErr] = useState<string | null>(null);
  const lockNow = useLock((s) => s.lockNow);
  const [pwCurrent, setPwCurrent] = useState('');
  const [pw1, setPw1] = useState('');
  const [pw2, setPw2] = useState('');
  const [lockBusy, setLockBusy] = useState(false);

  useEffect(() => {
    if (!account) return;
    const s = account.settings ?? {};
    setName(account.name ?? '');
    setTimezone(account.timezone ?? '');
    setNotif({ dueSoon: s.notifications?.dueSoon ?? true, overdue: s.notifications?.overdue ?? true, nudgeDue: s.notifications?.nudgeDue ?? true, digest: s.notifications?.digest ?? true });
    setTemplate(s.nudgeTemplate ?? '');
    setKeyFields(s.keyFields ? [...s.keyFields] : [...DEFAULT_KEY_FIELDS]);
    setRequireConfirmation(s.requireConfirmation ?? true);
  }, [account]);

  useEffect(() => {
    api
      .listTokens()
      .then((t) => setTokens(t.filter((x) => !x.revokedAt)))
      .catch((e) => setTokenErr(errorMessage(e)));
  }, []);

  const timezones = useMemo(() => {
    try {
      const all = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone');
      return all && all.length ? all : COMMON_TZ;
    } catch {
      return COMMON_TZ;
    }
  }, []);

  const save = async () => {
    if (!account) return;
    setBusy(true);
    const settings: AccountSettings = {
      ...account.settings,
      notifications: notif,
      nudgeTemplate: template.trim() || undefined,
      keyFields,
      requireConfirmation,
    };
    try {
      const r = await api.patchMe({ name: name.trim() || account.name, timezone: timezone.trim() || account.timezone, settings });
      const next = r?.account ?? { ...account, name: name.trim() || account.name, timezone: timezone.trim() || account.timezone, settings };
      useSession.setState({ account: next });
      toast('设置已保存', 'ok');
    } catch (e) {
      toast(`保存失败：${errorMessage(e)}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  /** writes (or clears) the page lock right away, separate from the main 保存 */
  const saveLock = async (pageLock: AccountSettings['pageLock']) => {
    if (!account) return;
    setLockBusy(true);
    const settings: AccountSettings = { ...account.settings, pageLock };
    try {
      const r = await api.patchMe({ settings });
      const next = r?.account ?? { ...account, settings };
      if (pageLock) rememberUnlocked(pageLock);
      useSession.setState({ account: next });
      setPwCurrent('');
      setPw1('');
      setPw2('');
      toast(pageLock ? '页面密码已开启' : '页面密码已取消', 'ok');
    } catch (e) {
      toast(`保存失败：${errorMessage(e)}`, 'error');
    } finally {
      setLockBusy(false);
    }
  };
  const enableLock = async () => {
    if (!pw1 || pw1 !== pw2) return;
    await saveLock(await makeLock(pw1));
  };
  const changeLock = async (remove: boolean) => {
    const cur = account?.settings?.pageLock;
    if (!cur) return;
    if (!(await verifyLock(cur, pwCurrent))) {
      toast('当前密码不对', 'error');
      return;
    }
    if (remove) await saveLock(null);
    else if (pw1 && pw1 === pw2) await saveLock(await makeLock(pw1));
  };

  const toggleKey = (k: KeyField) => setKeyFields(keyFields.includes(k) ? keyFields.filter((x) => x !== k) : [...keyFields, k]);

  if (!account) return <div className="page narrow faint">加载中…</div>;

  return (
    <div className="page narrow settings" data-testid="settings">
      <div className="row between" style={{ marginBottom: 20 }}>
        <h1 style={{ margin: 0 }}>设置</h1>
        <button className="btn primary" onClick={() => void save()} disabled={busy}>
          {busy ? '保存中…' : '保存'}
        </button>
      </div>

      <h2 style={{ marginTop: 0 }}>账户</h2>
      <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
        <label className="field" style={{ flex: 1 }}>
          <span>名字</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field" style={{ flex: 1 }}>
          <span>时区</span>
          <input className="input mono" list="tz-list" value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="Asia/Shanghai" />
          <datalist id="tz-list">
            {timezones.map((z) => (
              <option key={z} value={z} />
            ))}
          </datalist>
        </label>
      </div>
      <div className="faint" style={{ fontSize: 12 }}>
        {account.email} · 日期按这个时区算「今天」，提醒也按它推送。
      </div>

      <h2>通知</h2>
      <div className="settings-grid">
        {NOTIFICATIONS.map((n) => (
          <label key={n.key} className="settings-toggle">
            <input type="checkbox" checked={notif[n.key] !== false} onChange={(e) => setNotif({ ...notif, [n.key]: e.target.checked })} />
            <span>
              {n.label}
              <span className="faint"> · {n.hint}</span>
            </span>
          </label>
        ))}
      </div>
      <div className="faint" style={{ fontSize: 12, marginTop: 6 }}>
        Claude 提议改关键字段、草案生成、前置任务延误这三种通知不能关。
      </div>

      <h2>催办模板</h2>
      <textarea className="textarea" value={template} onChange={(e) => setTemplate(e.target.value)} placeholder={DEFAULT_NUDGE_TEMPLATE} aria-label="催办模板" />
      <div className="faint" style={{ fontSize: 12, marginTop: 4, lineHeight: 1.8 }}>
        占位符：<code className="mono">{'{title}'}</code> 任务标题 · <code className="mono">{'{due}'}</code> 截止日 · <code className="mono">{'{progress}'}</code> 进度百分比 · <code className="mono">{'{owner}'}</code> 负责人。留空用默认模板。
      </div>

      <h2>Claude 的改动</h2>
      <label className="settings-toggle" style={{ marginBottom: 10 }}>
        <input type="checkbox" checked={requireConfirmation} onChange={(e) => setRequireConfirmation(e.target.checked)} data-testid="require-confirmation" />
        <span>
          Claude 的关键字段改动需要确认
          <span className="faint"> · 关掉后 Claude 的所有改动直接生效（草案仍要确认）</span>
        </span>
      </label>
      <div className="field-label">关键字段</div>
      <div className="settings-grid" style={{ opacity: requireConfirmation ? 1 : 0.5 }}>
        {KEY_FIELDS.map((k) => (
          <label key={k} className="settings-toggle">
            <input type="checkbox" checked={keyFields.includes(k)} disabled={!requireConfirmation} onChange={() => toggleKey(k)} />
            <span>
              {FIELD_LABEL[k] ?? k} <span className="faint mono">{k}</span>
            </span>
          </label>
        ))}
      </div>

      <h2>页面密码</h2>
      <p className="faint" style={{ fontSize: 13, marginTop: 0 }}>
        开启后每次打开页面都要先输入密码；密码只以加盐哈希保存，改密码或取消都要先输入当前密码。
      </p>
      {account.settings?.pageLock ? (
        <div data-testid="page-lock">
          <div className="row" style={{ gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <label className="field" style={{ flex: 1, minWidth: 160 }}>
              <span>当前密码</span>
              <input className="input" type="password" autoComplete="current-password" value={pwCurrent} onChange={(e) => setPwCurrent(e.target.value)} aria-label="当前密码" />
            </label>
            <label className="field" style={{ flex: 1, minWidth: 160 }}>
              <span>新密码</span>
              <input className="input" type="password" autoComplete="new-password" value={pw1} onChange={(e) => setPw1(e.target.value)} aria-label="新密码" />
            </label>
            <label className="field" style={{ flex: 1, minWidth: 160 }}>
              <span>再输一次</span>
              <input className="input" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} aria-label="再输一次新密码" />
            </label>
          </div>
          {pw1 && pw2 && pw1 !== pw2 && <div className="red" style={{ fontSize: 13, marginBottom: 8 }}>两次输入的新密码不一样</div>}
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button className="btn primary" onClick={() => void changeLock(false)} disabled={lockBusy || !pwCurrent || !pw1 || pw1 !== pw2}>
              更改密码
            </button>
            <button className="btn" onClick={() => void changeLock(true)} disabled={lockBusy || !pwCurrent}>
              取消密码
            </button>
            <button className="btn" onClick={() => lockNow()} title="现在就锁上，再打开需要密码">
              立即锁定
            </button>
          </div>
        </div>
      ) : (
        <div data-testid="page-lock">
          <div className="row" style={{ gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <label className="field" style={{ flex: 1, minWidth: 160 }}>
              <span>密码</span>
              <input className="input" type="password" autoComplete="new-password" value={pw1} onChange={(e) => setPw1(e.target.value)} aria-label="页面密码" />
            </label>
            <label className="field" style={{ flex: 1, minWidth: 160 }}>
              <span>再输一次</span>
              <input className="input" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} aria-label="再输一次页面密码" />
            </label>
          </div>
          {pw1 && pw2 && pw1 !== pw2 && <div className="red" style={{ fontSize: 13, marginBottom: 8 }}>两次输入的密码不一样</div>}
          <button className="btn primary" onClick={() => void enableLock()} disabled={lockBusy || !pw1 || pw1 !== pw2}>
            开启页面密码
          </button>
        </div>
      )}

      <h2>访问令牌</h2>
      {tokenErr && <div className="red">{tokenErr}</div>}
      {tokens && !tokens.length && <div className="empty">还没有令牌。</div>}
      {tokens && tokens.length > 0 && (
        <table className="projects-table tokens-table">
          <thead>
            <tr>
              <th>标签</th>
              <th>类型</th>
              <th>客户端</th>
              <th>权限</th>
              <th>最近使用</th>
              <th>到期</th>
            </tr>
          </thead>
          <tbody>
            {tokens.map((t) => (
              <tr key={t.id}>
                <td style={{ fontWeight: 500 }}>
                  {t.label}
                  <div className="faint mono" style={{ fontSize: 11 }}>
                    {t.id}
                  </div>
                </td>
                <td className="mono">{t.kind}</td>
                <td>{t.clientName ?? <span className="faint">—</span>}</td>
                <td className="mono" style={{ fontSize: 12 }}>
                  {t.scopes.join(', ')}
                </td>
                <td className="mono" style={{ fontSize: 12 }}>
                  {t.lastUsedAt ? relTime(t.lastUsedAt) : <span className="faint">从未</span>}
                </td>
                <td className="mono" style={{ fontSize: 12 }}>
                  {t.expiresAt ? t.expiresAt.slice(0, 10) : <span className="faint">不过期</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="faint" style={{ fontSize: 12, marginTop: 8, lineHeight: 1.9 }}>
        令牌在服务器上用命令行管理：
        <pre className="mono cli-hint">
          {`pnpm --filter @tsai-mind/server token:create --label "Claude Code" --scopes read,write,decide
pnpm --filter @tsai-mind/server token:list
pnpm --filter @tsai-mind/server token:revoke <id>`}
        </pre>
        claude.ai 的自定义连接器走 OAuth，登录一次就会在这里出现一条 <code className="mono">oauth</code> 类型的令牌。
      </div>
    </div>
  );
}
