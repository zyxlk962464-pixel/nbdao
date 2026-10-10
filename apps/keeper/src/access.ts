import type { Address } from 'viem';
import type { Runtime } from './config.js';

/** Local fixtures may use several owners; a live signer serves only its configured owner. */
export function assertOwnerAllowed(config: Runtime, owner: string) {
  if (!config.allowedOwner && config.app.mode !== 'live') return;
  if (!config.allowedOwner || owner.toLowerCase() !== config.allowedOwner.toLowerCase()) {
    throw new Error('此服务仅允许配置的持币钱包使用');
  }
}
export function assertTaskAllowed(config: Runtime, task: { owner: Address; params: { executor: Address } }) {
  assertOwnerAllowed(config, task.owner);
  if (!config.app.executor || task.params.executor.toLowerCase() !== config.app.executor.toLowerCase()) {
    throw new Error('任务执行者与服务配置不一致');
  }
}
