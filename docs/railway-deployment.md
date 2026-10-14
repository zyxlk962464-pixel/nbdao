# Railway 部署与执行迁移

使用一个 Railway 服务、一个实例和一个持久卷。容器内启动 Next.js 与独立 Keeper 后台进程；仅网页监听 `0.0.0.0:$PORT`，Keeper 始终监听 `127.0.0.1:8787`。Keeper 自行订阅新区块，与浏览器请求无关。已创建且已签署登记条件的任务，在关闭浏览器、断开钱包或关闭电脑后继续运行，直到原截止时间或触发停止条件；仅创建链上任务而未登记服务条件不会自动卖出。

一个进程退出会让容器停止，Railway 的失败重启策略重启整个服务，并从持久卷恢复任务与交易记录。`/api/health` 检查两个进程及 Worker 是否运行、是否仍有区块活动；`executionReady` 单独表明执行模式与配置是否就绪，不表示代币当前可卖。页面展示云端后台状态及最近检查区块。Worker 忙于检查或确认时合并新区块通知，随后按最新区块检查，不保证逐个处理全部中间区块。

## 从 GitHub 建立只读服务

1. 只将 `nbdao-seller` 项目作为独立仓库提交到 `git@github.com:zyxlk962464-pixel/nbdao.git`，不提交父目录的其他文件。`.env`、SQLite 数据库、迁移文件、本机工具和构建目录均被忽略。
2. Railway 连接该仓库，以项目根目录为 Root Directory。Dockerfile 自动用于构建，容器已带生产启动命令。若仓库根目录就是本项目，不要把 Root Directory 设为 `apps/web`。新建服务请在 Settings 明确填写下表；`railway.json` 仅保留给旧服务兼容使用。Railway 官方已弃用该配置方式，新服务不读取它，旧服务将在 2026-12-01 停止读取。为保持本项目简单，使用面板配置即可，无需另加 IaC SDK。
3. 给此服务挂载 Volume，挂载路径为 `/data`；`KEEPER_DATABASE=/data/keeper.sqlite`。只用一个实例，关闭 Serverless/App Sleeping，监控任务期间不要自动停机。持久卷需在 Railway 面板创建，配置文件不会自动创建卷。
4. 将 `railway.env.example` 的公开配置填入 Variables。首次保留 `SELLER_MODE=read-only`，不要填写 `LIVE_EXECUTION` 或 `EXECUTION_HANDOFF`。原窗口监控的主网合约地址已经填好；指定日期抢卖需要另部署新合约，见下文。
5. 生成 HTTPS 域名。浏览器 MetaMask 可直接连接；WalletConnect 扫码需要自己的公开 Project ID。`NEXT_PUBLIC_*` 是构建变量，修改后重新构建。

| Railway 设置 | 值 |
| --- | --- |
| Builder / Dockerfile | Dockerfile，路径 `Dockerfile` |
| Start Command | `node scripts/start.mjs` |
| Healthcheck Path / Timeout | `/api/health` / 120 秒 |
| Restart Policy / Max Retries | On Failure / 5 |
| Replicas | 1 |
| Serverless / App Sleeping | 关闭 |
| Volume Mount Path | `/data` |
| Public Networking Target Port | `PORT` 对应的网页端口，未设置 `PORT` 时为 3000 |

不要给 Keeper 的 8787 端口建立公网入口。健康检查表示进程存活，实盘是否配置就绪请看页面配置状态。

私钥只配置为服务端 `KEEPER_PRIVATE_KEY`，然后设为 Sealed。不要放进 GitHub、Docker 构建参数、日志或任何 `NEXT_PUBLIC_*` 字段。Docker 构建不接收私钥；网页进程的启动环境也会移除执行和部署私钥。按目前选择，执行与持币使用同一个钱包，所以云端 Keeper 将拥有该钱包的完整签名能力。

生产镜像设置 `RUNTIME_ISOLATION=1`：启动器初始化卷与文件权限，然后分别以 UID 1001（网页）和 UID 1002（Keeper）启动应用。执行数据目录权限 0700、数据库和导入记录权限 0600；网页账户无法直接读取执行进程环境或数据库，应用代码目录由 root 持有。初始化及信号转发进程仍使用 root，这不等同于不同容器或硬件密钥隔离。首次升级会调整现有卷权限，不更改数据库业务记录。

