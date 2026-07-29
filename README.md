# Takealot ERP Backend

Railway-ready Node.js backend for the Takealot ERP.

## Railway variables

Add these variables to the backend service:

```text
TAKEALOT_API_BASE_URL=https://marketplace-api.takealot.com/v1
TAKEALOT_API_KEY=<your current Takealot API key>
TAKEALOT_WEBHOOK_SECRET=<your Takealot webhook secret>
FRONTEND_URL=https://takealot-erp.erosbloom.chatgpt.site
DATABASE_URL=${{Postgres.DATABASE_URL}}
```

Do not commit real secrets to GitHub.

## Endpoints

- `GET /health` — makes a real authenticated request to `/seller`
- `GET /api/takealot/health`
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
