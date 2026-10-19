"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const pricing = require("./pricing.json");
const catalog = require("./catalog");
const { GPU, GPU_READY, gpuQuote, tripleBundleQuote, requireGpuProvisioned } = require("./gpu_catalog");

test("catalog derives every proposed price and capability from the manifest", () => {
  assert.equal(catalog.CURRENCY, pricing.currency);
  assert.equal(catalog.STATUS, pricing.status);
  assert.equal(catalog.ANNUAL_BILLING_MONTHS_CHARGED, pricing.annualBillingMonthsCharged);
  assert.deepEqual(Object.keys(catalog.STORAGE), pricing.storage.map(plan => plan.id));
  assert.deepEqual(Object.keys(catalog.PERFORMANCE), pricing.performance.map(plan => plan.id));
  for (const plan of pricing.storage) {
    assert.deepEqual(catalog.STORAGE[plan.id], {
      id: plan.id, monthlyCents: plan.monthlyCents, yearlyCents: plan.yearlyCents,
      gb: plan.gb, standard: plan.monthlyCents,
    });
  }
  for (const plan of pricing.performance) {
    assert.deepEqual(catalog.PERFORMANCE[plan.id], {
      id: plan.id, monthlyCents: plan.monthlyCents, yearlyCents: plan.yearlyCents,
      workers: plan.workers, cents: plan.monthlyCents,
    });
  }
  assert.deepEqual(catalog.WORKSPACE, pricing.workspace);
});

test("catalog and nested plans cannot be changed by a quote consumer", () => {
  assert.throws(() => { catalog.STORAGE["1TB"].standard = 1; }, TypeError);
  assert.throws(() => { catalog.PERFORMANCE.boost.cents = 1; }, TypeError);
  assert.throws(() => { catalog.WORKSPACE.monthlyCents = 1; }, TypeError);
  assert.throws(() => { GPU.spark.monthlyCents = 1; }, TypeError);
  assert.throws(() => { catalog.STORAGE.new = {}; }, TypeError);
  assert.throws(() => { catalog.CATALOG_READY = true; }, TypeError);
  assert.equal(Object.getPrototypeOf(catalog.STORAGE), null);
  assert.equal(Object.getPrototypeOf(catalog.PERFORMANCE), null);
});

test("storage and performance quote the exact interval price without another discount", () => {
  for (const [plans, quote] of [[pricing.storage, catalog.storageQuote], [pricing.performance, catalog.performanceQuote]]) {
    for (const plan of plans) {
      assert.equal(quote(plan.id).priceCents, plan.monthlyCents);
      assert.equal(quote(plan.id, "year").priceCents, plan.yearlyCents);
      assert.equal(quote(plan.id, "year").priceCents, quote(plan.id).priceCents * 10);
    }
  }
  assert.equal(catalog.workspaceQuote().priceCents, 0); // fee included in storage plans
  assert.equal(catalog.workspaceQuote("year").priceCents, 0);
  assert.equal(catalog.storageQuote("1TB").workspaceFeeIncluded, true);
  assert.equal(catalog.storageQuote("1TB").priceCents, 3600);
});

test("quote validation rejects unknown tiers, prototype names, coercion, and invalid intervals", () => {
  const invalidTiers = [undefined, null, 1, {}, ["1TB"], "", "missing", "__proto__", "constructor", "toString"];
  for (const tier of invalidTiers) {
    assert.throws(() => catalog.storageQuote(tier), /Invalid storage tier/);
    assert.throws(() => catalog.performanceQuote(tier), /Invalid performance tier/);
    assert.throws(() => gpuQuote(tier), /Invalid GPU tier or interval/);
  }
  for (const interval of [null, "annual", "monthly", "", 12, {}, ["month"]]) {
    assert.throws(() => catalog.storageQuote("1TB", interval), /Invalid billing interval/);
    assert.throws(() => catalog.performanceQuote("boost", interval), /Invalid billing interval/);
    assert.throws(() => catalog.workspaceQuote(interval), /Invalid billing interval/);
    assert.throws(() => gpuQuote("spark", interval), /Invalid GPU tier or interval/);
  }
});

test("GPU quotes retain exact prices and monthly credit/session caps on either interval", () => {
  for (const [tier, plan] of Object.entries(GPU)) {
    for (const interval of ["month", "year"]) {
      const quote = gpuQuote(tier, interval);
      assert.equal(quote.priceCents, plan.monthlyCents * (interval === "year" ? 10 : 1));
      assert.equal(quote.gpuMinutesPerMonth, plan.gpuMinutes);
      assert.equal(quote.maxSessionMinutes, plan.maxSessionMinutes);
      assert.equal(quote.hardware, "not assigned");
      assert.equal(quote.billingCap, true);
    }
  }
});