公开接口限制进程总并发和请求频率、校验写请求来源及 JSON 类型，按实际字节限制请求体。Keeper 合并重复展示查询并短暂缓存 250 毫秒，最多同时处理 4 个不同的展示查询；Worker 的交易判断不使用此缓存。健康检查不消耗展示接口限额。线上已有 `SELLER_ADDRESS` 时关闭重复部署预检/回执接口；网页启用防嵌入、禁用对象加载等安全响应头。限流不能代替上游抗 DDoS 服务。

链上读取按 `RPC_URLS` 顺序自动切换节点；相邻 5 毫秒内的并发读取合并为最多 20 项的 JSON-RPC 请求，保持原调用钱包和指定区块，不使用 Multicall 合约。真实合约回滚不会通过切换节点绕过。所有节点不可用时暂停卖出并等待后续检查；独立节点健康检查和签名交易广播保持原流程。合并请求可减少 HTTP 往返，但不保证降低 RPC 服务商按方法计费或限流的次数。

`TaxRecorder` 在服务端独立随新区块观察同步后的预计基础税，即使没有有效卖出任务、处于只读模式或浏览器已关闭也会记录。仅将低于 100% 的有效税率写入快照：低税变化或观察到从 100% 回落时立即保存，低税无变化时每 30 分钟保存一条。100% 只在内存中跟踪变化；读取失败不写入快照、不当作 0%，也不会因恢复到相同低税反复保存，异常仍体现在 recorder 后台状态中。重启后按最近低税快照恢复保存间隔，不能补造停机期间的变化。忙碌时合并通知读取最新状态，历史不保证覆盖所有区块。保留最近 30 天，最多 10 万条，存放在现有持久 SQLite 数据库的 `tax_history` 表；网页 `税率快照` 通过只读 `/api/tax/history` 仅展示低于 100% 的最近 20 条及低税记录内的最低、最高值。旧版保存的 100% 和不可用记录不再展示，本次更新不主动删除它们，仍受原保留规则限制。上线前未留存的历史不会补造。观察记录不参与卖出判断，不修改已签任务，也不自动延长任务窗口。

新任务移除独立的基础税率上限，只按用户填写的“卖出后最低获得”金额折算每枚到账底线，再执行完整到账检查。监控窗口、滑点、Gas 预算等执行保护继续生效。旧任务中已签署的 `maxSellFeePercent` 仍由服务执行，页面明确提示需取消并重新创建才能采用新规则；更新不会静默修改冻结的旧任务参数。

两个卖出页面显示整个 NBDAO 交易池的“昨日成功卖出”，无需连接钱包。范围为北京时间上一自然日 00:00（含）至次日 00:00（不含），每天自动切换。独立只读后台每 15 秒查询，按区块时间定位日界、分批扫描该日全部卖出方向的 Swap，核对成功回执及规范链，并排除代币合约自身内部手续费换币、加池和回滚。API `/api/sales/previous-day` 只返回缓存，不因浏览器请求触发长扫描；日界定位和扫描位置保存在持久卷的 `market_sale_days`，全部卖出记录按交易哈希与日志位置去重保存在 `market_sale_day_records`，保留最近三个日期，不按条数截断。未扫描完会明确提示可能缺记录；仅扫描完整且末尾区块达到三次确认后，才能显示完整结果或当天无成交。历史查询不改变任务或执行条件，近期钱包交易优先。

记录按交易分组并展开该笔全部外部卖出，持币地址与发起地址区分；整笔 Gas 只在组头显示一次，不虚构每个钱包的分摊。实际代币扣税率按每次持币地址到代币合约的扣费量除以该次总卖币量，包含基础税和利润扣费，不含兑换费、Gas、排序费和价格影响，不以区块末税率或池内余量替代。钱包直接收款以该次 USDT 日志核对；单笔脚本代收再付给该持币地址时核对实际转款，多次批量代收或无法归属的结算显示“无法确认”，并单独给出兑换换出 USDT 和收款地址。RPC 故障保留同日缓存并标记未完成或过期，重组清空受影响日并重查。兼容的 `/api/sales/latest` 继续提供全池最新一笔缓存。

