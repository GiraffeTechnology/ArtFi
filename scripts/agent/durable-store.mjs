import { assertOracleIdentity } from "./oracle-observation.mjs";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { kernelRequestDigest } from "./agent-kernel.mjs";

const fail = (code) => {
  throw new Error(code);
};
const id = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const uint = (value) =>
  typeof value === "string" &&
  /^(0|[1-9][0-9]*)$/.test(value) &&
  BigInt(value) < 2n ** 256n;
const address = (value) =>
  typeof value === "string" &&
  /^0x[0-9a-fA-F]{40}$/.test(value) &&
  !/^0x0{40}$/.test(value);
const digest = (value) =>
  typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value);
const transactionHash = (value) => digest(value) && !/^0x0{64}$/.test(value);
const states = new Set([
  "PREPARED",
  "STARTED",
  "SUBMITTED",
  "CONFIRMED",
  "UNKNOWN",
  "RECONCILING",
  "SAFE_DEGRADED",
  "SETTLED",
  "TERMINAL_REJECTED",
]);
const transitions = {
  PREPARED: ["PREPARED", "STARTED", "TERMINAL_REJECTED", "SAFE_DEGRADED"],
  STARTED: ["SUBMITTED", "RECONCILING", "SAFE_DEGRADED", "SETTLED"],
  SUBMITTED: ["CONFIRMED", "UNKNOWN", "SAFE_DEGRADED"],
  CONFIRMED: ["SETTLED", "RECONCILING", "SAFE_DEGRADED"],
  UNKNOWN: ["SETTLED", "RECONCILING", "SAFE_DEGRADED"],
  RECONCILING: ["SETTLED", "RECONCILING", "SAFE_DEGRADED"],
  SAFE_DEGRADED: ["SETTLED", "RECONCILING", "SAFE_DEGRADED"],
  SETTLED: [],
  TERMINAL_REJECTED