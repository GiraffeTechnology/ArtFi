import { describe, expect, it } from "vitest";
import {
  chainLagAfterSeconds,
  classifyApiRuntime,
  classifyChain,
  classifyMirror,
  classifyWebRuntime,
  mirrorStaleAfterSeconds,
  summarise,
} from "./ops-checks";

const now = 1_800_000_000;
const head = { chainId: 560048, blockNumber: 12345n, blockTimestampSeconds: now - 20 };
const readChain = (value: unknown, expected = 560048, at = now) =>
  classifyChain(value as Parameters<typeof classifyChain>[0], expected, at);

describe("verified runtime observation identity", () => {
  it("accepts the actual numeric web health profile only on the expected chain", () => {
    expect(classifyWebRuntime({ status: "ok", chainId: 560048 }, 560048).state).toBe("ok");
    expect(classifyWebRuntime({ status: "ok", chainId: 1 }, 560048).state).toBe("unavailable");
    expect(classifyWebRuntime({ status: "ok", chainId: 560048 }).state).toBe("ok");
  });
  it.each([undefined, null, [], "ok", 200, {status:"ok"}, {status:"ok",chainId:"560048"},
    {status:"ok",chainId:NaN}, {status:"ok",chainId:Infinity}, {status:"ok",chainId:0},
    {status:"ok",chainId:-1}, {status:"ok",chainId:1.5}, {status:"ok",chainId:Number.MAX_SAFE_INTEGER+1}
  ])("refuses a malformed web observation: %j", (value) => {
    expect(classifyWebRuntime(value,560048).state).toBe("unavailable");
  });
  it("does not echo upstream text or invoke object coercion in public details", () => {
    const marker = "PRIVATE_UPSTREAM_DIAGNOSTIC";
    const toString = () => { throw new Error("must not coerce"); };
    for (const status of [marker,{toString},["ok"],true,0,null]) {
      const result = classifyWebRuntime({status,chainId:560048},560048);
      expect(result.state).toBe("unavailable");
      expect(result.detail).not.toContain(marker);
    }
  });
  it.each([0,-1,NaN,Infinity,1.5,Number.MAX_SAFE_INTEGER+1])("refuses an invalid expected web chain: %s",(expected) => {
    expect(classifyWebRuntime({status:"ok",chainId:560048},expected).state).toBe("unavailable");
  });
  it("never makes a numeric-string or absent HTTP result healthy", () => {
    for(const status of [undefined,null,"200",NaN,Infinity,99,600,200.5]) {
      expect(classifyApiRuntime(true,status as number).state).toBe("unavailable");
    }
    expect(classifyApiRuntime(true,200).state).toBe("ok");
    expect(classifyApiRuntime(true,503).state).toBe("degraded");
    expect(classifyApiRuntime(false,200).state).toBe("unavailable");
  });
});

describe("chain evidence and observation time", () => {
  it("retains exact recent and stale boundaries", () => {
    expect(readChain(head).state).toBe("ok");
    expect(readChain({...head,blockTimestampSeconds:now-chainLagAfterSeconds}).state).toBe("ok");
    expect(readChain({...head,blockTimestampSeconds:now-chainLagAfterSeconds-1}).state).toBe("degraded");
    expect(readChain({...head,chainId:1}).state).toBe("unavailable");
  });
  it("reports a future head rather than clamping it to healthy age zero", () => {
    const result = readChain({...head,blockTimestampSeconds:now+1});
    expect(result.state).toBe("degraded");
    expect(result.detail).toContain("future");
    expect(summarise([result]).state).toBe("degraded");
  });
  it.each([undefined,null,[],false,"head",{}, {...head,chainId:"560048"},
    {...head,chainId:0},{...head,chainId:NaN},{...head,chainId:Infinity},
    {...head,chainId:1.5},{...head,chainId:Number.MAX_SAFE_INTEGER+1},
    {...head,blockNumber:-1n},{...head,blockNumber:12345},{...head,blockNumber:"12345"},
    {...head,blockTimestampSeconds:NaN},{...head,blockTimestampSeconds:Infinity},
    {...head,blockTimestampSeconds:-1},{...head,blockTimestampSeconds:now+0.5},
    {...head,blockTimestampSeconds:Number.MAX_SAFE_INTEGER+1},
  ])("never classifies malformed chain evidence as healthy: %#",(value) => {
    expect(readChain(value).state).toBe("unavailable");
  });
  it("supports a valid genesis observation without requiring a positive block number", () => {
    expect(readChain({...head,blockNumber:0n,blockTimestampSeconds:0},560048,0).state).toBe("ok");
  });
  it.each([NaN,Infinity,-1,now+0.5,Number.MAX_SAFE_INTEGER+1])("refuses an invalid local observation time: %s",(at) => {
    expect(readChain(head,560048,at).state).toBe("unavailable");
    expect(classifyMirror(new Date(now*1000).toISOString(),at).state).toBe("unavailable");
  });
  it.each([NaN,Infinity,0,-1,1.5,Number.MAX_SAFE_INTEGER+1])("refuses an invalid configured chain: %s",(expected) => {
    expect(readChain(head,expected).state).toBe("unavailable");
  });
});

describe("mirror observation validation", () => {
  it("retains absence, recent, stale and future states", () => {
    expect(classifyMirror(undefined,now*1000).state).toBe("not-checked");
    expect(classifyMirror("",now*1000).state).toBe("not-checked");
    expect(classifyMirror(new Date(now*1000).toISOString(),now*1000).state).toBe("ok");
    expect(classifyMirror(new Date((now-mirrorStaleAfterSeconds-1)*1000).toISOString(),now*1000).state).toBe("degraded");
    expect(classifyMirror(new Date((now+1)*1000).toISOString(),now*1000).state).toBe("degraded");
    expect(classifyMirror(new Date(now*1000+1).toISOString(),now*1000).state).toBe("degraded");
  });
  it("refuses invalid timestamp values without coercing or reflecting them", () => {
    const marker="PRIVATE_TIMESTAMP_DIAGNOSTIC";
    const object={toString(){throw new Error("must not coerce");}};
    for(const value of [null,0,NaN,[],object,marker,"1969-12-31T23:59:59.000Z"]) {
      const result=classifyMirror(value as string,now*1000);
      expect(result.state).toBe("unavailable");
      expect(result.detail).not.toContain(marker);
    }
  });
  it("does not upgrade a bad observation in an otherwise healthy summary", () => {
    const result=summarise([
      classifyWebRuntime({status:"ok",chainId:560048},560048),
      classifyApiRuntime(true,200),
      readChain({...head,blockTimestampSeconds:NaN}),
    ]);
    expect(result.state).toBe("unavailable");
  });
});
