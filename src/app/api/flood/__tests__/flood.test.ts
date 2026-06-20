import { describe, it, expect, beforeEach, afterEach } from "vitest";
import nock from "nock";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/flood/route";

const FLOOD = "https://gsavalik.envir.ee";

function makeReq(lat: number, lon: number) {
  return new NextRequest(`http://x/api/flood?lat=${lat}&lon=${lon}`);
}

describe("GET /api/flood", () => {
  beforeEach(() => { nock.cleanAll(); });
  afterEach(() => { nock.cleanAll(); });

  it("returns 'ei_ole_ohualas' when no flood zone contains the point", async () => {
    nock(FLOOD).get(/geoserver\/maaamet\/wfs/).reply(200, { features: [] });
    const res = await GET(makeReq(58.5, 25.0));
    const body = await res.json();
    expect(body.data.zone).toBe("ei_ole_ohualas");
    expect(body.source).toBe("maaamet-flood");
  });

  it("returns '100a_ohualas' when 100-year flood zone contains the point", async () => {
    nock(FLOOD).get(/geoserver\/maaamet\/wfs/).reply(200, {
      features: [{ properties: { ZONE: "100a" } }],
    });
    const res = await GET(makeReq(59.5, 24.7));
    const body = await res.json();
    expect(body.data.zone).toBe("100a_ohualas");
  });

  it("returns '1000a_ohualas' when 1000-year flood zone contains the point", async () => {
    nock(FLOOD).get(/geoserver\/maaamet\/wfs/).reply(200, {
      features: [{ properties: { ZONE: "1000a" } }],
    });
    const res = await GET(makeReq(59.5, 24.7));
    const body = await res.json();
    expect(body.data.zone).toBe("1000a_ohualas");
  });
});
