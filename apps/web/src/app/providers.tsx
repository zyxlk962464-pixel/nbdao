'use client';

import { useState } from 'react';
import { WagmiProvider, createConfig, http } from 'wagmi';
import { bsc } from 'wagmi/chains';
import { injected, walletConnect } from 'wagmi/connectors';
import { defineChain } from 'viem';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

export const localChain = defineChain({
  id: 31337, name: '本地测试链', nativeCurrency: { name: '测试 BNB', symbol: 'BNB', decimals: 18 },
  rpcUrls: { default: { http: ['http://127.0.0.1:8545'] } }, testnet: true,
});
const walletConnectProjectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID?.trim() || '';
export const walletConnectState = !walletConnectProjectId ? 'missing' : /^[0-9a-f]{32}$/i.test(walletConnectProjectId) ? 'enabled' : 'invalid';
export const walletConnectEnabled = walletConnectState === 'enabled';
const config = createConfig({
  chains: [bsc, localChain],
  connectors: [injected(), ...(walletConnectEnabled ? [walletConnect({
    projectId: walletConnectProjectId,
    metadata: { name: 'NBDAO 自动清仓', description: '限定时间内的自动分批卖出',
      url: process.env.NEXT_PUBLIC_APP_URL || (typeof window === 'undefined' ? 'http://localhost:3000' : window.location.origin), icons: [] },
  })] : [])],
  transports: { 56: http(process.env.NEXT_PUBLIC_BSC_RPC_URL || 'https://bsc-dataseed.bnbchain.org'), 31337: http(process.env.NEXT_PUBLIC_LOCAL_RPC_URL || 'http://127.0.0.1:8545') },
  ssr: true,
  multiInjectedProviderDiscovery: true,
});
export default function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  return <WagmiProvider config={config}><QueryClientProvider client={queryClient}>{children}</QueryClientProvider></WagmiProvider>;
}
