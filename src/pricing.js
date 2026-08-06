import { duePricingRules, listPricingRules, savePricingRule, updatePricingRuleResult } from "./database.js";
import { inspectSingleOffer } from "./resale.js";
import { takealotRequest } from "./takealot.js";

const locks = new Set();
const jobStates = new Map();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function storeById(config, storeId) {
  return config.stores.find((entry) => entry.id === storeId);
}

async function offerDetails(config, store, offerId) {
  const response = await takealotRequest({ ...config, apiKey: store.apiKey }, "offers", { identifier: String(offerId) });
  if (!response.ok) throw new Error(`报价读取失败 (${response.status})`);
  return response.data;
}

function targetPrice(rule, current, competitors) {
  const prices = competitors.map((entry) => Number(entry.price)).filter((price) => Number.isFinite(price) && price > 0);
  if (!prices.length) return null;
  const desired = Math.max(Number(rule.min_price), Math.min(Number(rule.max_price), Math.min(...prices) - Number(rule.undercut_by)));
  return Math.round(Math.max(current - Number(rule.max_change), Math.min(current + Number(rule.max_change), desired)));
}

export async function executePricingRule({ config, pool, rule, force = false }) {
  const key = `${rule.store_id}:${rule.offer_id}`;
  if (locks.has(key)) return { offer_id: rule.offer_id, status: "busy", adjusted: false, message: "该商品正在检查" };
  locks.add(key);
  try {
    const store = storeById(config, rule.store_id);
    if (!store) throw new Error("店铺配置不存在");
    const offer = await offerDetails(config, store, rule.offer_id);
    let inspected = await inspectSingleOffer({ config, pool, store, offer, retryDelays: [0, 4_000] });
    if (inspected.status === "error") throw new Error(inspected.error || "公开报价检查失败");
    const current = Number(inspected.own_price ?? offer.selling_price);
    if (!Number.isFinite(current)) throw new Error("无法取得本店最新售价");
    if (!force && inspected.own_rank === 1) {
      const outcome = { offer_id: rule.offer_id, status: "already_first", adjusted: false, price: current, rank: 1, item: inspected, message: `排名第1，保持 R ${current}` };
      await updatePricingRuleResult(pool, rule, outcome);
      return outcome;
    }
    const target = targetPrice(rule, current, inspected.competitors || []);
    if (target == null) {
      const outcome = { offer_id: rule.offer_id, status: "no_competitor", adjusted: false, price: current, rank: inspected.own_rank, item: inspected, message: "未发现其他卖家，未调价" };
      await updatePricingRuleResult(pool, rule, outcome);
      return outcome;
    }
    if (target === Math.round(current)) {
      const outcome = { offer_id: rule.offer_id, status: "protected", adjusted: false, price: current, rank: inspected.own_rank, item: inspected, message: `保护规则限制，保持 R ${current}` };
      await updatePricingRuleResult(pool, rule, outcome);
      return outcome;
    }
    const patch = await takealotRequest({ ...config, apiKey: store.apiKey }, "offers", { identifier: String(rule.offer_id), method: "PATCH", body: { selling_price: target } });
    if (!patch.ok) throw new Error(`Takealot 调价失败 (${patch.status}): ${JSON.stringify(patch.data).slice(0, 180)}`);

    // Takealot 商品页的公开报价存在传播延迟；短轮询确认，最终结果写回监控表。
    let publicConfirmed = false;
    let latestOffer = offer;
    for (const delay of [3_000, 7_000, 15_000]) {
      await sleep(delay);
      latestOffer = await offerDetails(config, store, rule.offer_id);
      try {
        const checked = await inspectSingleOffer({ config, pool, store, offer: latestOffer, retryDelays: [0] });
        if (checked.status !== "error") {
          inspected = checked;
          publicConfirmed = Number(checked.own_price) === target;
        }
      } catch {
        // The official offer endpoint remains the source of truth for the
        // completed write; the next scheduled check will refresh public rank.
      }
      if (publicConfirmed || Number(latestOffer.selling_price) === target) break;
    }
    const officialConfirmed = Number(latestOffer.selling_price) === target;
    const confirmedPrice = officialConfirmed ? target : (Number(inspected.own_price) || target);
    const outcome = {
      offer_id: rule.offer_id, status: publicConfirmed ? "adjusted" : "adjusted_pending_confirmation", adjusted: true, from: current, to: target,
      price: confirmedPrice, rank: inspected.own_rank, competitors: inspected.competitors, item: inspected,
      message: `R ${current} → R ${target}；${publicConfirmed ? `复查排名 ${inspected.own_rank ?? "待更新"}` : "官方报价已更新，公开排名等待同步"}`,
    };
    await updatePricingRuleResult(pool, rule, outcome);
    return outcome;
  } catch (error) {
    const outcome = { offer_id: rule.offer_id, status: "failed", adjusted: false, message: error instanceof Error ? error.message : String(error) };
    await updatePricingRuleResult(pool, rule, outcome);
    return outcome;
  } finally {
    locks.delete(key);
  }
}

export async function runEnabledPricing({ config, pool, storeId, dueOnly = false }) {
  const rules = dueOnly ? await duePricingRules(pool) : (await listPricingRules(pool, storeId)).filter((rule) => rule.enabled);
  const selected = storeId ? rules.filter((rule) => rule.store_id === storeId) : rules;
  const results = [];
  for (const rule of selected) results.push(await executePricingRule({ config, pool, rule }));
  return { ok: true, adjusted: results.filter((item) => item.adjusted).length, skipped: results.filter((item) => !item.adjusted).length, results };
}

export function pricingJob(storeId) {
  return jobStates.get(storeId) || { status: "idle" };
}

export function startEnabledPricing(args) {
  const existing = pricingJob(args.storeId);
  if (existing.status === "running") return existing;
  const started = { status: "running", started_at: new Date().toISOString() };
  jobStates.set(args.storeId, started);
  void runEnabledPricing(args).then((result) => {
    jobStates.set(args.storeId, { status: "completed", finished_at: new Date().toISOString(), ...result });
  }).catch((error) => {
    jobStates.set(args.storeId, { status: "failed", finished_at: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) });
  });
  return started;
}

export { listPricingRules, savePricingRule };
