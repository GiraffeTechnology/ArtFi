# ArtCCH:ArtFi 产品需求与 Claude Code 验收基线

## 0. 文档控制

| 项目             | 定义                                                                   |
| ---------------- | ---------------------------------------------------------------------- |
| 产品             | ArtCCH:ArtFi                                                           |
| 技术支持         | Giraffe ArtFi Corp.，只允许出现在页脚技术支持署名中                    |
| 主仓库           | `giraffetechnology/artfi`                                              |
| 公开 UI 目标域名 | `https://io.artcch.com`；DNS、TLS、主机和反代由服务器配置任务负责      |
| 当前允许链       | Ethereum Sepolia，chain ID `11155111`                                  |
| 当前市场模式     | 合规外部市场实时镜像与交易编排；执行归属外部市场，ArtFi 不经营交易所   |
| 验收对象         | 仓库代码、测试、迁移、部署工具、文档和可追溯证据                       |
| 验收依据         | 本文、`ROADMAP.md`、`PRD_TRACEABILITY.md`、各 Stage 验收文档及代码事实 |

本文是 Claude Code 的验收对照，不是实现完成声明。仓库中的注释、截图、历史 PRD
描述和本文件中的“应当”均不能单独证明需求已经交付。

### 当前迭代范围决定（2026-08-21）

外部钱包连接验证与 DAO 分类治理的代码验收已纳入本迭代，不再标记 `N/A`。钱包必须使用标准
外部 provider；一次性 nonce 验签只证明钱包控制权。DAO 必须持续验证 Vault 对底层 ERC-721 的
托管、份额余额成员资格与 ERC20Votes 历史快照投票权。生产部署、自动扣款、强制平仓及真实
收购资金/代币结算仍为 `GATED`，不得因代码实现而绕过法律、安全审计或单独上线批准。

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
- 通过标准外部钱包接口连接、验签并展示只读状态，Web/API/MySQL/服务器/CI 均不接触用户私钥；
- 受权利和权限门禁约束的 RWA 记录、元数据、NFT 铸造与 Vault/份额化流程；
- OpenSea 等已批准市场的带来源实时镜像，以及由用户从 ArtFi UI 发起、由外部市场执行并回传结果的交易编排；
- 基于历史快照的分类提案、投票、Timelock、角色和 Treasury 治理；生产执行仍受发布门禁约束；
- 可恢复、可回滚、可观察且默认拒绝的 API、数据和运维边界。

## 3. 强制产品边界

以下约束优先级高于功能便利性：

- 禁止主网、真实资金、真实产权转移或公开生产运行，除非另有书面 go/no-go。
- 当前阶段禁止 ArtFi 自营交易所。ArtFi 可以把用户意图实时提交给已批准外部市场并接收其结果，
  但不得成为订单簿、交易对手方、经纪自营方、撮合方、托管方、履约方或结算方；订单、签名、
  成交与取消的权威记录必须归属外部市场。
- `ArtFiMarket` 可保留为安全回归候选代码，但不得出现在当前部署脚本、发布清单、路由、
  功能开关或用户操作流中。
- OpenSea Stream 的主网只读镜像与 Sepolia NFT 发现是两个独立证据轨道，不得互相替代。
- 核心 DApp 使用标准外部钱包；本机只读 Sepolia 测试签名器严格留在仓库外，Stage 5 浏览器钱包仍是独立、单独门禁的产品。
- 官方 ArtCCH Logo 必须直接使用获批 VI 资产，不得描摹、重绘或生成替代 Logo。
- 产品名称为 `ArtCCH:ArtFi`；Bazaar 仅是组合参考，不得显示为本产品或合作方。
- 所有测试夹具、估值、Treasury、治理和市场值必须明确标示为示例、测试或只读数据。

## 4. 核心用户旅程

### J-01 浏览与溯源

用户可从 Overview 进入项目、市场镜像、作品详情、Wallet 和 DAO；在任何涉及价值的动作前
看到作品、作者、媒介、来源、权利状态、链、合约和数据来源。

### J-02 外部钱包

