export function walletError(error: unknown, fallback = '钱包操作失败，请重试或在钱包中检查请求。') {
  const texts: string[] = [];
  const codes: number[] = [];
  let value = error as { code?: number; name?: string; message?: string; shortMessage?: string; cause?: unknown; data?: { originalError?: { code?: number } } } | undefined;
  for (let i = 0; value && i < 8; i++) {
    texts.push(value.name || '', value.shortMessage || '', value.message || '');
    const code = value.code ?? value.data?.originalError?.code;
    if (code !== undefined) codes.push(code);
    value = value.cause as typeof value;
  }
  const text = texts.join(' ');
  if (texts.includes('User rejected switch after adding network.')) return '网络已添加但尚未切换，请再次点击切换网络，或在钱包中手动选择目标网络。';
  for (const code of codes) {
    if (code === 4001) return '已取消钱包请求，可重新连接或重试。';
    if (code === -32002) return '钱包已有待处理请求，请先打开钱包处理后再重试。';
    if (code === 4900 || code === 4901) return '钱包连接已断开，请重新连接。';
    if (code === 4100) return '钱包尚未授权此网站，请在钱包中允许连接。';
  }
  if (/rejected|denied|cancelled|canceled/i.test(text)) return '已取消钱包请求，可重新连接或重试。';
  if (/ProviderNotFound|provider.*not.*found/i.test(text)) return '未检测到浏览器钱包，请在已安装钱包的浏览器打开。';
  if (/already.*pending|RequestAlreadyPending/i.test(text)) return '钱包已有待处理请求，请先打开钱包处理后再重试。';
  if (/timeout|timed out/i.test(text)) return '钱包响应超时，请检查钱包连接后重试。';
  if (/SwitchChainNotSupported/i.test(text)) return '此钱包不支持自动切换，请在钱包中手动选择目标网络。';
  return fallback;
}