历史日志默认使用 1RPC 的 BSC 公共端点。可在 Railway 的服务端变量 `SALE_HISTORY_RPC_URLS` 填写支持历史 `eth_getLogs` 的 HTTP/HTTPS 端点，多个以逗号分隔；各端点先验证 BSC 网络，只在通过验证的端点间回退，地址及其中的 API 密钥不返回浏览器。每项查询最多 50 区块，HTTP 批次最多 20 项，再拼接为最多 5000 区块的一页；所有子查询成功后才推进页面。公共节点限流或额度不足时保留进度重试，不把缺数据当成无成交。若已有全池最新成交的 `coverageStart` 覆盖证明，且扫描已跨过该成交整个区块、扫描前沿覆盖日尾并经规范链哈希复核，可复用其已查明无更晚外部卖出的空区间。旧版本无证明的缓存重新建立覆盖，不用于快进；扫描前沿重组从仍有效成交的前一个区块重查，避免只回退 50 区块而漏掉深重组后的成交。

`ALLOWED_OWNER_ADDRESS` 已配置为 `0x311349ab245f51eb2B97E9b85B2fa0bbd20211DD`。后端在查询、签名登记、执行和恢复广播时限制持币钱包；登记也要求任务绑定当前执行者并提供 owner 的正确签名。云端不开放手动分叉报价接口，执行服务在条件达标时自行报价。

## 迁移当前任务

整个迁移不创建卖币任务、不改变签署参数，也不提交链上交易。数据库含已签名原始交易，虽然不含私钥，仍应按敏感文件保管。使用 SQLite 在线备份接口，不能直接复制运行中的 `.sqlite` 文件而遗漏 WAL。

1. 先让 Railway 的只读服务运行成功。保留本机任务正常监控，直到准备实际切换。
2. 切换时停止本机 Keeper，确认进程退出；停止网页不能代替停止 Keeper。若进程被强制结束且租约仍有效，等待租约失效后再导出，不手动清除交易或费用记录。
3. 在本机项目根目录执行：

   ```sh
   pnpm db:export data/preview.sqlite data/migration/keeper-export.sqlite
   ```

   该命令默认拒绝执行器仍持有有效租约的数据库。输出 SQLite 和相邻的 `.manifest.json`，包含 SHA-256、记录数量、未确认交易数和累计 Gas 校验值；两份文件必须一起迁移。`--online` 只用于演练副本，标记为不能开启云端实盘。

4. 在 Railway CLI 登录并关联目标服务后，用 Volume 文件工具上传两份文件。文件路径相对于卷根目录，下面的 `/import/` 在容器中对应 `/data/import/`；按提示选择本服务的卷。不要通过 GitHub 上传。导入后的目标数据库为 `/data/keeper.sqlite`。

   ```sh
   railway volume files upload data/migration/keeper-export.sqlite /import/keeper-export.sqlite
   railway volume files upload data/migration/keeper-export.sqlite.manifest.json /import/keeper-export.sqlite.manifest.json
   ```
5. 保持只读，设置 `KEEPER_IMPORT_FILE=/data/import/keeper-export.sqlite` 并重新部署。启动器会先检查完整性、清单与文件哈希，再导入；保留全部任务、固定服务参数、尝试次数、待确认签名、nonce、成交和 Gas 记录，只清除旧进程租约。已有非空数据库不会被覆盖；同一份快照再次启动会识别为已导入，不重置记录。
6. 在页面核对任务、到账底线、剩余时间、成交与 Gas。导入会产生 `/data/keeper.sqlite.import.json`。确认后移除 `KEEPER_IMPORT_FILE`，保留运行数据库与导入记录。
7. 本机 Keeper 必须保持停止；在 Railway 中配置执行私钥，并设置：

   ```text
   SELLER_MODE=live
   LIVE_EXECUTION=I_UNDERSTAND
   EXECUTION_HANDOFF=LOCAL_KEEPER_STOPPED
   ```

   云端实盘同时要求数据库位于持久卷、已导入最终快照以及停止本机的操作确认。缺少任何一项都不会签名卖出。操作确认不构成跨机器分布式锁；不要再启动使用同一钱包的本机实盘服务。

