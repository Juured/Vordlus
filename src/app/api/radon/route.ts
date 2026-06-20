import { NextRequest, NextResponse } from "next/server";

const EGT = "https://gsavalik.envir.ee/geoserver/egt/ows";

const RISK_MAP: Record<string, "madal" | "keskmine" | "korge"> = {
  low: "madal", madal: "madal",
  medium: "keskmine", keskmine: "keskmine",
  high: "korge", korge: "korge",
};

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const lat = Number(searchParams.get("lat"));
  const lon = Number(searchParams.get("lon"));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return NextResponse.json({ error: "lat ja lon on kohustuslikud" }, { status: 400 });
  }
  const cql = `INTERSECTS(geom,POINT(${lon} ${lat}))`;
  const u = new URL(EGT);
  u.searchParams.set("service", "WFS");
  u.searchParams.set("version", "2.0.0");
  u.searchParams.set("request", "GetFeature");
  u.searchParams.set("typeNames", "egt:radon");
  u.searchParams.set("outputFormat", "application/json");
  u.searchParams.set("CQL_FILTER", cql);
  try {
    const r = await fetch(u.toString(), {
      headers: { Accept: "application/json", "User-Agent": "vordlus/0.4" },
    });
    if (!r.ok) {
      return NextResponse.json(
        { data: null, source: "egt-radon", error: `WFS ${r.status}` },
        { status: 502 },
      );
    }
    const j = (await r.json()) as { features?: { properties?: { RISK?: string } }[] };
    const raw = (j.features?.[0]?.properties?.RISK ?? "").toLowerCase();
    const cls = RISK_MAP[raw] ?? "madal";
    return NextResponse.json(
      { data: { class: cls }, source: "egt-radon", error: null },
      { headers: { "Cache-Control": "public, s-maxage=2592000, stale-while-revalidate=2592000" } },
    );
  } catch (e) {
    return NextResponse.json(
      { data: null, source: "egt-radon", error: (e as Error).message },
      { status: 502 },
    );
  }
}
