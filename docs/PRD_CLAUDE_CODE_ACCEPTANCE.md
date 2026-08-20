# ArtCCH:ArtFi 产品需求与 Claude Code 验收基线

## 0. 文档控制

| 项目             | 定义                                                                   |
| ---------------- | ---------------------------------------------------------------------- |
| 产品             | ArtCCH:ArtFi                                                           |
| 技术支持         | Giraffe ArtFi Corp.，只允许出现在页脚技术支持署名中                    |
| 主仓库           | `giraffetechnology/artfi`                                              |
| 公开 UI 目标域名 | `https://io.artcch.com`；DNS、TLS、主机和反代由服务器配置任务负责      |
| 当前允许链       | Ethereum Sepolia，chain ID `11155111`                                  |
| 当前市场模式     | 合规外部市场只读镜像；ArtFi 不经营交易所                               |
| 验收对象         | 仓库代码、测试、迁移、部署工具、文档和可追溯证据                       |
| 验收依据         | 本文、`ROADMAP.md`、`PRD_TRACEABILITY.md`、各 Stage 验收文档及代码事实 |

本文是 Claude Code 的验收对照，不是实现完成声明。仓库中的注释、截图、历史 PRD
描述和本文件中的“应当”均不能单独证明需求已经交付。

## 1. Claude Code 验收指令

1. 默认执行只读审计。除非收到单独明确的修复授权，不得改代码、推送、开 PR、部署、
   修改 DNS、提交链上交易或触发远程 CI。
2. 逐项检查本文需求 ID，并使用以下唯一状态：
   - `PASS`：代码和适用自动化证据均存在且实际通过。
   - `FAIL`：强制需求缺失、实现与需求相反，或适用测试失败。
   - `BLOCKED`：需要当前环境没有的外部服务、资金、签字或权限，且代码事实不足以替代。
   - `GATED`：明确属于未来合规、安全、法律或主网上线门禁，当前不得启用。
   - `N/A`：经说明后确实不适用于当前验收范围。
3. 每个结论必须引用精确的文件路径、行号、测试名称或运行输出。不得用“看起来正确”
   “已有页面”或截图代替证据。
4. 分开报告：
   - 本地/预上链实现；
   - Sepolia 真实部署与标准探针；
   - OpenSea 资产发现；
   - OpenSea 主网公开数据的只读镜像；
   - 主网、真实资产、真实价值和 ArtFi 交易所。
5. 不得读取、复制或输出私钥、助记词、密码、RPC 凭据、数据库转储、身份材料或签名交易。
6. 若检出任何 ArtFi 内部下单、撮合、签名、托管、结算或绕过合规门禁的可达路径，直接
   记为 `P0 / FAIL`。
7. 缺少 `.git` 历史时，不得声称已验证分支、提交、PR、签名、来源或发布可追溯性；应将
   相关项目标为 `BLOCKED`。

## 2. 产品目标

ArtCCH:ArtFi 将艺术品的作品记录、权利证据、NFT、Vault、份额化代币和 DAO 治理组织为
可审计流程。当前产品应提供：

- 艺术项目、作品、来源记录、公开组合和治理状态的响应式浏览体验；
- 通过标准外部钱包连接 Sepolia，不接触用户私钥；
- 受权利和权限门禁约束的 RWA 记录、元数据、NFT 铸造与 Vault/份额化流程；
- OpenSea 等已批准市场的带来源只读镜像，以及跳回原市场的外部链接；
- 提案、法定人数、Timelock、角色和 Treasury 的透明展示；
- 可恢复、可回滚、可观察且默认拒绝的 API、数据和运维边界。

## 3. 强制产品边界

以下约束优先级高于功能便利性：

- 禁止主网、真实资金、真实产权转移或公开生产运行，除非另有书面 go/no-go。
- 当前阶段禁止 ArtFi 自营交易所。不得创建、签名、撮合、托管、履约或结算市场订单。
- `ArtFiMarket` 可保留为安全回归候选代码，但不得出现在当前部署脚本、发布清单、路由、
  功能开关或用户操作流中。
- OpenSea Stream 的主网只读镜像与 Sepolia NFT 发现是两个独立证据轨道，不得互相替代。
- 核心 DApp 使用外部钱包；Stage 5 浏览器钱包是独立、单独门禁的产品。
- 官方 ArtCCH Logo 必须直接使用获批 VI 资产，不得描摹、重绘或生成替代 Logo。
- 产品名称为 `ArtCCH:ArtFi`；Bazaar 仅是组合参考，不得显示为本产品或合作方。
- 所有测试夹具、估值、Treasury、治理和市场值必须明确标示为示例、测试或只读数据。