兼容 EIP-1193 的外部钱包完成连接、断开、重连、账户变化和网络验证。错误网络和未连接状态
不得发起写交易；钱包一次性 nonce 签名可用于证明控制权，但不得证明产权、版权、税务居民或
投资者合规资格。任何私钥均不得进入 Web、API、MySQL、服务器或 CI。

### J-03 RWA 与测试 NFT

经授权用户创建作品记录、提交权利和来源字段、上传经校验媒体、生成可复现元数据，审阅
交易意图后由外部钱包在 Sepolia 确认铸造。失败、拒签、重试和回执必须可解释、可恢复。

### J-04 Vault、份额化和 DAO

Vault 持续托管底层 ERC-721；份额代币余额决定成员资格，ERC20Votes 历史快照决定提案和投票权。
分类阈值及 selector 绑定必须在 Governor 中执行，Timelock 是唯一 action executor；ArtCCH 不具有
投票、管理员覆盖或单方执行权。真实收购结算、自动扣款与强制平仓保持不可执行。

### J-05 外部市场镜像

用户查看已批准来源的 listing、offer、sale、transfer、cancel 和通知。每条记录显示来源、时间、
新鲜度和外部深链。用户可在 ArtFi UI 实时发起外部市场交易意图并接收 accepted/rejected/
pending/confirmed/failed/cancelled 状态；任何订单建立、签名验证、撮合、履约和结算均由已批准
外部市场完成，ArtFi 只做来源明确、可审计、幂等的编排和结果展示。

## 5. 功能需求与验收条件

### 5.1 Web 与品牌

| ID      | 强制需求                                                                                                                 | Claude Code 验收条件                                                                                                                                                                                                                            |
| ------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WEB-001 | 提供 Overview、projects、project detail、RWA market、fractional market、asset detail、portfolio、NFT control 和 DAO 路由 | 路由可渲染；NFT control 同页切换 ERC-721/1155；桌面与移动布局无水平溢出；加载、空、错误和门禁状态可达；自动化覆盖代表路由                                                                                                                       |
| WEB-002 | 提供搜索、状态过滤、稳定排序和确定性分页                                                                                 | 查询参数/API 测试覆盖空结果、非法参数、边界页、稳定游标或稳定 offset；UI 不把静态标签冒充可用筛选器                                                                                                                                             |
| WEB-003 | 严格使用 ArtCCH VI                                                                                                       | Logo 来自批准资产；全局品牌为 `ArtCCH:ArtFi`；Bazaar 不出现在面向用户文案；Giraffe 只在页脚技术支持署名                                                                                                                                         |
| WEB-004 | 响应式、可访问和无误导文案                                                                                               | 代表路由在桌面和移动端通过；Axe 无 serious/critical；键盘可操作；颜色对比符合 WCAG 2 AA；外部交易入口必须明确 OpenSea/Seaport 是执行方，ArtFi 不自营订单、撮合、托管或结算                                                                      |
| WEB-005 | 明确测试及执行边界                                                                                                       | 全局可见 Sepolia 测试写入、no-custody 和 external-market-execution-only 状态；交易计划默认双重关闭；夹具不得使用“实时成交”措辞，运行时市场目录只能来自带来源和观察时间的外部事件                                                                |
| WEB-006 | 全站 EN/简/繁/FR/ES/DE/한/日语言转换                                                                                     | 每个页面共享不撑宽页眉的八语简标控件并提供完整无障碍语言名；FR/ES/DE/KO/JA 只从权威英文翻译；AIVAN 专用 CTranslate2 模块是唯一生成器；繁中沿用 OpenCC；`qwen3.5:9b` 只能校对且失败时保留主译文；mock、Qwen 生成或跨语言二次翻译不得通过生产验收 |

### 5.2 钱包与交易意图

