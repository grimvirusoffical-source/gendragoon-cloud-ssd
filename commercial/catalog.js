"use strict";

// Source prices are proposals, not proof of Stripe or service availability.
const pricing = require("./pricing.json");
const CURRENCY = pricing.currency;
const STATUS = pricing.status;
const ANNUAL_BILLING_MONTHS_CHARGED = pricing.annualBillingMonthsCharged;
const CATALOG_READY = false;

function requireCents(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid catalog price: ${field}`);
  }
  return value;
}

if (!Number.isSafeInteger(ANNUAL_BILLING_MONTHS_CHARGED) ||
    ANNUAL_BILLING_MONTHS_CHARGED < 1 || ANNUAL_BILLING_MONTHS_CHARGED > 12) {
  throw new Error("Invalid annual billing factor");
}

function priceFields(plan) {
  const monthlyCents = requireCents(plan.monthlyCents, `${plan.id ?? "workspace"}.monthlyCents`);
  const yearlyCents = requireCents(plan.yearlyCents, `${plan.id ?? "workspace"}.yearlyCents`);
  if (yearlyCents !== monthlyCents * ANNUAL_BILLING_MONTHS_CHARGED) {
    throw new Error("Catalog annual price does not match its billing factor");
  }
  return { monthlyCents, yearlyCents };
}

function indexPlans(plans, fields) {
  // A null prototype prevents inherited keys from becoming purchasable tiers.
  const result = Object.create(null);
  for (const plan of plans) {
    if (typeof plan.id !== "string" || !plan.id || Object.hasOwn(result, plan.id)) {
      throw new Error("Invalid or duplicate catalog tier");
    }
    result[plan.id] = Object.freeze({ id: plan.id, ...priceFields(plan), ...fields(plan) });
  }
  return Object.freeze(result);
}

const WORKSPACE = Object.freeze({
  ...priceFields(pricing.workspace),
  requiredForManagedStorage: pricing.workspace.requiredForManagedStorage,
  storageSubscriptionIncludesFee: pricing.workspace.storageSubscriptionIncludesFee,
});
const STORAGE = indexPlans(pricing.storage, plan => ({
  gb: plan.gb,
  // Compatibility with the existing triple-bundle calculator. No discount here.
  standard: plan.monthlyCents,
}));
const PERFORMANCE = indexPlans(pricing.performance, plan => ({
  workers: plan.workers,
  cents: plan.monthlyCents,
}));

function intervalPrice(plan, interval) {
  if (interval !== "month" && interval !== "year") {
    throw new Error("Invalid billing interval");
  }
  return interval === "year" ? plan.yearlyCents : plan.monthlyCents;
}

function planQuote(catalog, tier, interval, kind) {
  if (typeof tier !== "string" || !Object.hasOwn(catalog, tier)) {
    throw new Error(`Invalid ${kind} tier`);
  }
  const plan = catalog[tier];
  return Object.freeze({
    tier,
    kind,
    interval,
    currency: CURRENCY,
    priceCents: intervalPrice(plan, interval),
    available: CATALOG_READY,
    unavailableReason: "Checkout and service provisioning are not enabled.",
  });
}

function storageQuote(tier, interval = "month") {
  return Object.freeze({
    ...planQuote(STORAGE, tier, interval, "storage"),
    // Preserve the storage subscription contract in the authoritative manifest.
    // The separate, documented GPU triple bundle has its own workspace line.
    workspaceFeeIncluded: WORKSPACE.storageSubscriptionIncludesFee,
  });
}

function performanceQuote(tier, interval = "month") {
  return planQuote(PERFORMANCE, tier, interval, "performance");
}

function workspaceQuote(interval = "month") {
  return Object.freeze({
    kind: "workspace",
    interval,
    currency: CURRENCY,
    priceCents: intervalPrice(WORKSPACE, interval),
    available: CATALOG_READY,
    unavailableReason: "Checkout and service provisioning are not enabled.",
  });
}

module.exports = Object.freeze({
  CURRENCY, STATUS, ANNUAL_BILLING_MONTHS_CHARGED, CATALOG_READY,
  WORKSPACE, STORAGE, PERFORMANCE,
  storageQuote, performanceQuote, workspaceQuote,
});
