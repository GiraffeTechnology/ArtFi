#!/usr/bin/env node
/** Render configuration only. This command never installs, starts or reloads services. */
import { isIP } from "node:net";
import { isAbsolute, resolve } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const loopback = (host) => host === "127.0.0.1" || host === "::1";
function endpoint(value, field) {
  if (typeof value !== "string")
    throw new Error(`${field}: an explicit host:port allocation is required.`);
  const match = /^(?:\[([a-fA-F0-9:]+)\]|([A-Za-z0-9.-]+)):(\d+)$/.exec(value);
  if (
    !match ||
    Number(match[3]) < 1 ||
    Number(match[3]) > 65535 ||
    (match[1] && !isIP(match[1]))
  )
    throw new Error(`${field}: invalid host:port.`);
  return { text: value, host: match[1] || match[2], port: Number(match[3]) };
}
function path(value, field) {
  if (
    typeof value !== "string" ||
    !isAbsolute(value) ||
    /[\x00-\x20\x7f"'{};$\\]/.test(value)
  )
    throw new Error(
      `${field}: use an absolute path without configuration metacharacters or whitespace.`,
    );
  return value;
}
function group(input, name, upstreamOnly = false) {
  if (
    !input ||
    !Array.isArray(input.backends) ||
    input.backends.length < 2 ||
    input.backends.length > 16
  )
    throw new Error(`${name}: configure two to sixteen backends.`);
  if (upstreamOnly && (input.listen !== undefined || input.tls !== undefined))
    throw new Error(
      `${name}: an execution pool has no additional listener; use backendTLS.`,
    );
  const listen = upstreamOnly ? null : endpoint(input.listen, `${name}.listen`);
  const backends = input.backends.map(
    (b, i) => endpoint(b, `${name}.backends[${i}]`).text,
  );
  if (
    new Set(backends).size !== backends.length ||
    (listen && backends.includes(listen.text))
  )
    throw new Error(`${name}: duplicate backend or listener loop.`);
  const tls = input.tls;
  if (!upstreamOnly && !tls && !loopback(listen.host))
    throw new Error(
      `${name}: a non-loopback listener requires TLS certificate and key paths.`,
    );
  const tlsLines = tls
    ? `\n    ssl_certificate ${path(tls.certificate, `${name}.tls.certificate`)};\n    ssl_certificate_key ${path(tls.key, `${name}.tls.key`)};\n    ssl_protocols TLSv1.2 TLSv1.3;`
    : "";
  let transport = "http",
    upstreamTLS = "";
  if (input.backendTLS) {
    const { serverName, certificateAuthority } = input.backendTLS;
    if (typeof serverName !== "string" || !/^[A-Za-z0-9.-]+$/.test(serverName))
      throw new Error(`${name}: backendTLS.serverName is required.`);
    transport = "https";
    upstreamTLS = `\n      proxy_ssl_server_name on;\n      proxy_ssl_name ${serverName};\n      proxy_ssl_verify on;\n      proxy_ssl_trusted_certificate ${path(certificateAuthority, `${name}.backendTLS.certificateAuthority`)};`;
  } else if (backends.some((b) => !loopback(endpoint(b, name).host)))
    throw new Error(`${name}: remote backends require verified backendTLS.`);
  const upstreamText = `  upstream artfi_${name} {\n${backends.map((b) => `    server ${b} max_fails=1 fail_timeout=2s;`).join("\n")}\n    keepalive 32;\n  }`;
  const location = (route) =>
    `    location ${route} {\n      proxy_pass ${transport}://artfi_${name};\n      proxy_http_version 1.1;\n      proxy_set_header Connection "";\n      proxy_set_header Host $http_host;\n      proxy_set_header X-Forwarded-Host $http_host;\n      proxy_set_header X-Forwarded-Proto $scheme;\n      proxy_set_header X-Forwarded-For $remote_addr;\n      proxy_set_header X-Request-ID $request_id;\n      proxy_connect_timeout 2s;\n      proxy_read_timeout 30s;\n      proxy_send_timeout 30s;\n      proxy_next_upstream error timeout invalid_header http_502 http_503 http_504;\n      proxy_next_upstream_tries 2;\n      proxy_next_upstream_timeout 5s;${upstreamTLS}\n    }`;
  return {
    listen,
    backends,
    upstreamText,
    location,
    text: upstreamOnly
      ? upstreamText
      : `${upstreamText}\n  server {\n    listen ${listen.text}${tls ? " ssl" : ""};\n    server_name _;${tlsLines}\n${location("/")}\n  }`,
  };
}
export function renderCluster(config) {
  if (
    !config ||
    config.format !== 1 ||
    !["isolated-test", "deployment"].includes(config.purpose)
  )
    throw new Error(
      "Use format 1 with an explicit isolated-test or deployment purpose.",
    );
  const run = path(config.runtimeDirectory, "runtimeDirectory");
  const web = group(config.web, "web"),
    api = group(config.api, "api");
  if (web.listen.text === api.listen.text)
    throw new Error("Web and internal API listeners must be separate.");
  if (
    config.hostClass === "ctyun" &&
    [web, api].some((g) => g.listen.port === 443)
  )
    throw new Error(
      "TCP 443 is reserved for SSH on CTYun; use an explicitly allocated web/API port.",
    );
  if (
    !loopback(api.listen.host) &&
    (!Array.isArray(config.api.allowedClients) ||
      !config.api.allowedClients.length)
  )
    throw new Error(
      "A remote API listener requires explicit allowedClients addresses/CIDRs.",
    );
  const allowed = config.api.allowedClients || ["127.0.0.1", "::1"];
  for (const cidr of allowed) {
    const [ip, bits, ...extra] = String(cidr).split("/");
    const version = isIP(ip);
    if (
      !version ||
      extra.length ||
      (bits !== undefined &&
        (!/^\d+$/.test(bits) || +bits > (version === 4 ? 32 : 128)))
    )
      throw new Error("Invalid internal API allowedClients address/CIDR.");
  }
  const bff = config.bffExecution
    ? group(config.bffExecution, "bff", true)
    : null;
  if (bff && config.bffExecution.executionZone !== "sin")
    throw new Error(
      "The optional chain-capable BFF pool requires the explicitly approved SIN execution-zone binding.",
    );
  if (
    bff &&
    bff.backends.some((value) =>
      [web.listen.text, api.listen.text].includes(value),
    )
  )
    throw new Error(
      "Execution BFF backend must not loop into a front listener.",
    );
  const webText = bff
    ? web.text.replace(
        web.location("/"),
        `${bff.location("^~ /api/")}\n${web.location("/")}`,
      )
    : web.text;
  const apiText = api.text.replace(
    "    server_name _;",
    `    server_name _;\n${allowed.map((ip) => `    allow ${ip};`).join("\n")}\n    deny all;`,
  );
  return `# Generated ArtFi M6 configuration. Operator review and explicit deployment are required.\n# Public traffic reaches the web app; the separate API listener is internal only.\nworker_processes 1;\npid ${run}/nginx.pid;\nerror_log ${run}/nginx-error.log warn;\nevents { worker_connections 2048; }\nhttp {\n  default_type application/octet-stream;\n  client_max_body_size 11m;\n  client_body_temp_path ${run}/client-body;\n  proxy_temp_path ${run}/proxy;\n  server_tokens off;\n  log_format artfi escape=json '{"time":"$time_iso8601","requestId":"$request_id","method":"$request_method","status":$status,"upstreamStatus":"$upstream_status","duration":$request_time,"upstream":"$upstream_addr"}';\n  access_log ${run}/access.jsonl artfi;\n${bff ? bff.upstreamText + "\n" : ""}${webText}\n${apiText}\n}\n`;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const [input, output, ...extra] = process.argv.slice(2);
    if (!input || !output || extra.length)
      throw new Error("Usage: node cluster-config.mjs CONFIG.json OUTPUT.conf");
    const rendered = renderCluster(JSON.parse(await readFile(input, "utf8")));
    await writeFile(output, rendered, { mode: 0o600, flag: "wx" });
    console.log(
      "Configuration rendered. Review it, then validate with nginx -t before deployment.",
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
