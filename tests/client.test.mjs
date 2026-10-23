import assert from "node:assert/strict";
import test from "node:test";
import { createReportsClient, createHttpReportsTransport, ReportsError, ReportsTransportError, reportLimits } from "../dist/index.js";
import { collectReportContext, readReportImage } from "../dist/browser.js";

const submissionId = "d5555555-5555-4555-8555-555555555555";
const timestamp = "2026-10-22T12:00:00.000Z";
const receipt = (id = submissionId, status = "accepted") => ({ submissionId: id, reportId: "REP-23", documentId: 18, receivedAt: timestamp, status });
const json = value => Response.json(value);
const deferred = () => {
  let resolve;
  const promise = new Promise(complete => { resolve = complete; });
  return { promise, resolve };
};
function clientFor(context, options) {
  const client = createReportsClient({ createId: () => submissionId, now: () => Date.parse(timestamp), ...options });
  context.after(() => client.dispose());
  return client;
}

test("construction and preparation perform no request and snapshots contain no submitted text", context => {
  let calls = 0;
  const client = clientFor(context, { transport: async () => { calls += 1; return receipt(); } });
  assert.equal(client.getSnapshot().phase, "idle");
  assert.equal(client.prepare({ message: "private report" }), submissionId);
  assert.equal(calls, 0);
  assert.equal(client.getSnapshot().phase, "prepared");
  assert.equal(JSON.stringify(client.getSnapshot()).includes("private report"), false);
  assert.throws(() => client.prepare({ message: "second" }), { code: "REPORT_PENDING" });
});

test("one frozen command is deduplicated and acknowledged by the matching server receipt", async context => {
  const pending = deferred();
  let received;
  let calls = 0;
  const client = clientFor(context, { transport: async submission => { calls += 1; received = submission; return pending.promise; } });
  const input = { message: "something happened", context: { pathname: "/settings?token=secret#private", capturedAt: timestamp, viewport: { width: 800, height: 600 } } };
  client.prepare(input);
  input.message = "mutated";
  input.context.viewport.width = 2;
  const first = client.send();
  assert.equal(client.send(), first);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(received.message, "something happened");
  assert.equal(received.context.pathname, "/settings");
  assert.equal(received.context.viewport.width, 800);
  assert.equal(Object.isFrozen(received.context.viewport), true);
  pending.resolve(receipt());
  assert.equal((await first).status, "accepted");
  assert.equal(client.getSnapshot().receipt.reportId, "REP-23");
  assert.equal((await client.send()).status, "accepted");
  assert.equal(calls, 1);
});

test("lost ACK requires explicit retry with the exact same submission", async context => {
  const bodies = [];
  const client = clientFor(context, { transport: async submission => {
    bodies.push(JSON.stringify(submission));
    if (bodies.length === 1) throw new Error("connection reset");
    return receipt(submissionId, "duplicate");
  } });
  client.prepare({ message: "retry safely" });
  assert.equal((await client.send()).status, "uncertain");
  assert.equal(bodies.length, 1);
  assert.equal((await client.send()).status, "not-ready");
  assert.equal((await client.retry()).status, "accepted");
  assert.equal(bodies[0], bodies[1]);
  assert.equal(client.getSnapshot().receipt.status, "duplicate");
});

test("mutating client options cannot redirect a prepared retry to a different receiver", async context => {
  let originalCalls = 0;
  let redirectedCalls = 0;
  const options = { transport: async () => {
    originalCalls += 1;
    if (originalCalls === 1) throw new Error("lost ACK");
    return receipt(submissionId, "duplicate");
  }, createId: () => submissionId };
  const client = createReportsClient(options);
  context.after(() => client.dispose());
  client.prepare({ message: "keep receiver" });
  await client.send();
  options.transport = async () => { redirectedCalls += 1; return receipt(); };
  assert.equal((await client.retry()).status, "accepted");
  assert.equal(originalCalls, 2);
  assert.equal(redirectedCalls, 0);
});

for (const invalid of [{}, { ...receipt(), submissionId: "another" }, { ...receipt(), reportId: "23" }, { ...receipt(), documentId: 0 }, { ...receipt(), receivedAt: "2026-02-31T12:00:00Z" }, { ...receipt(), status: "queued" }]) {
  test(`invalid acknowledgement stays uncertain: ${JSON.stringify(invalid)}`, async context => {
    const client = clientFor(context, { transport: async () => invalid });
    client.prepare({ message: "check ACK" });
    assert.equal((await client.send()).status, "uncertain");
    assert.equal(client.getSnapshot().receipt, null);
  });
}

