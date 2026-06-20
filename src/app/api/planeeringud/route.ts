import { NextRequest, NextResponse } from "next/server";

const NORDAPI = "https://nordapi.ee/api/v1/estonian-plans";

type Plan = { name: string; lat: number; lon: number; maxFloors: number; status: string };

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const lat = Number(searchParams.get("lat"));
  const lon = Number(searchParams.get("lon"));
  const radius = Math.min(Math.max(Number(searchParams.get("radius") ?? 500), 100), 3000);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return NextResponse.json({ error: "lat ja lon on kohustuslikud" }, { status: 400 });
  }
  try {
    const r = await fetch(NORDAPI, {
      headers: { Accept: "application/json", "User-Agent": "vordlus/0.4" },
    });
    if (!r.ok) {
      return NextResponse.json(
        { data: null, source: "nordapi-plank", error: `NordAPI ${r.status}` },
        { status: 502 },
      );
    }
    const all = (await r.json()) as Plan[];
    const dLat = radius / 111_000;
    const dLon = radius / (111_000 * Math.cos((lat * Math.PI) / 180));
    const filtered = all.filter(
      (p) => Math.abs(p.lat - lat) < dLat && Math.abs(p.lon - lon) < dLon && p.status === "kehtiv",
    );
    return NextResponse.json(
      { data: { plans: filtered }, source: "nordapi-plank", error: null },
      { headers: { "Cache-Control": "public, s-maxage=604800, stale-while-revalidate=2592000" } },
    );
  } catch (e) {
    return NextResponse.json(
      { data: null, source: "nordapi-plank", error: (e as Error).message },
      { status: 502 },
    );
  }
}
