import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  configuredOrigin,
  operatorSessionCookie,
  readOperatorSession,
  sessionStillAuthorized,
} from "@/lib/operator-auth";

type RouteContext = { params: Promise<{ path: string[] }> };

const allowedPrefixes = ["v1/uploads/", "v1/rwa/", "v1/vault/"];
const maximumRequestBytes = 11 * 1024 * 1024;

function upstreamBaseURL() {
  const value = process.env.ARTFI_OPERATOR_API_URL?.trim() ?? "";
  const parsed = new URL(value);
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Operator API URL is invalid.");
  }
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost") {
    throw new Error("Operator API URL must use HTTPS or localhost.");
  }
  return parsed;
}

async function proxy(request: Request, context: RouteContext) {
  try {
    const expectedOrigin = configuredOrigin(new URL(request.url).origin);
    const requestOrigin = request.headers.get("origin");
    if (
      request.method !== "GET" &&
      (!requestOrigin || new URL(requestOrigin).origin !== expectedOrigin)
    ) {
      return NextResponse.json(
        { detail: "Operator request origin is not allowed." },
        { status: 403 },
      );
    }
    const declaredLength = Number(request.headers.get("content-length") || 0);
    if (
      !Number.isFinite(declaredLength) ||
      declaredLength < 0 ||
      declaredLength > maximumRequestBytes
    ) {
      return NextResponse.json(
        { detail: "Operator request is too large." },
        { status: 413 },
      );
    }
    const cookieStore = await cookies();
    const session = readOperatorSession(
      cookieStore.get(operatorSessionCookie)?.value,
    );
    if (!session || !(await sessionStillAuthorized(session))) {
      return NextResponse.json(
        { detail: "A current registrar-wallet session is required." },
        { status: 401 },
      );
    }
    const { path } = await context.params;
    if (
      path.length === 0 ||
      path.some((segment) => !/^[A-Za-z0-9_-]+$/.test(segment))
    ) {
      return NextResponse.json(
        { detail: "Operator route is not allowed." },
        { status: 404 },
      );
    }
    const joined = path.join("/");
    if (!allowedPrefixes.some((prefix) => `${joined}/`.startsWith(prefix))) {
      return NextResponse.json(
        { detail: "Operator route is not allowed." },
        { status: 404 },
      );
    }
    const token = process.env.ARTFI_OPERATOR_BEARER_TOKEN?.trim() ?? "";
    if (token.length < 24)
      throw new Error("Operator API credential is unavailable.");
    const upstream = new URL(`/` + joined, upstreamBaseURL());
    upstream.search = new URL(request.url).search;
    const headers = new Headers();
    for (const name of [
      "content-type",
      "content-sha256",
      "idempotency-key",
      "x-request-id",
    ]) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    headers.set("authorization", `Bearer ${token}`);
    const requestBody =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await request.arrayBuffer();
    if (requestBody && requestBody.byteLength > maximumRequestBytes) {
      return NextResponse.json(
        { detail: "Operator request is too large." },
        { status: 413 },
      );
    }
    const response = await fetch(upstream, {
      method: request.method,
      headers,
      body: requestBody,
      cache: "no-store",
    });
    const outputHeaders = new Headers();
    for (const name of ["content-type", "x-request-id"]) {
      const value = response.headers.get(name);
      if (value) outputHeaders.set(name, value);
    }
    outputHeaders.set("cache-control", "no-store");
    return new NextResponse(await response.arrayBuffer(), {
      status: response.status,
      headers: outputHeaders,
    });
  } catch {
    return NextResponse.json(
      { detail: "Operator write proxy is unavailable." },
      { status: 503 },
    );
  }
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