## 4. 核心用户旅程

### J-01 浏览与溯源

用户可从 Overview 进入项目、市场镜像、作品详情、Wallet 和 DAO；在任何涉及价值的动作前
看到作品、作者、媒介、来源、权利状态、链、合约和数据来源。

### J-02 外部钱包

用户连接兼容 EIP-1193 的外部钱包，应用显示公开地址、Sepolia 网络和测试余额。仅浏览不得
请求签名；错误网络不得发起 ArtFi 写交易。

### J-03 RWA 与测试 NFT

经授权用户创建作品记录、提交权利和来源字段、上传经校验媒体、生成可复现元数据，审阅
交易意图后由外部钱包在 Sepolia 确认铸造。失败、拒签、重试和回执必须可解释、可恢复。

### J-04 Vault、份额化和 DAO

经授权角色创建 Vault/DAO，将获批 NFT 经 approve 后存入 Vault，配置份额代币并验证供应量、
权限与托管不变量。治理执行只能经过 Governor 和 Timelock。

### J-05 外部市场镜像

用户查看已批准来源的 listing、offer、sale、transfer、cancel 和通知。每条记录显示来源、时间、
新鲜度和外部深链；任何交易执行均离开 ArtFi 并在外部市场完成。

## 5. 功能需求与验收条件

### 5.1 Web 与品牌

| ID      | 强制需求                                                                                                                | Claude Code 验收条件                                                                                                     |
| ------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| WEB-001 | 提供 Overview、projects、project detail、RWA market、fractional market、asset detail、portfolio、RWA create 和 DAO 路由 | 路由可渲染；桌面与移动布局无水平溢出；加载、空、错误和门禁状态可达；自动化覆盖代表路由                                   |
| WEB-002 | 提供搜索、状态过滤、稳定排序和确定性分页                                                                                | 查询参数/API 测试覆盖空结果、非法参数、边界页、稳定游标或稳定 offset；UI 不把静态标签冒充可用筛选器                      |
| WEB-003 | 严格使用 ArtCCH VI                                                                                                      | Logo 来自批准资产；全局品牌为 `ArtCCH:ArtFi`；Bazaar 不出现在面向用户文案；Giraffe 只在页脚技术支持署名                  |
| WEB-004 | 响应式、可访问和无误导文案                                                                                              | 代表路由在桌面和移动端通过；Axe 无 serious/critical；键盘可操作；颜色对比符合 WCAG 2 AA；无“ArtFi 内购买/出价/认领”暗示  |
| WEB-005 | 明确测试及只读边界                                                                                                      | 全局可见 Sepolia/read-only/no-custody/no-in-app-execution 状态；夹具不得使用“实时成交”措辞，除非确有带时间戳的运行时来源 |

### 5.2 钱包与交易意图

| ID         | 强制需求                           | Claude Code 验收条件                                                                                          |
| ---------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| WALLET-001 | RainbowKit/Wagmi/Viem 外部钱包连接 | 连接、断开、重连、账户变化和拒绝连接均有测试；只读连接不请求签名                                              |
| WALLET-002 | Sepolia 强制执行                   | chain ID 非 `11155111` 时所有写动作 fail closed；切链失败有明确错误；合约地址来自版本化部署清单而非组件硬编码 |
| WALLET-003 | 非托管和交易预览                   | Web/API 不接收助记词或私钥；签名前展示目标合约、方法、链、资产、金额和风险；拒签和失败不会生成虚假成功记录    |

### 5.3 RWA、元数据与 NFT

