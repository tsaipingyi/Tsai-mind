/**
 * Outline export. In cloud mode the file goes through the artifact's `downloads` capability (the
 * viewer confirms the save); everywhere else — and when the capability is absent — it is a Blob link.
 *
 *   await exportOutline(projectId)          // resolves true when the file was handed over
 */
import { api, errorMessage } from '../api/client';
import { toast } from '../state/toast';
import { useCapability } from './capabilities';
import { isCloud } from './mode';

function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'outline';
}

export function blobDownload(filename: string, text: string, mime = 'text/markdown;charset=utf-8'): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  // keep the anchor (and its download name) alive until the browser has started the download
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 2000);
}

export async function exportOutline(projectId: string, projectName?: string): Promise<boolean> {
  let text: string;
  let name = projectName;
  try {
    text = await api.getOutline(projectId);
    if (!name) name = (await api.getProject(projectId)).project.name;
  } catch (e) {
    toast(`下载失败：${errorMessage(e)}`, 'error');
    return false;
  }
  const filename = `${safeName(name ?? '')}.md`;
  const downloads = isCloud ? await useCapability('downloads') : null;
  if (!downloads) {
    blobDownload(filename, text);
    return true;
  }
  try {
    await downloads.save({ filename, data: text });
    toast('大纲已导出', 'ok');
    return true;
  } catch (e) {
    const code = String((e as { code?: string } | undefined)?.code ?? 'unavailable');
    if (code === 'declined') return false;
    if (code === 'rate_limited') toast('上一个导出还没处理完，稍等一下再试', 'error');
    else if (code === 'unavailable' || code === 'not_granted' || code === 'capability_disabled' || code === 'capability_removed') toast('这个页面不能保存文件', 'error');
    else toast(`导出失败：${(e as Error | undefined)?.message ?? code}`, 'error');
    return false;
  }
}
