#!/usr/bin/env node
"use strict";
// Local Teams backend for the SDK contract suites. It mounts the real Teams routes from a gendragoon-cloud-ssd
// checkout (feature/teams) over an in-memory Firestore and a Stripe double. Nothing leaves the machine.
//
//   GD_TEAMS_BACKEND=<cloud-ssd>/native/Backend node teams_dev_server.cjs [--exit-with-stdin]
//
// Prints one JSON line {"origin": "http://127.0.0.1:<port>"}. Accounts sign in with "Bearer dev-user:<uid>".
// POST /__dev/pay {"url": "<checkout url>"} completes a checkout as if Stripe had charged it.
const path = require("node:path"), crypto = require("node:crypto");
const dir = process.env.GD_TEAMS_BACKEND;
if (!dir) { console.error("set GD_TEAMS_BACKEND to the backend directory of a feature/teams checkout"); process.exit(2); }
const need = (m) => require(path.join(dir, m));
const express = need("node_modules/express"), Stripe = need("node_modules/stripe");
const { memoryFirestore } = need("test_firestore");
const { installedBilling, STRIPE_API_VERSION } = need("billing_gateway");

const hash = (uid) => crypto.createHash("sha256").update(uid).digest("hex");
const hookSecret = "whsec_localDevServerOnly0000";
// Placeholder price ids for the local Stripe double only; real prices are never used here.
const PRICES = {
  "team|team|month": "price_team", "team|team|year": "price_teamyr", "team|team_plus|month": "price_teamplus", "team|team_plus|year": "price_teamplusyr",
  "team|business|month": "price_biz", "team|business|year": "price_bizyr",
  "storage|standard|100GB|month": "price_100gb", "performance|boost|month": "price_boost", "performance|lite|month": "price_lite",
};
const AMOUNTS = { price_team: 999, price_teamyr: 9990, price_teamplus: 2499, price_teamplusyr: 24990, price_biz: 6999, price_bizyr: 69990, price_100gb: 640, price_boost: 600, price_lite: 300 };

const db = memoryFirestore([]);
const sessions = new Map(), subs = new Map();
let n = 0;
const verifier = new Stripe("sk_test_localDevServerOnly", { apiVersion: STRIPE_API_VERSION });
const stripe = {
  webhooks: verifier.webhooks,
  customers: { create: async (args) => ({ id: "cus_" + (args?.metadata?.gdAccountHash || "x").slice(0, 16) }) },
  checkout: { sessions: {
    create: async (args) => {
      const id = "cs_dev" + (++n);
      const s = { ...args, id, status: "open", url: "https://checkout.stripe.com/c/pay/" + id, amount_total: args.line_items.reduce((t, x) => t + (AMOUNTS[x.price] || 0), 0) };
      sessions.set(id, s);
      return structuredClone(s);
    },
    retrieve: async (id) => structuredClone(sessions.get(id)),
    expire: async (id) => { sessions.get(id).status = "expired"; return sessions.get(id); },
  } },
  subscriptions: { retrieve: async (id) => structuredClone(subs.get(id)), cancel: async (id) => { const s = subs.get(id); if (s) s.status = "canceled"; return s; } },
};

const app = express();
app.use("/v2", express.json());
app.use("/__dev", express.json());
const firebaseAuth = (req, res, next) => {
  const m = /^Bearer dev-user:([A-Za-z0-9_-]{1,64})$/.exec(req.headers.authorization || "");
  if (!m) return res.status(401).json({ error: "Sign in" });
  req.user = { uid: m[1] };
  next();
};
installedBilling({ app, db, bucket: null, stripeOverride: stripe, admin: { firestore: { FieldValue: { serverTimestamp: () => Date.now() } } }, firebaseAuth, accountKey: hash,
  env: { STRIPE_SECRET_KEY: "sk_test_localDevServerOnly", STRIPE_WEBHOOK_SECRET: hookSecret, STRIPE_CHECKOUT_ENABLED: "true", STRIPE_ENVIRONMENT: "test",
    PUBLIC_URL: "https://billing.example", STRIPE_PRICE_CATALOG_JSON: JSON.stringify(PRICES) } });

let origin = "";
app.post("/__dev/pay", async (req, res) => {
  const id = String(req.body?.url || "").split("/").pop();
  const s = sessions.get(id);
  if (!s) return res.status(404).json({ error: "unknown session" });
  const sub = { id: "sub_" + id, customer: s.customer, status: "active", metadata: s.metadata, items: { data: s.line_items.map((x) => ({ price: { id: x.price }, quantity: 1 })) } };
  subs.set(sub.id, sub);
  s.status = "complete";
  const payload = JSON.stringify({ id: "evt_" + crypto.randomBytes(8).toString("hex"), type: "customer.subscription.updated", api_version: STRIPE_API_VERSION, data: { object: sub } });
  const signature = verifier.webhooks.generateTestHeaderString({ payload, secret: hookSecret });
  const r = await fetch(origin + "/billing/stripe-webhook", { method: "POST", headers: { "Content-Type": "application/json", "Stripe-Signature": signature }, body: payload });
  res.status(r.status).json(await r.json());
});

const server = app.listen(0, "127.0.0.1", () => {
  origin = "http://127.0.0.1:" + server.address().port;
  process.stdout.write(JSON.stringify({ origin }) + "\n");
});
if (process.argv.includes("--exit-with-stdin")) {
  process.stdin.on("end", () => process.exit(0));
  process.stdin.resume();
}