| ID          | 强制需求                           | Claude Code 验收条件                                                                                                                                                                                                                          |
| ----------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RWA-001     | 作品、所有权、来源、权利和媒体记录 | 必填字段、MIME、大小、内容哈希、重复、损坏和未授权上传测试通过；对象存储访问策略与生命周期有证据                                                                                                                                              |
| RWA-002     | 可复现、不可变的 NFT 元数据        | 从持久化记录可重建相同元数据和哈希；媒体/元数据 URL 可公开读取但不能静默变更；含测试网及无真实产权转移声明                                                                                                                                    |
| RWA-003     | NFT 工厂与铸造                     | 未授权、暂停、重复承诺、失败回执和成功事件测试通过；源码、编译设置、bytecode hash 和部署清单可追溯                                                                                                                                            |
| RIGHTS-001  | 权利证据是铸造硬门禁               | 缺少权利主体、授权范围、期限、地域、署名、下架流程或哈希绑定时必须拒绝铸造包；隐私协议不得提交 Git                                                                                                                                            |
| CHARITY-001 | 首批固定慈善版供应                 | `UNIT-A01/04/05/11/14/15/16/17/20/21/22/23/24` 共 13 件；重复 A16 只计一次；每件一个 ERC-1155 token ID，一次性铸造且永远固定 100 枚，记录单价 `0.01 ETH`；不存在追加铸造或外部销毁入口                                                        |
| CHARITY-002 | 私密原图和唯一持有人权益           | 公共 metadata 无作品 `image`/预览；任何网站不得提供无水印高清图；唯一权益为持币校验后的高清有水印下载且不提供浏览器预览；master 与 holder 文件必须哈希不同                                                                                    |
| CHARITY-003 | CCHS 收益和收据边界                | 100% 初始发行收益指向 CCHS 确认钱包；持有人直接联系 CCHS；ArtFi 不开票、不决定或承诺 eligible amount；CCHS 收据金额政策锁定为开票时点、CCHS 批准公开来源的 `ETH/CAD` 市场价并保留时间、价格、来源和快照哈希，缺少 CCHS 书面确认时 fail closed |
| CHARITY-004 | 实物映射和售罄后捐赠               | NFT 不传递实物所有权、占有、赎回、版权、复制或商业使用权；原发行钱包余额为 0 且外部售罄证据完成后才可记录售罄；仅售罄后才可记录 CCHS 实物捐赠接收证据                                                                                         |

### 5.4 Vault、份额化与治理

| ID      | 强制需求                              | Claude Code 验收条件                                                                                                   |
| ------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| DAO-001 | 创建 DAO/Vault                        | 名称、角色和治理参数校验；部署事件与数据库记录一致；重复请求幂等                                                       |
| DAO-002 | NFT approve、deposit 与 custody       | 仅获批 NFT/角色可存入；所有权进入 Vault；重放、重复存入、暂停和恢复测试通过；多 NFT 支持不得被单 NFT 测试替代          |
| DAO-003 | 配置并发行份额代币                    | symbol、supply、decimals、reserve 和 distribution 有界；固定供应、权限、暂停和恢复不变量通过 fuzz/invariant 测试       |
| GOV-001 | 提案、投票、法定人数、Timelock 和执行 | Governor 是唯一 proposer/executor 边界；无 bootstrap admin 遗留；历史投票 checkpoint、排队、取消、过期和执行失败有测试 |
| GOV-002 | DAO UI 当前保持透明和只读             | 可显示 proposal/quorum/timelock/treasury/roles；若没有获批写流程，UI 不得提交投票或执行提案                            |

### 5.5 外部市场镜像

| ID         | 强制需求                               | Claude Code 验收条件                                                                                                            |
| ---------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| MARKET-001 | ArtFi 自营订单、出价、撮合、认领和结算 | 当前状态必须为 `GATED`；任何可部署或可达实现均为 `P0 / FAIL`                                                                    |
| MARKET-002 | 版本化的已批准市场适配器               | `MarketplaceAdapter` 明确 backfill/realtime 生命周期、schema version、原始载荷和来源版本；来源必须在 allowlist                  |
| MARKET-003 | OpenSea 实时流与 REST 补洞             | 重复、乱序、断线、重连、缺口、旧版本、取消后成交和成交后旧 listing 测试收敛到唯一正确状态                                       |
| MARKET-004 | 只读 API 和外部深链                    | API 能读取活动但不能 create/sign/match/custody/fulfil/settle；每条记录保留来源、时间和 HTTPS 外部链接                           |
| MARKET-005 | 数据陈述准确                           | 本地 fixtures 明确标示；只有实际连接适配器并提供观察时间/新鲜度时才可称“实时”；OpenSea Stream 主网事件不得声称是 Sepolia Stream |

### 5.6 API、数据与存储

| ID        | 强制需求                           | Claude Code 验收条件                                                                                          |
| --------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| API-001   | Go API、OpenAPI 3.1 和统一错误契约 | health/config/catalog/portfolio/CORS/problem response/request ID 测试通过；生成客户端与 OpenAPI 无漂移        |
| API-002   | 默认拒绝的认证和 RBAC              | public、operator、indexer 权限分离；缺失/过期/错误 audience/错误角色均拒绝；不得用前端隐藏代替 API 授权       |
| DATA-001  | MySQL 8.4 为离链业务权威记录       | Stage 迁移可正向、回滚和重放；约束、事务、幂等和重启恢复测试通过；不得用内存 fixtures 冒充持久化交付          |
| DATA-002  | Redis 缓存与失效                   | key/version/TTL 有界；写后失效、竞争和 Redis 不可用模式有测试；缓存不得成为所有权或供应量权威来源             |
| STORE-001 | R2 兼容对象存储                    | 完整性哈希、访问控制、不可变引用、失败恢复和生命周期测试通过；仓库不包含真实私密证据文件                      |
| INDEX-001 | 链事件索引和重组恢复               | 使用 chain/tx/log 唯一身份；重复、removed log、replacement、confirmations、restart 和任意精度余额重建测试通过 |