test("cancel fences a late transport and a fresh command remains unchanged", async context => {
  const pending = deferred();
  let signal;
  const client = clientFor(context, { transport: async (_submission, options) => { signal = options.signal; return pending.promise; } });
  client.prepare({ message: "first" });
  const request = client.send();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(client.cancel(), "may-have-been-sent");
  assert.equal(signal.aborted, true);
  client.prepare({ message: "second" });
  pending.resolve(receipt());
  assert.equal((await request).status, "stale");
  assert.equal(client.getSnapshot().phase, "prepared");
});

test("cancel before dispatch does not invoke the receiver", async context => {
  let calls = 0;
  const client = clientFor(context, { transport: async () => { calls += 1; return receipt(); } });
  client.prepare({ message: "cancel immediately" });
  const request = client.send();
  assert.equal(client.cancel(), "not-sent");
  assert.equal((await request).status, "stale");
  assert.equal(calls, 0);
});

test("timeout settles even when an injected receiver ignores abort", async context => {
  const client = clientFor(context, { timeoutMs: 5, transport: () => new Promise(() => {}) });
  client.prepare({ message: "never resolve" });
  assert.equal((await client.send()).status, "uncertain");
});

test("rate limit blocks retry until the receiver's retry time", async context => {
  let now = Date.parse(timestamp);
  let calls = 0;
  const client = clientFor(context, { now: () => now, transport: async () => {
    calls += 1;
    if (calls === 1) throw new ReportsTransportError("RATE_LIMITED", 429, now + 1000);
    return receipt();
  } });
  client.prepare({ message: "rate limit" });
  assert.equal((await client.send()).status, "retry-later");
  assert.equal((await client.retry()).status, "retry-later");
  assert.equal(calls, 1);
  now += 1000;
  assert.equal((await client.retry()).status, "accepted");
});

test("conflicts are rejected without an automatic overwrite or retry", async context => {
  const client = clientFor(context, { transport: async () => { throw new ReportsTransportError("SUBMISSION_CONFLICT", 409); } });
  client.prepare({ message: "conflict" });
  assert.equal((await client.send()).status, "rejected");
  assert.equal((await client.retry()).status, "not-ready");
  assert.equal(client.getSnapshot().errorCode, "SUBMISSION_CONFLICT");
});

test("dispose aborts requests, drops snapshots and prevents preparation", async context => {
  const client = clientFor(context, { transport: () => new Promise(() => {}) });
  client.prepare({ message: "dispose" });
  const pending = client.send();
  client.dispose();
  assert.equal((await pending).status, "stale");
  assert.equal(client.getSnapshot().phase, "disposed");
  assert.equal(client.getSnapshot().submissionId, null);
  assert.throws(() => client.prepare({ message: "no" }), { code: "CLIENT_DISPOSED" });
});

test("validation uses UTF-8 limits and strips query, fragment and unknown metadata", async context => {
  let received;
  const client = clientFor(context, { transport: async submission => { received = submission; return receipt(); } });
  assert.throws(() => client.prepare({ message: "💥".repeat(1025) }), { code: "INVALID_MESSAGE" });
  assert.throws(() => client.prepare({ message: " " }), { code: "INVALID_MESSAGE" });
  assert.throws(() => client.prepare({ message: "valid", context: { capturedAt: timestamp, pathname: "//evil.example" } }), { code: "INVALID_PATHNAME" });
  client.prepare({ message: "💥".repeat(1024), token: "secret", context: { capturedAt: timestamp, pathname: "/orders?secret=1#hash", accountId: "secret" } });
  await client.send();
  assert.equal(received.context.pathname, "/orders");
  assert.equal("token" in received, false);
  assert.equal("accountId" in received.context, false);
});

test("image helper validates type, decoded size and matching magic bytes", async () => {
  const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGxkAAAAASUVORK5CYII=";
  const png = new Blob([Buffer.from(data, "base64")], { type: "image/png" });
  assert.deepEqual(await readReportImage(png), { mediaType: "image/png", data });
  await assert.rejects(readReportImage(new Blob([Buffer.from("iVBORw0KGgo=", "base64")], { type: "image/png" })), ReportsError);
  await assert.rejects(readReportImage(new Blob(["invalid"], { type: "image/png" })), ReportsError);
  await assert.rejects(readReportImage(new Blob([new Uint8Array(reportLimits.imageBytes + 1)], { type: "image/png" })), ReportsError);
  await assert.rejects(readReportImage(new Blob(["<svg/>"], { type: "image/svg+xml" })), ReportsError);
  assert.equal(collectReportContext({ pathname: "/test?key=secret", now: () => Date.parse(timestamp) }).pathname, "/test");
});