| ID         | 强制需求                           | Claude Code 验收条件                                                                                                                                                                       |
| ---------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| WALLET-001 | RainbowKit/Wagmi/Viem 外部钱包连接 | 覆盖连接、断开、重连、账户变化、拒绝连接和合约钱包验证；仅标准外部 provider 可签名，私钥不得进入应用或服务器                                                                               |
| WALLET-002 | 链与用途强制执行                   | 铸造、Vault 和 DAO 写入仅允许 `11155111`；外部市场 fulfillment 仅在独立双重开关、批准来源和严格交易计划校验后使用其权威链；切链失败有明确错误；合约地址来自部署/外部市场证据而非组件硬编码 |
| WALLET-003 | 非托管和交易预览                   | Web/API 不接收助记词或私钥；签名前展示目标合约、方法、链、资产、金额和风险；拒签和失败不会生成虚假成功记录                                                                                 |
| WALLET-004 | NFT 加入钱包与 DAO 链接            | 铸造确认后展示并可复制 ERC-721/1155 的标准、合约、Token ID 和数量供外部钱包导入；导入只改变钱包显示，不转移/授权/授予 DAO 权利；DAO 入口继续验证钱包控制、Vault 托管和 RWA 份额余额        |

### 5.3 RWA、元数据与 NFT

| ID          | 强制需求                           | Claude Code 验收条件                                                                                                                                                                                                                                    |
| ----------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RWA-001     | 作品、所有权、来源、权利和媒体记录 | 必填字段、MIME、大小、内容哈希、重复、损坏和未授权上传测试通过；对象存储访问策略与生命周期有证据                                                                                                                                                        |
| RWA-002     | 可复现、不可变的 NFT 元数据        | 从持久化记录可重建相同元数据和哈希；媒体/元数据 URL 可公开读取但不能静默变更；含测试网及无真实产权转移声明                                                                                                                                              |
| RWA-003     | ERC-721/1155 控制页与铸造          | 同一管理页明确选择标准；ERC-721 保留 registrar/BFF/receipt 安全链；ERC-1155 在启用签名前验证 series creator、pause、100 份、0.01 ETH 和 no-preview 边界，确认后必须精确匹配事件并复核 totalSupply/recipient balance；未授权、重复承诺和失败不得显示成功 |
| RWA-004     | 全部已铸造 NFT 的独立 UI 目录      | 从 canonical Sepolia `AssetCreated/SeriesCreated` 事件投影 ERC-721/1155；按稳定页显示标准、合约、Token ID、区块、receipt 和观察时间；不得依赖 OpenSea 索引完成，也不得以 fixture 补空                                                                   |
| RIGHTS-001  | 权利证据是铸造硬门禁               | 缺少权利主体、授权范围、期限、地域、署名、下架流程或哈希绑定时必须拒绝铸造包；隐私协议不得提交 Git                                                                                                                                                      |
| CHARITY-001 | 首批固定慈善版供应                 | `UNIT-A01/04/05/11/14/15/16/17/20/21/22/23/24` 共 13 件；重复 A16 只计一次；每件一个 ERC-1155 token ID，一次性铸造且永远固定 100 枚，记录单价 `0.01 ETH`；不存在追加铸造或外部销毁入口                                                                  |
| CHARITY-002 | 私密原图和唯一持有人权益           | 公共 metadata 无作品 `image`/预览；任何网站不得提供无水印高清图；唯一权益为持币校验后的高清有水印下载且不提供浏览器预览；master 与 holder 文件必须哈希不同                                                                                              |
| CHARITY-003 | CCHS 收益和收据边界                | 100% 初始发行收益指向 CCHS 确认钱包；持有人直接联系 CCHS；ArtFi 不开票、不决定或承诺 eligible amount；CCHS 收据估值政策锁定为捐赠日、CCHS 批准公开来源的 `ETH/CAD` 公允市场价并保留日期、价格、来源和快照哈希，缺少 CCHS 书面确认时 fail closed         |
| CHARITY-004 | 实物映射和售罄后捐赠               | NFT 不传递实物所有权、占有、赎回、版权、复制或商业使用权；原发行钱包余额为 0 且外部售罄证据完成后才可记录售罄；仅售罄后才可记录 CCHS 实物捐赠接收证据                                                                                                   |

### 5.4 Vault、份额化与治理