### 5.7 合约、安全、合规与运维

| ID           | 强制需求                          | Claude Code 验收条件                                                                                                 |
| ------------ | --------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| CONTRACT-001 | NFT factory 与 asset contracts    | unit、failure、authorization、fuzz、invariant、size、pause 和 deployment simulation 通过；低于 EIP-170/EIP-3860 限制 |
| CONTRACT-002 | Vault 与 fractional contracts     | custody、fixed supply、roles、replay、pause、recovery、fuzz 和 invariant 通过；无未记录 EOA 特权                     |
| EXT-001      | 独立浏览器钱包 Alpha              | 加密本地 vault、权限、确认、网络、钓鱼和恢复测试可存在，但在独立审查和商店批准前保持 `GATED`；不得阻塞核心 DApp      |
| SEC-001      | 应用与会话安全                    | 威胁模型、输入校验、RBAC、CSP/安全头、依赖/secret 扫描和负面测试存在；生产 OIDC 未批准时 fail closed                 |
| SEC-002      | 独立安全审计                      | 审计、整改和复测必须绑定同一发布 commit/address/bytecode；缺失时保持 `GATED`，不得称 production ready                |
| COMP-001     | KYC/KYB、AML/制裁、司法辖区和隐私 | policy/schema 可实现，但提供商和法律批准前 fail closed；缺少身份或资格不得接受价值                                   |
| COMP-002     | 产权、托管、估值、赎回和争议      | 每项有责任人、证据、时效和异常流程；获批运营模式缺失时保持 `GATED`                                                   |
| OPS-001      | CI/CD、监控、备份和回滚           | 构建可复现；日志/指标/告警、备份恢复、发布清单和回滚演练有证据；部署产物映射不可变 commit/digest                     |
| OPS-002      | 秘密与供应链                      | Git 中无 secret、keystore、密码、签名交易或私密证据；依赖锁定；SBOM、来源和扫描结果绑定发布候选                      |

## 6. 非功能验收

### 6.1 安全

- 所有权限检查在服务端或合约端执行，前端仅作辅助提示。
- 错误网络、缺失证据、未知来源、旧事件、验证失败和外部服务故障全部 fail closed。
- 不允许自定义密码学、明文私钥持久化或把生产 secret 写入 `.env` 后提交。

### 6.2 可访问性与体验

- 关键流程可使用键盘操作，表单有 label，状态变化有合适的语义或 live region。
- 代表路由在桌面和移动端无 serious/critical Axe 问题。
- 每个用户操作必须有 loading、empty、error、rejected 和 success/receipt 状态；不可静默失败。

### 6.3 可恢复性与可观察性

- 所有写请求、链事件和外部市场事件有稳定幂等键及可追踪 ID。
- 数据库、索引器、WebSocket 和 RPC 重启后可继续，不依赖不可恢复的进程内状态。
- 日志不得泄露秘密或个人身份材料；必要事件包含 UTC 时间、请求/交易/日志身份和来源。

## 7. 本地质量门

