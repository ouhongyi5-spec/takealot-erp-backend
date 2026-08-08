# Takealot ERP Backend

## V7.2.1 完整路径任务启动修复

- 修复完整路径候选已建立索引后仍被旧数组检查误判为空的问题。
- 根接口版本号同步为 `7.2.1`，便于部署后准确验收。
- 重算仍只处理未人工确认商品，不修改 Takealot 线上类目。

## V7.2 完整类目路径匹配

- 匹配候选从595个三级节点改为5,089条非图书完整上传路径，四级及更深节点全部参与判断。
- 兼容Takealot商品页隐藏一级类目的展示方式，例如 `Beauty / Hair Care / Wigs` 会补回并精确匹配 `Personal & Lifestyle / Beauty / Hair Care / Wigs`。
- 兼容卖家后台第三栏把深层节点合并为 `Hair Care -> Wigs` 的展示方式；箭头会被拆回真实层级。
- 完整路径、隐藏一级后的商品页路径或唯一末级类目精确命中时直接给出高置信度建议。
- ERP日常筛选仍可保持简洁，但推荐及人工确认结果会保存完整路径，不再丢失Wigs、Vacuum Sealers等第四级类目。
- 只重算未人工确认商品；不修改Takealot线上类目，不恢复新商品采集。

## V7.1 现有商品类目匹配

- 修正旧版 `remapped_count` 误报：只有人工确认后的当前三级类目才计入真实匹配数。
- 为12,207个现有商品生成非破坏性匹配建议；推荐类目不会覆盖原类目。
- 按95%以上、80%–94%、80%以下分为高置信度、待确认、待校准。
- 每个商品保留前三个候选类目、匹配依据和建议规则关键词。
- 人工确认后才写入 `current_category_id`；可选择保存安全的关键词规则供后续商品复用。
- 商品新增采集继续暂停，不修改Takealot线上商品类目。

## V7.0 三级标准类目库

- 自动导入从卖家后台 `Add to Takealot's Catalogue` 手动整理的完整类目文件。
- ERP筛选只显示一级、二级、三级；四级及更深路径在后台完整保留。
- Books分支保留但排除，Media下的Movies和Music继续使用。
- 保存资质限制及特殊类目标记，供后续商品分类与上传回溯。
- 新商品采集继续暂停，现有商品匹配需在类目验收后单独启动。

## V6.6 HTTP-first 跟卖竞价

- 跟卖检查和自动竞价优先直接请求 Takealot 公开 JSON 数据，不再为每个商品启动完整网页。
- HTTP 数据缺失、超时或受限时自动使用 Chromium 兜底，不改变卖家排名和竞价保护规则。
- Chromium 兜底队列空闲 60 秒后自动退出，释放常驻内存。
- `/health` 和 `/api/takealot/health` 返回采集模式、浏览器状态、队列长度及后端进程内存，便于上线前后对比。

## V6.1 商品页抓取与自动竞价优化

- 所有公开商品页请求共用单任务队列，避免 Railway Chromium 并发抢占资源。
- 自动竞价使用高优先级队列，可插入全店跟卖扫描之前执行。
- 禁用浏览器缓存并为每次商品页访问增加刷新参数，避免旧的 `304` 响应。
- 自动竞价只检查已启用规则的商品，调价后立即进行目标商品复查。
- 官方报价已经更新、但公开商品页尚未传播时，记录为等待公开确认，不再误判为无人跟卖。
- 全店扫描仍按“跟卖中、无人跟卖、请求受限、检查异常”的优先顺序执行。

## V6 自动竞价

- 每个商品可启用 5 或 10 分钟自动检查。
- 仅在本店排名不为第 1 且存在有效竞店报价时调价。
- 强制执行最低价、最高价、低于竞品金额与单次最大调价保护。
- 调价后自动复查公开商品页，并把最新售价、排名和竞店写回 PostgreSQL。
- Railway 进程独立调度，关闭 ERP 网页后仍会运行。

Railway-ready Node.js backend for the Takealot ERP.

## 跟卖监控采集

监控任务通过无头浏览器逐个打开 Takealot 商品页，读取页面实际加载的公开报价，默认每件商品间隔 8 秒。扫描顺序为：跟卖中、无人跟卖、请求受限、检查异常。若临时请求受限，数据库会保留上一次成功获取的竞争店铺和排名；ERP 改价仍只通过官方 Seller API 执行。

Railway 会自动使用根目录的 `Dockerfile` 安装 Chrome 运行所需依赖。首次构建耗时会比旧版本更长，属于正常现象。

## 跟卖监控

- `GET /api/takealot/resale-monitor`：读取当前店铺最新检测结果。
- `GET /api/takealot/resale-monitor?job_only=1`：仅读取当前店铺任务进度，供 ERP 跨页面持续显示。
- `POST /api/takealot/resale-monitor/run`：按所选范围立即检测；支持 `followed`、`clear`、`not_found`、`rate_limited`、`error`。
- 服务会在北京时间每天上午 10:00 自动复查“无人跟卖”和“公开报价列表中未找到本店铺”的商品。
- 同一店铺同时只允许一个检测任务；重复点击会返回正在运行的同一个任务，不会重新排队。
- 请为后端配置 `DATABASE_URL`，用于持久保存最新结果和每日历史；未配置时仅保存在内存中。

## Railway variables

Add these variables to the backend service:

```text
TAKEALOT_API_BASE_URL=https://marketplace-api.takealot.com/v1
TAKEALOT_API_KEY=<your current Takealot API key>
TAKEALOT_WEBHOOK_SECRET=<your Takealot webhook secret>
FRONTEND_URL=https://takealot-erp.erosbloom.chatgpt.site
DATABASE_URL=${{Postgres.DATABASE_URL}}
```

The existing `TAKEALOT_API_KEY` remains store 1. Add more stores with:

```text
TAKEALOT_STORE_2_API_KEY=<second store API key>
TAKEALOT_STORE_2_WEBHOOK_SECRET=<second store webhook secret>
TAKEALOT_STORE_3_API_KEY=<third store API key>
```

Store display names are loaded automatically from Takealot `/seller`.

Do not commit real secrets to GitHub.

## Endpoints

- `GET /health` — makes a real authenticated request to `/seller`
- `GET /api/takealot/health`
- `GET /api/takealot/stores` — list configured stores with API-provided names
- `GET /api/takealot/offers`
- `GET /api/takealot/sales`
- `GET /api/takealot/inventory`
- `PATCH /api/takealot/offers/:offerId` — update price, lead time, or seller warehouse stock
- `POST /api/takealot/sync`
- `POST /api/webhooks/takealot`
- `GET /api/events`

## Deploy

1. Upload all files in this package to the root of the GitHub repository.
2. Railway detects `package.json` and deploys the service.
3. Add the environment variables above.
4. Generate a Railway public domain for the backend service.
5. Open `/health`. A successful connection returns `"status": "connected"`.