| ID      | 强制需求                        | Claude Code 验收条件                                                                                                                                          |
| ------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DAO-001 | 创建 DAO/Vault                  | 保留原 UI 四步意图；名称、角色、资产归属和 factory creator 实时校验；`VaultCreated` 精确匹配并持久化 submission；重复请求幂等                                 |
| DAO-002 | NFT approve、deposit 与 custody | 只允许 exact-token `approve`，禁止 UI 请求 `setApprovalForAll`；deposit 独立签名且 receipt 与 `ownerOf(vault)` 双重确认；重放、暂停和恢复测试通过             |
| DAO-003 | 配置并发行份额代币              | symbol、supply、decimals、recipient 有界；必须先确认 Vault 持续托管，再独立签名 fractionalize 并精确匹配固定 supply/recipient/token 事件；fuzz/invariant 通过 |
| GOV-001 | 提案、投票、Timelock 和执行     | 仅分类提案可进入 Governor；Timelock 是唯一 action executor；历史 checkpoint、投票、排队和执行失败有测试                                                       |
| GOV-002 | RWA 验权与持有人自治            | 钱包一次性签名证明控制权；Vault 托管检查与份额余额决定成员资格，历史快照决定提案/投票权；ArtCCH 无投票、管理员覆盖或单方执行权                                |
| GOV-003 | 分层阈值与防降级                | 总快照供应量口径下达到 10% 可提案；市场迁移严格 `>50%`、实物事项严格 `>66.6667%`、全面收购严格 `>80%`；selector 与类别绑定                                    |
| GOV-004 | 收购价格证据                    | `T0..T-30` 成交量加权均价或 30 日无交易时最近 10 笔实际成交加权均价必须由非零独立 verifier 和证据哈希验证；失败必须回滚                                       |
| GOV-005 | 下链费用与强平门禁              | 仅记录证据绑定的费用分摊决定；自动扣款、强制平仓和真实收购结算保持不可执行，直至细则、通知/争议机制、BC 法律审查、新审计和单独上线批准                        |

### 5.5 外部市场镜像

| ID         | 强制需求                               | Claude Code 验收条件                                                                                                                                                                  |
| ---------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MARKET-001 | ArtFi 自营订单、出价、撮合、认领和结算 | 当前状态必须为 `GATED`；任何可部署或可达实现均为 `P0 / FAIL`                                                                                                                          |
| MARKET-002 | 版本化的已批准市场适配器               | `MarketplaceAdapter` 明确 backfill/realtime 生命周期、schema version、原始载荷和来源版本；来源必须在 allowlist                                                                        |
| MARKET-003 | OpenSea 实时流与 REST 补洞             | 重复、乱序、断线、重连、缺口、旧版本、取消后成交和成交后旧 listing 测试收敛到唯一正确状态                                                                                             |
| MARKET-004 | 镜像 API、实时交易编排和外部深链       | API 能读取活动；可把幂等交易意图提交至已批准外部市场并接收状态/回执，但不能自建订单簿、作为交易对手、撮合、托管、履约或结算；每条记录保留外部市场、订单 ID、时间、新鲜度和 HTTPS 深链 |
| MARKET-005 | 数据陈述准确                           | 本地 fixtures 明确标示；只有实际连接适配器并提供观察时间/新鲜度时才可称“实时”；OpenSea Stream 主网事件不得声称是 Sepolia Stream                                                       |
| MARKET-006 | 实时结果状态机与对账                   | initiated/awaiting-wallet/submitted/accepted/rejected/pending/confirmed/failed/cancelled 有明确状态机；断线、重试、重复提交、外部取消、链重组和回调乱序最终与外部市场权威状态收敛     |

### 5.6 API、数据与存储

| ID        | 强制需求                           | Claude Code 验收条件                                                                                                                                                                                              |
| --------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API-001   | Go API、OpenAPI 3.1 和统一错误契约 | health/config/catalog/portfolio/CORS/problem response/request ID 测试通过；生成客户端与 OpenAPI 无漂移                                                                                                            |
| API-002   | 默认拒绝的认证和 RBAC              | public、operator、indexer 权限分离；管理员钱包签名和链上 `REGISTRAR_ROLE` 复核后才能取得短时 HttpOnly 会话；后台 bearer 仅由同源、路径限缩的服务端网关注入；缺失/过期/错误角色均拒绝；不得用前端隐藏代替 API 授权 |
| DATA-001  | MySQL 8.4 为离链业务权威记录       | Stage 迁移可正向、回滚和重放；约束、事务、幂等和重启恢复测试通过；不得用内存 fixtures 冒充持久化交付                                                                                                              |
| DATA-002  | Redis 缓存与失效                   | key/version/TTL 有界；写后失效、竞争和 Redis 不可用模式有测试；缓存不得成为所有权或供应量权威来源                                                                                                                 |
| STORE-001 | R2 兼容对象存储                    | 完整性哈希、访问控制、不可变引用、失败恢复和生命周期测试通过；仓库不包含真实私密证据文件                                                                                                                          |
| INDEX-001 | 链事件索引和重组恢复               | 使用 chain/tx/log 唯一身份；重复、removed log、replacement、confirmations、restart 和任意精度余额重建测试通过                                                                                                     |

