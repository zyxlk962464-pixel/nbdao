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
  async headers() {
    return [{ source: '/:path*', headers: [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Referrer-Policy', value: 'no-referrer' },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
      { key: 'Content-Security-Policy', value: "default-src 'self'; script-src 'self' 'unsafe-inline'" + (mode === 'development' ? " 'unsafe-eval'" : '') + "; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' https: wss: http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*; frame-src https://verify.walletconnect.com https://verify.walletconnect.org; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'" },
      ...(mode === 'production' ? [{ key: 'Strict-Transport-Security', value: 'max-age=31536000' }] : []),
    ] }];
  },
};
export default config;
