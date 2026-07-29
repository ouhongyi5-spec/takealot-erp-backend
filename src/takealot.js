const ALLOWED_RESOURCES = new Set([
  "offers",
  "sales",
  "transactions",
  "shipments",
  "returns",
  "facilities",
  "seller",
]);

function appendQuery(target, sourceParams) {
  for (const [key, value] of sourceParams.entries()) {
    if (key === "fields" || key === "expands") {
      for (const item of value.split(",").map((part) => part.trim()).filter(Boolean)) {
        target.searchParams.append(key, item);
      }
    } else {
      target.searchParams.append(key, value);
    }
  }
}

export function buildTakealotUrl(baseUrl, resource, sourceParams = new URLSearchParams(), identifier = "") {
  if (!ALLOWED_RESOURCES.has(resource)) {
    throw new Error("Unsupported Takealot resource");
  }
  if (identifier && !/^\d+$/.test(identifier)) {
    throw new Error("Invalid Takealot resource identifier");
  }

  const url = new URL(`${baseUrl}/${resource}${identifier ? `/${identifier}` : ""}`);
  appendQuery(url, sourceParams);
  return url;
}

export async function takealotRequest(config, resource, options = {}) {
  if (!config.apiKey) {
    return {
      ok: false,
      status: 503,
      data: { error: "TAKEALOT_API_KEY is not configured" },
    };
  }

  const url = buildTakealotUrl(
    config.apiBaseUrl,
    resource,
    options.searchParams || new URLSearchParams(),
    options.identifier || "",
  );

  try {
    const response = await fetch(url, {
      method: options.method || "GET",
      headers: {
        "X-API-Key": config.apiKey,
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(20000),
    });

    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { message: text };
      }
    }

    return { ok: response.ok, status: response.status, data };
  } catch (error) {
    return {
      ok: false,
      status: 502,
      data: {
        error: "Unable to reach Takealot Marketplace API",
        detail: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