### 5.7 合约、安全、合规与运维

| ID           | 强制需求                          | Claude Code 验收条件                                                                                                                               |
| ------------ | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| CONTRACT-001 | NFT factory 与 asset contracts    | unit、failure、authorization、fuzz、invariant、size、pause 和 deployment simulation 通过；低于 EIP-170/EIP-3860 限制                               |
| CONTRACT-002 | Vault 与 fractional contracts     | custody、fixed supply、roles、replay、pause、recovery、fuzz 和 invariant 通过；无未记录 EOA 特权                                                   |
| EXT-001      | 独立浏览器钱包 Alpha              | 加密本地 vault、权限、确认、网络、钓鱼和恢复测试可存在，但在独立审查和商店批准前保持 `GATED`；不得阻塞核心 DApp                                    |
| SEC-001      | 应用与会话安全                    | 威胁模型、输入校验、RBAC、CSP/安全头、依赖/secret 扫描和负面测试存在；生产 OIDC 未批准时 fail closed                                               |
| SEC-002      | 独立安全审计                      | 审计、整改和复测必须绑定同一发布 commit/address/bytecode；缺失时保持 `GATED`，不得称 production ready                                              |
| COMP-001     | KYC/KYB、AML/制裁、司法辖区和隐私 | policy/schema 可实现，但提供商和法律批准前 fail closed；缺少身份或资格不得接受价值                                                                 |
| COMP-002     | 产权、托管、估值、赎回和争议      | 每项有责任人、证据、时效和异常流程；获批运营模式缺失时保持 `GATED`                                                                                 |
| OPS-001      | CI/CD、监控、备份和回滚           | 构建可复现；日志/指标/告警、备份恢复、发布清单和回滚演练有证据；部署产物映射不可变 commit/digest                                                   |
| OPS-002      | 秘密与供应链                      | Git 中无 secret、keystore、密码、签名交易或私密证据；依赖锁定；SBOM、来源和扫描结果绑定发布候选                                                    |
| OPS-003      | AIVAN 客服/运维助手               | `qwen3.5:9b` 仅经独立的认证、RBAC、限流、审计和人工批准接口提供客服/运维辅助；不得生成翻译、签署交易、直接修改基础设施、泄露个人数据或绕过人工批准 |

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

P0 执行拓扑：所有自动化/运维性质的公链 RPC、部署、receipt、indexer、Etherscan 和 OpenSea
调用只能从新加坡（SIN）执行区发起。abcdyi 只做离线 build/test/package，AIVAN 只做翻译与
Qwen 校对，CTYun API/MySQL 只接收规范化证据与业务数据。仓库不得提供可用的 RPC 默认值；
非 SIN 环境必须在任何网络请求前 fail closed。完整方案见
`docs/SEPOLIA_ETHEREUM_COMPATIBILITY_PLAN.md`。

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
- 发现探针必须先读取 OpenSea 当时的 supported-chains，再查询精确 collection/token；结果只允许
  `discovered`、`not-found`、`unsupported-chain`，并持久化观察时间、上游状态及响应摘要。只有
  精确 token 标识匹配的 `discovered` 才能生成 OpenSea 验证链接。
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
- 收据估值以捐赠日公开市场 `ETH/CAD` 公允价值为产品记录基准。只有 CCHS 可以依据适用法律
  确定赠与发生日期、估值方法、holder advantage 和 eligible amount 并签发收据。ArtFi 只能
  保存或展示 CCHS 批准的来源、日期、汇率和快照证据。

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
