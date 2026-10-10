# Railway 部署与执行迁移

使用一个 Railway 服务、一个实例和一个持久卷。容器内启动 Next.js 与 Keeper；仅网页监听 `0.0.0.0:$PORT`，Keeper 始终监听 `127.0.0.1:8787`。一个进程退出会让容器停止，Railway 的失败重启策略重启整个服务。`/api/health` 检查两个进程是否存活；`executionReady` 单独表明执行模式与配置是否就绪，不表示代币当前可卖。

## 从 GitHub 建立只读服务

1. 只将 `nbdao-seller` 项目作为独立仓库提交到 `git@github.com:zyxlk962464-pixel/nbdao.git`，不提交父目录的其他文件。`.env`、SQLite 数据库、迁移文件、本机工具和构建目录均被忽略。
2. Railway 连接该仓库，以项目根目录为 Root Directory。Dockerfile 自动用于构建，容器已带生产启动命令。若仓库根目录就是本项目，不要把 Root Directory 设为 `apps/web`。新建服务请在 Settings 明确填写下表；`railway.json` 仅保留给旧服务兼容使用。Railway 官方已弃用该配置方式，新服务不读取它，旧服务将在 2026-12-01 停止读取。为保持本项目简单，使用面板配置即可，无需另加 IaC SDK。
3. 给此服务挂载 Volume，挂载路径为 `/data`；`KEEPER_DATABASE=/data/keeper.sqlite`。只用一个实例，关闭 Serverless/App Sleeping，监控任务期间不要自动停机。持久卷需在 Railway 面板创建，配置文件不会自动创建卷。
4. 将 `railway.env.example` 的公开配置填入 Variables。首次保留 `SELLER_MODE=read-only`，不要填写 `LIVE_EXECUTION` 或 `EXECUTION_HANDOFF`。现有主网合约地址已经填好，无需再次部署链上合约。
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
