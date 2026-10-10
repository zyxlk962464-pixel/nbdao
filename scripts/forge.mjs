import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
const local = resolve('.tools/forge');
const r = spawnSync(existsSync(local) ? local : 'forge', process.argv.slice(2), { cwd: resolve('packages/contracts'), stdio: 'inherit' });
if (r.error) console.error('安装 Foundry 后重试，或将 forge 放入 .tools/：', r.error.message);
process.exit(r.status ?? 1);
