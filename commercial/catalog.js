"use strict";

// Approved prices (2026-10-19). They are not proof of Stripe or service availability.
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
    // The workspace fee is part of every storage plan; there is no separate line.
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

// Teams, the RedX Storage add-on and the master tiers (approved 2026-10-19).
// Each is validated with the same 10x yearly rule.
const TEAMS = indexPlans(pricing.teams.tiers, plan => ({ name: plan.name, members: plan.members }));
const TEAMS_ENTERPRISE = Object.freeze({ ...pricing.teams.enterprise });
const REDX_STORAGE = indexPlans(pricing.redxStorage.tiers, plan => ({ gb: plan.gb, downloadGbPerMonth: plan.downloadGbPerMonth }));
const REDX_DOWNLOAD_PACK = Object.freeze({ ...pricing.redxStorage.downloadPack,
  oneTimeCents: requireCents(pricing.redxStorage.downloadPack.oneTimeCents, "download_pack.oneTimeCents") });
const MASTER = indexPlans(pricing.masterTiers, plan => ({ name: plan.name, people: plan.people }));

function teamQuote(tier, interval = "month") {
  return planQuote(TEAMS, tier, interval, "team");
}

module.exports = Object.freeze({
  CURRENCY, STATUS, ANNUAL_BILLING_MONTHS_CHARGED, CATALOG_READY,
  WORKSPACE, STORAGE, PERFORMANCE, TEAMS, TEAMS_ENTERPRISE, REDX_STORAGE, REDX_DOWNLOAD_PACK, MASTER,
  storageQuote, performanceQuote, workspaceQuote, teamQuote,
});