任务截止时间继续沿用原签署值，不因迁移延长。到期的任务不会恢复卖出，必须在新域名上重新创建并签署新任务；不要通过删除数据库重置尝试次数或预算。回滚到本机时也要先停止云端，并把云端最新数据库通过同一工具迁回，不能使用切换前的旧本机副本。

## 指定日期 08:00 抢卖

`/opening` 是独立的新流程，主要填写北京时间日期、本次 BNB 总费用上限及最低实际到账 USDT。选择一个日期只执行一次，不每日重试；执行窗口为该日 08:00:00 至 08:00:12。原有监控页继续使用原合约和原任务条件。

首次先在 `/opening/deploy` 连接 BSC 钱包，核对一次性部署最高费用，再由钱包确认部署。页面只允许已核对的固定编译代码，部署费用单独支付，当前部署费上限 0.0005 BNB。回执达到三个确认、运行代码和代币/交易池/构建者绑定核对通过后，把新地址填写为服务端 `OPENING_SELLER_ADDRESS` 并重新部署网页服务。不要替换旧 `SELLER_ADDRESS`。未配置新地址时，日期页面禁止授权和任务创建；不需要新增私钥或公开执行进程端口。

每次任务先做有限授权、创建链上任务，再签署冻结的服务条件并登记服务器；只有全部完成才会执行。BNB 总预算包含本次授权与任务创建实际 Gas、执行 Gas 和排序费，页面先保守预留创建和执行 Gas，余额用于固定构建者报价，不自动加价。最低 USDT 是本次卖出的代币总量实际到账，USDT 直接转入持币钱包。该金额不扣除以 BNB 支付的费用。签名后余额新增不会自动增加卖出量，余额减少、授权不足、旧任务重叠、nonce 被其他交易占用或准备读取失败会停止抢卖。

后台 `OpeningWorker` 与浏览器独立运行，在目标时间前准备，向固定 [48 Club 构建者](https://docs.48.club/puissant-builder/send-bundle) 投递同一笔预签交易，最多八次，没有公开交易广播的后备路径。只有一个执行 nonce 和一次卖出；重复私有投递不产生重复卖出。原子调用 `sync(true)`、`sync(false)` 后直接从持币钱包转入交易池，到账检查通过后才支付固定构建者地址。未成交不支付排序费；链上回滚仍可能消耗 Gas。到期不自动延期，取消任务需链上确认。无法保证构建者赢得该区块、首笔排序或未来收益。

新任务和预签交易保存在持久卷 SQLite 的 `opening_tasks`、`opening_attempts` 表，迁移工具也核对它们的待确认 nonce、Gas、准备费用与排序费。关闭电脑不会停止服务器任务。新 Worker 与旧 Worker 共用执行租约，防止同钱包并发签名；未知交易结果保持锁定并继续只读核查，不创建替代交易。`/api/health` 的 `openingExecutionReady` 独立表示新流程是否已配置和启用。

本地历史分叉验证使用 2026-10-13 08:00 前的真实代币和交易池状态：全卖 216.088122320224397815 NBDAO，实际到账 44.300380386657084633 USDT；有限授权、创建、执行 Gas 加 0.001 BNB 排序费合计 0.002127413 BNB，不包含首次部署。此验证仅在本地 Anvil 写入，说明该历史状态下调用路径可行，不代表下一次一定能成交。

## 本地镜像验证

```sh
docker build --platform linux/amd64 -t nbdao-seller:railway-check .
docker run --rm -p 127.0.0.1:3300:3000 \
  -e SELLER_MODE=read-only \
  --mount type=volume,source=nbdao-check,target=/data \
  nbdao-seller:railway-check
```

不传私钥、不挂载 `.env`，即可验证生产网页、健康检查与持久化启动。实际代币能否卖出仍取决于链上状态、税率、最低到账及完整调用检查。

官方参考：[Dockerfile 构建](https://docs.railway.com/builds/dockerfiles)、[新旧配置方式](https://docs.railway.com/infrastructure-as-code)、[持久卷](https://docs.railway.com/volumes)、[卷文件上传](https://docs.railway.com/cli/volume)、[变量与 Sealed](https://docs.railway.com/variables)。
