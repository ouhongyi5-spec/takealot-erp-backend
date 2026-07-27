import assert from "node:assert/strict";
import test from "node:test";
import { buildTakealotUrl } from "../src/takealot.js";
import { verifyWebhookSignature } from "../src/webhook.js";
import crypto from "node:crypto";

test("converts comma-separated fields into repeated query parameters", () => {
  const params = new URLSearchParams({
    fields: "offer_id,sku,title",
    limit: "100",
  });
  const url = buildTakealotUrl(
    "https://marketplace-api.takealot.com/v1",
    "offers",
    params,
  );

  assert.deepEqual(url.searchParams.getAll("fields"), ["offer_id", "sku", "title"]);
  assert.equal(url.searchParams.get("limit"), "100");
});

test("rejects unsupported resources", () => {
  assert.throws(
    () =>
      buildTakealotUrl(
        "https://marketplace-api.takealot.com/v1",
        "anything",
        new URLSearchParams(),
      ),
    /Unsupported/,
  );
});

test("validates Takealot webhook HMAC", () => {
  const body = Buffer.from('{"event":"Offer Updated"}');
  const secret = "test-secret";
  const signature = crypto.createHmac("sha256", secret).update(body).digest("hex");

  assert.equal(verifyWebhookSignature(body, secret, signature), true);
  assert.equal(verifyWebhookSignature(body, secret, "bad"), false);
});
