const stripTrailingSlash = (value) => value.replace(/\/+$/, "");

export function getConfig(env = process.env) {
  return {
    port: Number(env.PORT || 3000),
    apiBaseUrl: stripTrailingSlash(
      env.TAKEALOT_API_BASE_URL || "https://marketplace-api.takealot.com/v1",
    ),
    apiKey: env.TAKEALOT_API_KEY || "",
    webhookSecret: env.TAKEALOT_WEBHOOK_SECRET || "",
    frontendUrl: env.FRONTEND_URL || "",
    databaseUrl: env.DATABASE_URL || "",
  };
}

export function missingRequiredConfig(config) {
  return [
    ["TAKEALOT_API_KEY", config.apiKey],
    ["TAKEALOT_WEBHOOK_SECRET", config.webhookSecret],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
}
