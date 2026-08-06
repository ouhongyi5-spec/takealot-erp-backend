# Takealot ERP Backend

Railway-ready Node.js backend for the Takealot ERP.

## 跟卖监控采集

监控任务通过无头浏览器逐个打开 Takealot 商品页，读取页面实际加载的公开报价，默认每件商品间隔 15 秒。扫描顺序为：跟卖中、无人跟卖、请求受限、检查异常。若临时请求受限，数据库会保留上一次成功获取的竞争店铺和排名；ERP 改价仍只通过官方 Seller API 执行。

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
