/** Every account/network transition gets an epoch, including A → B → A. */
export class WalletSession {
  private key: string | undefined;
  generation = 0;
  update(key: string) {
    if (key !== this.key) { this.key = key; this.generation++; }
    return this.generation;
  }
  isCurrent(generation: number) { return generation === this.generation; }
}
/** A wallet request holds this gate until it settles, even when the session changes. */
export class OperationGate {
  private current: symbol | null = null;
  acquire() { if (this.current) return null; return this.current = Symbol('wallet-operation'); }
  release(token: symbol) { if (this.current === token) this.current = null; }
  get busy() { return this.current !== null; }
}
/** Latest-started read wins; older RPC responses cannot replace newer state. */
export class LatestRead {
  private sequence = 0;
  start() { return ++this.sequence; }
  isCurrent(sequence: number) { return sequence === this.sequence; }
}
