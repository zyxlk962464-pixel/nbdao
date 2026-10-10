/** Public display reads cannot consume unbounded RPC slots. Execution never uses this cache. */
export class ReadGate {
  private active = 0;
  private entries = new Map<string, { result: Promise<unknown>; expires: number }>();
  async run<T>(key: string, read: () => Promise<T>): Promise<T> {
    const now = Date.now(), previous = this.entries.get(key);
    if (previous && previous.expires > now) return previous.result as Promise<T>;
    for (const [name, entry] of this.entries) if (entry.expires <= now) this.entries.delete(name);
    if (this.active >= 4 || this.entries.size >= 128) throw new Error('查询繁忙，请稍后重试；后台监控仍独立运行');
    this.active++;
    const entry = { result: Promise.resolve().then(read) as Promise<unknown>, expires: Infinity };
    this.entries.set(key, entry);
    try { const result = await entry.result; entry.expires = Date.now() + 250; return result as T; }
    catch (error) { this.entries.delete(key); throw error; }
    finally { this.active--; }
  }
}
