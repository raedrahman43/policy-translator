import assert from "assert";

import {
  bucketCount,
  bucketDuration,
  categorizeTelemetryError,
  TelemetryClient,
  telemetryAllowedForRequest,
} from "../telemetry/telemetryClient";

const receiver = require("../../infra/telemetry/function/TelemetryIngest/index.js") as (
  context: Record<string, any>,
  request: Record<string, any>,
) => Promise<void>;

async function testInactiveWithoutEndpoint(): Promise<void> {
  let calls = 0;
  const client = new TelemetryClient({
    enabled: true,
    fetchImpl: (async () => {
      calls++;
      return new Response(null, { status: 202 });
    }) as typeof fetch,
  });

  assert.equal(client.isConfigured(), false);
  assert.equal(await client.emit("app_started", { surface: "web-proto" }), false);
  assert.equal(calls, 0);
}

async function testOptOut(): Promise<void> {
  let calls = 0;
  const client = new TelemetryClient({
    endpoint: "https://telemetry.example.test/api/telemetry",
    enabled: false,
    fetchImpl: (async () => {
      calls++;
      return new Response(null, { status: 202 });
    }) as typeof fetch,
  });

  assert.equal(client.isConfigured(), true);
  assert.equal(client.isEnabled(), false);
  assert.equal(await client.emit("analysis_completed", {}), false);
  assert.equal(calls, 0);
}

async function testAllowlistedPayload(): Promise<void> {
  let captured: any;
  const client = new TelemetryClient({
    endpoint: "https://telemetry.example.test/api/telemetry",
    key: "test-key",
    enabled: true,
    sessionId: "11111111-1111-4111-8111-111111111111",
    appVersion: "1.2.3",
    now: () => new Date("2026-07-30T12:00:00.000Z"),
    fetchImpl: (async (_input, init) => {
      captured = {
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: JSON.parse(String(init?.body)),
      };
      return new Response(null, { status: 202 });
    }) as typeof fetch,
  });

  const delivered = await client.emit("analysis_completed", {
    surface: "web-proto",
    durationBucket: "1-3s",
    featureCountBucket: "11-25",
    gapCountBucket: "user@example.com raw tenant failure",
    tenantId: "should-not-leave-the-machine",
    policyName: "should-not-leave-the-machine",
    featureKey: "should-not-leave-the-machine",
  });

  assert.equal(delivered, true);
  assert.equal(captured.headers["x-functions-key"], "test-key");
  assert.equal(captured.body.eventName, "analysis_completed");
  assert.equal(captured.body.sessionId, "11111111-1111-4111-8111-111111111111");
  assert.deepEqual(captured.body.properties, {
    surface: "web-proto",
    durationBucket: "1-3s",
    featureCountBucket: "11-25",
  });
  assert.equal(JSON.stringify(captured.body).includes("should-not-leave-the-machine"), false);
}

async function testFailureIsNonBlocking(): Promise<void> {
  const client = new TelemetryClient({
    endpoint: "https://telemetry.example.test/api/telemetry",
    enabled: true,
    timeoutMs: 10,
    fetchImpl: (async () => {
      throw new Error("network unavailable");
    }) as typeof fetch,
  });

  assert.equal(await client.emit("app_started", { surface: "web-proto" }), false);
}

async function testReceiverValidation(): Promise<void> {
  const logs: string[] = [];
  const context: Record<string, any> = {
    log: (message: string) => logs.push(message),
  };
  await receiver(context, {
    body: {
      schemaVersion: 1,
      eventName: "analysis_completed",
      occurredAt: new Date().toISOString(),
      sessionId: "11111111-1111-4111-8111-111111111111",
      appVersion: "1.2.3",
      runtime: { platform: "win32", nodeMajor: "22" },
      properties: {
        surface: "web-proto",
        durationBucket: "1-3s",
        errorCategory: "user@example.com raw tenant failure",
        tenantId: "must-be-dropped",
      },
    },
  });
  assert.equal(context.res.status, 202);
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.includes("must-be-dropped"), false);
  assert.equal(logs[0]?.includes("user@example.com"), false);

  const invalidContext: Record<string, any> = { log: () => {} };
  await receiver(invalidContext, {
    body: {
      schemaVersion: 1,
      eventName: "policy_contents_uploaded",
      occurredAt: new Date().toISOString(),
      sessionId: "11111111-1111-4111-8111-111111111111",
    },
  });
  assert.equal(invalidContext.res.status, 400);
}

async function main(): Promise<void> {
  await testInactiveWithoutEndpoint();
  await testOptOut();
  await testAllowlistedPayload();
  await testFailureIsNonBlocking();
  await testReceiverValidation();

  assert.equal(bucketCount(0), "0");
  assert.equal(bucketCount(7), "6-10");
  assert.equal(bucketDuration(12_000), "10-30s");
  assert.equal(categorizeTelemetryError(new Error("Graph 403 permission denied")), "permission");
  assert.equal(categorizeTelemetryError(new Error("subscription is not licensed")), "licensing");
  assert.equal(telemetryAllowedForRequest("off"), false);
  assert.equal(telemetryAllowedForRequest("on"), true);
  assert.equal(telemetryAllowedForRequest(undefined), true);

  console.log("Telemetry regression: 5 checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
