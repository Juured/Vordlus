import { NextRequest, NextResponse } from "next/server";

// Maa-amet orthophoto WMS. Server-side render of a small bbox around
// the property's WGS84 center. The result is a single aerial photo
// (not an interactive map) shown as the property's image.
//
// Layer of10000 = 10 cm GSD (high-resolution Estonian orthophoto).
const WMS = "https://kaart.maaamet.ee/wms/fotokaart";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const lat = Number(searchParams.get("lat"));
  const lon = Number(searchParams.get("lon"));
  // 50m half-width = ~25m on each side at 59°N
  const half = Math.min(Math.max(Number(searchParams.get("half") ?? 25), 10), 200);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return NextResponse.json({ error: "lat ja lon on kohustuslikud" }, { status: 400 });
  }

  // 1° lat ≈ 111 000 m, 1° lon ≈ 111 000 m × cos(lat)
  const dLat = half / 111_000;
  const dLon = half / (111_000 * Math.cos((lat * Math.PI) / 180));
  const minLon = lon - dLon;
  const minLat = lat - dLat;
  const maxLon = lon + dLon;
  const maxLat = lat + dLat;

  const u = new URL(WMS);
  u.searchParams.set("service", "WMS");
  u.searchParams.set("version", "1.3.0");
  u.searchParams.set("request", "GetMap");
  u.searchParams.set("layers", "of10000");
  u.searchParams.set("styles", "");
  u.searchParams.set("bbox", `${minLon},${minLat},${maxLon},${maxLat}`);
  u.searchParams.set("srs", "EPSG:4326");
  u.searchParams.set("width", "600");
  u.searchParams.set("height", "450");
  u.searchParams.set("format", "image/jpeg");
  u.searchParams.set("transparent", "false");
  // No EXCEPTIONS override — the default XML error format is widely
  // accepted and avoids the WMS rejecting an unknown MIME.

  try {
    const r = await fetch(u.toString(), {
      headers: { Accept: "image/jpeg", "User-Agent": "vordlus/0.5" },
    });
    if (!r.ok) {
      return NextResponse.json({ error: `WMS ${r.status}` }, { status: 502 });
    }
    const buf = Buffer.from(await r.arrayBuffer());
    // WMS error responses are XML, not images — detect and forward as JSON.
    if (buf.length < 200 || buf[0] === 0x3c /* '<' */) {
      const txt = buf.toString("utf8", 0, Math.min(buf.length, 500));
      return NextResponse.json({ error: "WMS error", detail: txt }, { status: 502 });
    }
    return new NextResponse(buf, {
      status: 200,
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "public, s-maxage=2592000, stale-while-revalidate=2592000",
      },
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