test("documented triple bundle works through the real catalog dependency", () => {
  const choice = { storageTier: "1TB", performanceTier: "boost", gpuTier: "spark" };
  const monthly = tripleBundleQuote(choice);
  const annual = tripleBundleQuote({ ...choice, interval: "year" });
  assert.equal(monthly.monthlyCents, 6390);
  assert.equal(monthly.totalCents, 6390);
  assert.equal(annual.monthlyCents, 6390);
  assert.equal(annual.totalCents, 63900);
  assert.equal(monthly.discountPercent, 10);
});

test("every triple combination applies one bundle discount and the annual factor once", () => {
  for (const storage of pricing.storage) {
    for (const performance of pricing.performance) {
      for (const [gpuTier, gpu] of Object.entries(GPU)) {
        const undiscounted = BigInt(storage.monthlyCents + pricing.workspace.monthlyCents + performance.monthlyCents + gpu.monthlyCents);
        const expectedMonthly = Number((undiscounted * 9n + 9n) / 10n);
        for (const interval of ["month", "year"]) {
          const quote = tripleBundleQuote({ storageTier: storage.id, performanceTier: performance.id, gpuTier, interval });
          assert.equal(quote.monthlyCents, expectedMonthly);
          assert.equal(quote.totalCents, expectedMonthly * (interval === "year" ? 10 : 1));
          assert.equal(quote.gpuMinutesPerMonth, gpu.gpuMinutes);
          assert.equal(quote.available, false);
        }
      }
    }
  }
});

test("future fractional-cent bundle discounts round up rather than reduce the margin", () => {
  // Exercise the shipped calculator with cent-valued catalog fixtures. Current
  // prices all divide evenly by ten, so they alone cannot cover this boundary.
  const source = fs.readFileSync(path.join(__dirname, "gpu_catalog.js"), "utf8");
  for (let cents = 0; cents < 20; cents++) {
    const sandbox = {
      module: { exports: {} },
      require: name => {
        assert.equal(name, "./catalog");
        return { STORAGE: { fixture: { standard: cents } }, PERFORMANCE: { fixture: { cents: 1 } } };
      },
    };
    vm.runInNewContext(source, sandbox, { filename: "gpu_catalog.js" });
    const quote = sandbox.module.exports.tripleBundleQuote({ storageTier: "fixture", performanceTier: "fixture", gpuTier: "spark" });
    const expected = Number((BigInt(cents + 1 + 2900) * 9n + 9n) / 10n);
    assert.equal(quote.monthlyCents, expected);
    assert.equal(quote.totalCents, expected);
  }
});

test("triple bundle rejects incomplete choices, unsupported modes, and invalid intervals", () => {
  const valid = { storageTier: "1TB", performanceTier: "boost", gpuTier: "spark" };
  for (const options of [undefined, null, [], "1TB", {}, { ...valid, storageMode: "archive" }, { ...valid, interval: "annual" }]) {
    assert.throws(() => tripleBundleQuote(options), /Invalid triple bundle/);
  }
  for (const key of ["storageTier", "performanceTier", "gpuTier"]) {
    for (const value of [null, {}, "missing", "__proto__", "constructor", "toString"]) {
      assert.throws(() => tripleBundleQuote({ ...valid, [key]: value }), /Invalid triple bundle/);
    }
  }
});

test("prelaunch quotes never imply that checkout or GPU provisioning is available", () => {
  assert.equal(catalog.CATALOG_READY, false);
  assert.equal(GPU_READY, false);
  for (const quote of [catalog.workspaceQuote(), catalog.storageQuote("1TB"), catalog.performanceQuote("boost"), gpuQuote("spark"), tripleBundleQuote({ storageTier: "1TB", performanceTier: "boost", gpuTier: "spark" })]) {
    assert.equal(quote.available, false);
  }
});

test("GPU entitlement requires active hardware and metering, not a purchased tier alone", () => {
  const valid = { gpuActive: true, gpuProvisioned: true, gpuMeteringActive: true, gpuTier: "spark" };
  assert.equal(requireGpuProvisioned(valid), GPU.spark);
  assert.throws(() => requireGpuProvisioned(undefined), /hardware or metering unavailable/);
  assert.throws(() => requireGpuProvisioned({ gpuTier: "spark" }), /hardware or metering unavailable/);
  for (const field of ["gpuActive", "gpuProvisioned", "gpuMeteringActive"]) {
    for (const value of [false, undefined, "true", 1]) {
      assert.throws(() => requireGpuProvisioned({ ...valid, [field]: value }), /hardware or metering unavailable/);
    }
  }
  for (const gpuTier of ["missing", "__proto__", "constructor", {}, null]) {
    assert.throws(() => requireGpuProvisioned({ ...valid, gpuTier }), /Invalid GPU entitlement/);
  }
});