Claude Code 应从干净 checkout 运行适用命令并记录命令、环境、退出码和失败摘要。不得只引用
历史结果。

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
pnpm contracts:format:check
pnpm contracts:lint
pnpm contracts:build
pnpm contracts:test
pnpm contracts:deploy-tooling:check
pnpm security:secrets
pnpm release:verify-schema
pnpm mint:verify-schema
pnpm mint:verifier:test
pnpm charity-edition:verify-schema
pnpm charity-edition:verifier:test
(cd apps/api && go vet ./... && go test -race ./...)
docker compose config
```

验收规则：

- 任一适用门失败即不得给出全量 `PASS`。
- Windows standalone 构建若仅因 symlink 权限 `EPERM` 失败，可标为环境 `BLOCKED`，但必须在
  最终 Linux CI 中实际通过，不能永久豁免。
- 历史格式债务、测试不稳定和“与本次改动无关”仍需列为仓库级 gap；不得隐去。
- 用户要求全部 Stage 收口后只触发一次最终远程 CI；未获明确授权时只审计 CI 配置和本地门。

## 8. Sepolia 与 OpenSea 外部证据

### 8.1 预上链验收

以下项目应在没有测试 ETH 的情况下完成：编译、合约尺寸、unit/fuzz/invariant、无广播部署模拟、
部署脚本语法、chain ID/角色/余额 fail-closed 预检、secret 扫描、mint-package schema 和
charity-edition package schema/负向校验。

### 8.2 真实 Sepolia 运行

只有在测试专用 signer 获得资金、使用批准的新加坡出口、锁定 release commit、角色和编译设置后
才可执行。必须记录地址、交易哈希、receipt、block、gas、runtime bytecode hash、源码验证链接和
标准探针结果，但不得记录私钥或密码。

接受标准包括 ERC-165、ERC-721 metadata/transfer、ERC-20 metadata、EIP-2612、ERC20Votes、
AccessControl、pause、Timelock、Vault custody、fixed supply、replay 和 unauthorized rejection。

### 8.3 测试作品与 OpenSea

- 作品必须具有 NFT 铸造、公开元数据和测试市场展示授权，并生成内容哈希与下架记录。
- 元数据必须含 `TESTNET / NO REAL-WORLD TITLE TRANSFER`。
- OpenSea 不支持相应 Sepolia 展示时，应记录外部限制并用 explorer 加独立 ERC-721 客户端验证；
  不得伪称 OpenSea 已接受。
- 上架是独立的显式授权动作，执行前再次确认 collection、token ID、价格、币种、期限、版税和
  钱包签名。本文不自动授权上架。

### 8.4 首批 ArtCCH 慈善版

- 首批输入中的 `UNIT-A16-000.png` 重复项必须按相同源文件去重，最终为 13 个 token ID、
  1,300 个不可增发单位。
- 该批次是 ERC-1155 固定版，不得被一般 ERC-721 测试作品流程替代；`ArtFiCharityEditions`
  必须独立通过 ERC-165、ERC-1155、metadata、fixed supply、pause、权限、重复作品/哈希和
  售罄后捐赠顺序测试。
- OpenSea 发现验证不得以发布作品预览或无水印 master 为代价。公共 metadata 必须无作品
  `image` 字段；OpenSea 显示通用缺图状态可以作为符合隐私要求的结果。
- 在 CCHS 法定名称、CRA 注册号、收款钱包、收据估值/holder advantage 政策和实物接收流程
  获得书面证据前，媒体上传、metadata 发布、部署、创建系列、上架和收据声明均为 `BLOCKED`。
- CCHS 收据金额采用开票时点公开市场 `ETH/CAD` 价格是产品要求，但只有 CCHS 可以确定并
  签发 eligible amount。ArtFi 只能保存或展示 CCHS 批准的来源、时间、汇率和快照证据。

## 9. 当前必须保持的 Gate

以下项目即使代码存在，也不能在当前验收中判为已上线：

- ArtFi 自营交易所；
- Ethereum mainnet；
- 真实资金、真实产权或真实投资人；
- 未获批准的市场适配器；
- 未完成独立审计的浏览器钱包；
- 未完成法律、合规、托管、安全和运维签字的生产发布。

任何代码、地址、角色或 bytecode 变化都会使既有审计和 go/no-go 证据失效并要求重新验证。

## 10. Claude Code 输出格式

最终验收报告必须按以下结构输出：

```markdown
# ArtCCH:ArtFi 验收报告

## 结论

- 总体：PASS / CONDITIONAL / FAIL
- 代码与本地预上链：...
- Sepolia 真实运行：...
- OpenSea 发现：...
- 外部市场镜像：...
- 生产/主网：GATED

## 需求矩阵

| ID  | 状态 | 证据 | Gap | 严重级别 | 建议 |
| --- | ---- | ---- | --- | -------- | ---- |

## 质量门

| 命令 | 退出码 | 结果 | 证据摘要 |
| ---- | -----: | ---- | -------- |

## 禁止项扫描

- ArtFi 订单执行路径：...
- 主网/真实价值开关：...
- secret/私钥/签名交易：...
- 未批准 Logo 或品牌署名：...

## 未验证声明

- ...

## P0/P1 阻断项

- ...

## 可继续推进的下一 Stage

- ...
```

总体判定规则：

- `PASS`：当前范围内所有强制需求和适用质量门通过，外部 Gate 被正确保持且没有被错误宣称。
- `CONDITIONAL`：本地/预上链实现通过，但明确列出的外部证据、发布来源或环境验证仍为
  `BLOCKED/GATED`。
- `FAIL`：存在 P0/P1、安全边界突破、强制功能缺失、适用质量门失败或重大不可追溯声明。
- 无论本地结果如何，在独立审计、法律/合规签字、不可变发布证据和书面 go/no-go 完成前，
  禁止使用“生产就绪”“可主网上线”或“ArtFi 交易所已交付”等结论。
