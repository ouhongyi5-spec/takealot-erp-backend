const stripTrailingSlash = (value) => value.replace(/\/+$/, "");

function getStores(env) {
  const stores = [];
  for (let index = 1; index <= 20; index += 1) {
    const apiKey = env[`TAKEALOT_STORE_${index}_API_KEY`] || (index === 1 ? env.TAKEALOT_API_KEY : "");
    if (!apiKey) continue;
    stores.push({
      id: `store_${index}`,
      apiKey,
      webhookSecret: env[`TAKEALOT_STORE_${index}_WEBHOOK_SECRET`] || (index === 1 ? env.TAKEALOT_WEBHOOK_SECRET || "" : ""),
      fallbackName: env[`TAKEALOT_STORE_${index}_NAME`] || `店铺 ${index}`,
    });
  }
  return stores;
}

export function getConfig(env = process.env) {
  const stores = getStores(env);
  return {
    port: Number(env.PORT || 3000),
    apiBaseUrl: stripTrailingSlash(
      env.TAKEALOT_API_BASE_URL || "https://marketplace-api.takealot.com/v1",
    ),
    apiKey: env.TAKEALOT_API_KEY || "",
    webhookSecret: env.TAKEALOT_WEBHOOK_SECRET || "",
    frontendUrl: env.FRONTEND_URL || "",
    databaseUrl: env.DATABASE_URL || "",
    marketCollectionEnabled: env.MARKET_COLLECTION_ENABLED === "true",
    sellerCategoryUrl: env.TAKEALOT_SELLER_CATEGORY_URL || "",
    sellerCategoryCookie: env.TAKEALOT_SELLER_CATEGORY_COOKIE || "",
    sellerCategoryCsrfToken: env.TAKEALOT_SELLER_CATEGORY_CSRF_TOKEN || "",
    categoryAdminToken: env.CATEGORY_ADMIN_TOKEN || "",
    stores,
  };
}

export function missingRequiredConfig(config) {
  return [
    ["TAKEALOT_API_KEY", config.stores?.length || config.apiKey],
    ["TAKEALOT_WEBHOOK_SECRET", config.webhookSecret],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
}