test("an image at exactly 2 MiB fits while an oversized decoded image is rejected", context => {
  const bytes = Buffer.alloc(reportLimits.imageBytes);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.write("IHDR", 12, "ascii");
  const client = clientFor(context, { transport: async () => receipt() });
  assert.equal(client.prepare({ message: "maximum image", image: { mediaType: "image/png", data: bytes.toString("base64") } }), submissionId);
  client.cancel();
  const oversized = Buffer.concat([bytes, Buffer.from([0])]);
  assert.throws(() => client.prepare({ message: "oversized image", image: { mediaType: "image/png", data: oversized.toString("base64") } }), ReportsError);
  assert.throws(() => client.prepare({ message: "coerced media type", image: { mediaType: { toString: () => "image/png" }, data: bytes.toString("base64") } }), ReportsError);
});

test("HTTP transport sends an exact JSON command with no cookies and unwraps ACK", async context => {
  let request;
  const transport = createHttpReportsTransport({ endpoint: "https://receiver.example/reports", headers: () => ({ "X-Integration": "test" }), fetch: async (url, init) => { request = { url, init }; return json({ data: receipt() }); } });
  const client = clientFor(context, { transport });
  client.prepare({ message: "http" });
  assert.equal((await client.send()).status, "accepted");
  assert.equal(request.init.credentials, "omit");
  assert.equal(request.init.redirect, "error");
  assert.equal(request.init.headers.get("X-Integration"), "test");
  assert.equal(request.init.headers.has("Authorization"), false);
  assert.equal(JSON.parse(request.init.body).submissionId, submissionId);
});

test("HTTP configuration copies static headers and retains the selected fetch implementation", async context => {
  const receivedHeaders = [];
  const options = { endpoint: "/reports", headers: { "X-Receptor": "original" }, fetch: async (_url, init) => { receivedHeaders.push(init.headers.get("X-Receptor")); return json({ data: receipt() }); } };
  const transport = createHttpReportsTransport(options);
  options.headers["X-Receptor"] = "mutated";
  options.fetch = async () => { throw new Error("changed fetch"); };
  const client = clientFor(context, { transport });
  client.prepare({ message: "immutable config" });
  assert.equal((await client.send()).status, "accepted");
  assert.deepEqual(receivedHeaders, ["original"]);
});

for (const response of [() => new Response(null, { status: 204 }), () => new Response("invalid", { headers: { "Content-Type": "application/json" } }), () => json({ data: { ...receipt(), extra: "x".repeat(5000) } }), () => new Response(JSON.stringify({ data: receipt() }), { headers: { "Content-Type": "text/html" } })]) {
  test("HTTP malformed, missing or oversized ACK never becomes success", async context => {
    const client = clientFor(context, { transport: createHttpReportsTransport({ endpoint: "/reports", fetch: async () => response() }) });
    client.prepare({ message: "bad response" });
    assert.equal((await client.send()).status, "uncertain");
  });
}

test("HTTP receiver 429 observes Retry-After and 500 stays uncertain", async context => {
  const limited = clientFor(context, { transport: createHttpReportsTransport({ endpoint: "/reports", now: () => Date.parse(timestamp), fetch: async () => new Response(null, { status: 429, headers: { "Retry-After": "2" } }) }) });
  limited.prepare({ message: "limited" });
  await limited.send();
  assert.equal(limited.getSnapshot().retryAt, Date.parse(timestamp) + 2000);
  const failed = clientFor(context, { transport: createHttpReportsTransport({ endpoint: "/reports", fetch: async () => new Response(null, { status: 500 }) }) });
  failed.prepare({ message: "failed" });
  assert.equal((await failed.send()).status, "uncertain");
});

test("HTTP cancellation during headers cannot start a late fetch", async context => {
  const header = deferred();
  let calls = 0;
  const client = clientFor(context, { transport: createHttpReportsTransport({ endpoint: "/reports", headers: () => header.promise, fetch: async () => { calls += 1; return json({ data: receipt() }); } }) });
  client.prepare({ message: "cancel headers" });
  const pending = client.send();
  await Promise.resolve();
  await Promise.resolve();
  client.cancel();
  header.resolve({});
  assert.equal((await pending).status, "stale");
  assert.equal(calls, 0);
});
