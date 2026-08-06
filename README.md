# Takealot ERP Backend

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
- `POST /api/takealot/resale-monitor/run`：立即检测全部可销售商品。
- 服务会在北京时间每天上午 10:00 自动检测所有已配置店铺。
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
