import { NextRequest, NextResponse } from "next/server";

const WFS = "https://gsavalik.envir.ee/geoserver/maaamet/wfs";

const ZONE_MAP: Record<string, string> = {
  "100a": "100a_ohualas",
  "1000a": "1000a_ohualas",
  "100": "100a_ohualas",
  "1000": "1000a_ohualas",
};

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const lat = Number(searchParams.get("lat"));
  const lon = Number(searchParams.get("lon"));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return NextResponse.json({ error: "lat ja lon on kohustuslikud" }, { status: 400 });
  }
  const cql = `INTERSECTS(geom,POINT(${lon} ${lat}))`;
  const u = new URL(WFS);
  u.searchParams.set("service", "WFS");
  u.searchParams.set("version", "2.0.0");
  u.searchParams.set("request", "GetFeature");
  u.searchParams.set("typeNames", "maaamet:uhualad");
  u.searchParams.set("outputFormat", "application/json");
  u.searchParams.set("CQL_FILTER", cql);
  try {
    const r = await fetch(u.toString(), {
      headers: { Accept: "application/json", "User-Agent": "vordlus/0.4" },
    });
    if (!r.ok) {
      return NextResponse.json(
        { data: null, source: "maaamet-flood", error: `WFS ${r.status}` },
        { status: 502 },
      );
    }
    const j = (await r.json()) as { features?: { properties?: { ZONE?: string } }[] };
    const raw = (j.features?.[0]?.properties?.ZONE ?? "").toLowerCase();
    const zone = ZONE_MAP[raw] ?? "ei_ole_ohualas";
    return NextResponse.json(
      { data: { zone }, source: "maaamet-flood", error: null },
      { headers: { "Cache-Control": "public, s-maxage=2592000, stale-while-revalidate=2592000" } },
    );
  } catch (e) {
    return NextResponse.json(
      { data: null, source: "maaamet-flood", error: (e as Error).message },
      { status: 502 },
    );
  }
}
