import crypto from "node:crypto";

function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function verifyWebhookSignature(rawBody, secret, providedSignature) {
  if (!secret || !providedSignature) return false;

  const calculated = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const normalized = providedSignature.replace(/^sha256=/i, "").trim().toLowerCase();
  return safeEqual(calculated.toLowerCase(), normalized);
}
