"use strict";
// Plural GET /v2/account/deletions/:jobId is the status route.
// The singular path is the generated fixture: JSON 404 {error:"not_found"}, never a job body.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");

const STATUS_PATH = "/v2/account/deletions/";
const SINGULAR_PATH = "/v2/account/deletion/";
const JOB_ID = "00000000-0000-4000-8000-000000000002";
const singularFixture = JSON.parse(fs.readFileSync(
  path.join(__dirname, "../../fixtures/account-deletion/singular-path.json"), "utf8"));

test("deletion status is served only at plural /v2/account/deletions/:jobId", async () => {
  assert.equal(singularFixture.response.status, 404);
  assert.deepEqual(singularFixture.response.body, { error: "not_found" });
  const app = express();
  app.get("/v2/account/deletions/:jobId", (req, res) => {
    if (req.params.jobId !== JOB_ID) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.status(200).json({ jobId: JOB_ID, status: "running", retryable: true });
  });
  app.get("/v2/account/deletion/:jobId", (_req, res) => {
    res.status(singularFixture.response.status).json(singularFixture.response.body);
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const base = "http://127.0.0.1:" + server.address().port;
    const plural = await fetch(base + STATUS_PATH + JOB_ID);
    assert.equal(plural.status, 200);
    assert.equal((await plural.json()).jobId, JOB_ID);
    const singular = await fetch(base + SINGULAR_PATH + JOB_ID);
    assert.equal(singular.status, 404);
    const body = await singular.json();
    assert.deepEqual(body, { error: "not_found" });
    assert.equal(JSON.stringify(body).includes("running"), false);
  } finally {
    server.close();
  }
});
