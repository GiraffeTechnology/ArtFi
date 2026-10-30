import { test } from "node:test";
import assert from "node:assert/strict";
import { renderCluster } from "./cluster-config.mjs";
const fixture = () => ({
  format: 1,
  purpose: "isolated-test",
  hostClass: "generic",
  runtimeDirectory: "/tmp/artfi-test",
  web: {
    listen: "127.0.0.1:34000",
    backends: ["127.0.0.1:34001", "127.0.0.1:34002"],
  },
  api: {
    listen: "127.0.0.1:34010",
    backends: ["127.0.0.1:34011", "127.0.0.1:34012"],
  },
});
test("renders separate fixed web/internal API pools with bounded passive failover", () => {
  const output = renderCluster(fixture());
  assert.match(output, /proxy_pass http:\/\/artfi_web/);
  assert.match(output, /proxy_pass http:\/\/artfi_api/);
  assert.match(output, /deny all/);
  assert.match(output, /proxy_next_upstream_tries 2/);
  assert.doesNotMatch(
    output,
    /non_idempotent|\$request_uri|\$http_authorization|\$args/,
  );
});
test("requires explicit allocations and prevents listener/backend loops", () => {
  for (const update of [
    (c) => delete c.web.listen,
    (c) => (c.web.backends = ["127.0.0.1:34000", "127.0.0.1:34002"]),
    (c) => (c.api.listen = c.web.listen),
    (c) => (c.api.backends = ["127.0.0.1:4", "127.0.0.1:4"]),
  ]) {
    const c = fixture();
    update(c);
    assert.throws(() => renderCluster(c));
  }
});
test("CTYun TCP 443 reservation is host-specific", () => {
  const c = fixture();
  c.web.listen = "127.0.0.1:443";
  assert.doesNotThrow(() => renderCluster(c));
  c.hostClass = "ctyun";
  assert.throws(() => renderCluster(c), /reserved for SSH/);
});
test("remote listeners require TLS and private API client scope", () => {
  const c = fixture();
  c.api.listen = "0.0.0.0:34010";
  assert.throws(() => renderCluster(c), /TLS/);
  c.api.tls = { certificate: "/private/cert.pem", key: "/private/key.pem" };
  assert.throws(() => renderCluster(c), /allowedClients/);
  c.api.allowedClients = ["127.0.0.1/32"];
  assert.match(renderCluster(c), /ssl_protocols TLSv1.2 TLSv1.3/);
});
test("remote backends require certificate-verified TLS", () => {
  const c = fixture();
  c.web.backends = ["node-a.example.test:3000", "node-b.example.test:3000"];
  assert.throws(() => renderCluster(c), /backendTLS/);
  c.web.backendTLS = {
    serverName: "cluster.example.test",
    certificateAuthority: "/private/ca.pem",
  };
  assert.match(renderCluster(c), /proxy_ssl_verify on/);
});
test("configuration values cannot add nginx directives", () => {
  for (const update of [
    (c) => (c.runtimeDirectory = "/tmp/test; include x"),
    (c) => (c.web.listen = "127.0.0.1:4;#"),
    (c) => (c.web.backends[0] = "example.test:65536"),
    (c) => (c.api.allowedClients = ["0.0.0.0/99"]),
  ]) {
    const c = fixture();
    update(c);
    assert.throws(() => renderCluster(c));
  }
});

test("optional execution-zone BFF routing preserves delivery pages and internal API separation", () => {
  const c = fixture();
  c.bffExecution = {
    executionZone: "sin",
    backends: ["127.0.0.1:34101", "127.0.0.1:34102"],
  };
  const output = renderCluster(c);
  assert.match(output, /location \^~ \/api\//);
  assert.match(output, /proxy_pass http:\/\/artfi_bff/);
  assert.match(output, /proxy_pass http:\/\/artfi_web/);
  assert.match(output, /proxy_pass http:\/\/artfi_api/);
  c.bffExecution.executionZone = "delivery";
  assert.throws(() => renderCluster(c), /SIN/);
  c.bffExecution.executionZone = "sin";
  c.bffExecution.backends[0] = c.web.listen;
  assert.throws(() => renderCluster(c), /loop/);
});
