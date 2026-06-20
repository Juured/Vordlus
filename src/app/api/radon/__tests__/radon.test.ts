import { describe, it, expect, beforeEach, afterEach } from "vitest";
import nock from "nock";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/radon/route";

const EGT = "https://gsavalik.envir.ee";

function makeReq(lat: number, lon: number) {
  return new NextRequest(`http://x/api/radon?lat=${lat}&lon=${lon}`);
}

describe("GET /api/radon", () => {
  beforeEach(() => { nock.cleanAll(); });
  afterEach(() => { nock.cleanAll(); });

  it("returns 'madal' when point is outside any high-risk polygon", async () => {
    nock(EGT).get(/geoserver\/egt\/ows/).reply(200, { features: [] });
    const res = await GET(makeReq(58.0, 26.0));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.class).toBe("madal");
    expect(body.source).toBe("egt-radon");
  });

  it("returns 'korge' when point is inside a high-risk polygon", async () => {
    nock(EGT).get(/geoserver\/egt\/ows/).reply(200, {
      features: [{ properties: { RISK: "korge" } }],
    });
    const res = await GET(makeReq(59.5, 24.7));
    const body = await res.json();
    expect(body.data.class).toBe("korge");
  });

  it("returns 502 on upstream error", async () => {
    nock(EGT).get(/geoserver\/egt\/ows/).reply(500);
    const res = await GET(makeReq(59.5, 24.7));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });
});
