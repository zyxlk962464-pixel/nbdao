# 钱包网页

从仓库根目录运行 `pnpm --filter @nbdao/web dev`。网页默认将 `/api/*` 代理到本机 `http://127.0.0.1:8787`，可用服务端变量 `KEEPER_API_URL` 调整。

连接浏览器扩展钱包可以直接使用。页面通过 EIP-6963 检测已安装的钱包，显示真实品牌并去掉重复通用入口；检测不到 provider 时不会展示假连接按钮。Codex 内置浏览器通常没有钱包扩展，请在安装钱包的 Chrome、Edge 等浏览器打开本地页面。

手机钱包可用 WalletConnect 扫码连接。需要设置自己的 `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`（Reown 项目生成的 32 位十六进制公开 ID）；未配置或格式错误时明确停用该入口。可选 `NEXT_PUBLIC_APP_URL` 设置钱包显示的网站地址。`NEXT_PUBLIC_BSC_RPC_URL` 与 `NEXT_PUBLIC_LOCAL_RPC_URL` 分别设置钱包公共读 RPC。

上述 4 个公共字段可以配置在仓库根 `.env` 中，网页的开发与生产构建都会安全读取；进程环境变量与 `apps/web/.env.local` 优先。钱包公共变量在生产构建时固定，修改后需要重新 `pnpm --filter @nbdao/web build`。只读取明确的 4 字段允许列表，不会把 Keeper 或部署私钥加载到网页客户端。公共字段请直接填写实际值，不使用 `$OTHER_ENV` 引用。

页面仅支持 BSC（56）及明确标记的本地测试链（31337）。观察模式不创建或启用新任务；已配置合约时，用户仍可以取消已有任务、撤销授权。

创建任务前依次模拟、审阅参数、有限授权，随后确认创建交易并签署执行服务预算。若签名或服务注册中断，重新连接后可以恢复。金额和单价在审阅后固定，余额轮询不会静默修改待确认交易；执行期间新增奖励超出额度会留下余币并明确显示。

钱包面板支持完整地址复制、当前链与 BNB 余额、刷新、错链切换及必要时添加 BSC（使用执行服务配置的公共 RPC）。恢复连接完成前、余额核查失败时，新的资金操作保持禁用。账户或网络切换会清除旧报价；已广播交易会继续只读核查回执，重连不会自动再次提交。

断开钱包只结束网页连接，不会取消链上卖出任务。停止已有任务需要在任务区取消，撤销剩余授权是单独的链上操作。

本轮已通过类型检查、生产构建及钱包专项回归。CUA 浏览器验收覆盖真实已安装钱包列表、无钱包提示、桌面与手机弹窗；隔离测试页面使用拒绝全部签名及交易的模拟钱包，验证连接拒绝/重试/等待、刷新恢复、账户切换、网络添加/切换、只读限制与断开。详情见 `qa/wallet-verification.json` 和 `qa/wallet-fixture-verification.json`。尚未完成真实扩展授权或手机 WalletConnect 握手；测试余额不代表真实资产。

运行 `pnpm --filter @nbdao/web build` 检查生产构建。`scripts/ui-smoke.mjs` 可对已启动网页执行浏览器测试：通过 `WEB_TEST_URL` 设置网址，通过 `PLAYWRIGHT_MODULE`、`PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指向已有 Playwright 和 Chromium。测试使用明确的只读钱包与 API 测试数据，拒绝所有签名及交易操作，截图保存于 `qa/`。
