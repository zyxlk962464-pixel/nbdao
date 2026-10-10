import type { NextConfig } from 'next';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

// Only this allowlist can cross from the repository's .env into the browser bundle.
// Never load or spread the keeper/deployer environment into Next config.env.
const allowed = ['NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID', 'NEXT_PUBLIC_APP_URL', 'NEXT_PUBLIC_BSC_RPC_URL', 'NEXT_PUBLIC_LOCAL_RPC_URL'] as const;
const publicEnv: Record<string, string> = {};
for (const key of allowed) if (process.env[key] !== undefined) publicEnv[key] = process.env[key]!;
const mode = process.env.NODE_ENV || 'production';
const files = [`.env.${mode}.local`, ...(mode === 'test' ? [] : ['.env.local']), `.env.${mode}`, '.env'];
for (const file of files) {
  let parsed: Record<string, string | undefined>;
  try { parsed = parseEnv(readFileSync(resolve(process.cwd(), '../..', file), 'utf8')); } catch { continue; }
  for (const key of allowed) if (publicEnv[key] === undefined && parsed[key] !== undefined) publicEnv[key] = parsed[key]!;
}

const config: NextConfig = {
  transpilePackages: ['@nbdao/shared'],
  poweredByHeader: false,
  env: publicEnv,
};
export default config;
