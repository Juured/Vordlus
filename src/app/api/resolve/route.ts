import { NextRequest, NextResponse } from "next/server";
import { getBuilding, getCadastre, searchAddresses, estpropMedianFor, type AksAddress, type CadastreRecord, type EhrBuilding } from "@/lib/estdata";
import { parseUserInput } from "@/lib/parseInput";
import { EMPTY_LIFESTYLE, lifestyleFromPOI, scoreLifestyle, type Lifestyle } from "@/lib/lifestyle";

export type Resolved = {
  input: { raw: string; kind: string };
  picked: AksAddress | null;
  cadastre: CadastreRecord | null;
  ehr: EhrBuilding | null;
  lifestyle: Lifestyle;
  errors: string[];
};

// Fetch lifestyle POI data for a given WGS84 coord (graceful on failure)
async function fetchPOI(lat: number, lon: number): Promise<Lifestyle | null> {
  // Primary: OSM Overpass via the existing proxy.
  try {
    const u = new URL("/api/poi", "http://x");
    u.searchParams.set("lat", String(lat));
    u.searchParams.set("lon", String(lon));
    u.searchParams.set("radius", "1000");
    const r = await fetch(u.toString(), { headers: { Accept: "application/json" } });
    if (r.ok) {
      const j = await r.json();
      if (j.pois) {
        const total = (Object.values(j.pois) as { count: number }[]).reduce((a, p) => a + (p.count ?? 0), 0);
        if (total > 0) return lifestyleFromPOI(j.pois);
      }
    }
  } catch { /* fall through */ }

  // Secondary: Maa-amet huvipunktid WFS.
  try {
    const u = new URL("/api/huvipunktid", "http://x");
    u.searchParams.set("lat", String(lat));
    u.searchParams.set("lon", String(lon));
    u.searchParams.set("radius", "1000");
    const r = await fetch(u.toString(), { headers: { Accept: "application/json" } });
    if (!r.ok) return null;
    const j = await r.json();
    if (!j.data) return null;
    const total = (Object.values(j.data) as number[]).reduce((a, n) => a + n, 0);
    if (total === 0) return null;
    const pois: Record<string, { count: number; stars: number; label: string }> = {};
    for (const [k, count] of Object.entries(j.data)) {
      pois[k] = { count: count as number, stars: 0, label: "" };
    }
    return lifestyleFromPOI(pois);
  } catch {
    return null;
  }
}

// Pick WGS84 from any of: picked addr, EHR geocoded addr, cadastre tsentroid (need L-EST97 → WGS84).
import proj4 from "proj4";
proj4.defs(
  "EPSG:3301",
  "+proj=lcc +lat_0=57.5175539305556 +lon_0=24 +lat_1=59.3333333333333 +lat_2=58 +x_0=500000 +y_0=6375000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs",
);

function wgs84FromCad(c: CadastreRecord | null): [number, number] | null {
  if (!c) return null;
  const [lng, lat] = proj4("EPSG:3301", "EPSG:4326", [c.tsentroid_x, c.tsentroid_y]);
  return [lng, lat];
}

export async function POST(req: NextRequest) {
  let body: { raw?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Vigane päring" }, { status: 400 });
  }

  const parsed = parseUserInput(body.raw ?? "");
  const errors: string[] = [];
  const out: Resolved = {
    input: { raw: body.raw ?? "", kind: parsed.kind },
    picked: null,
    cadastre: null,
    ehr: null,
    lifestyle: EMPTY_LIFESTYLE,
    errors,
  };

  try {
    let addr: AksAddress | null = null;

    if (parsed.kind === "tunnus") {
      try {
        const c = await getCadastre(parsed.tunnus);
        out.cadastre = c;
        const a = await searchAddresses(c.tais_aadress);
        addr = a.find((x) => x.liik === "E") || a[0] || null;
      } catch (e) {
        errors.push(`Kadastre: ${(e as Error).message}`);
      }
    } else if (parsed.kind === "ehr") {
      try {
        const b = await getBuilding(parsed.ehrCode);
        out.ehr = b;
        if (b?.katastriyksused[0]?.katastritunnus) {
          out.cadastre = await getCadastre(b.katastriyksused[0].katastritunnus);
        }
        if (b) addr = await resolveAddressForEhr(b);
      } catch (e) {
        errors.push(`EHR: ${(e as Error).message}`);
      }
    } else if (parsed.kind === "kv-url" || parsed.kind === "address") {
      const query = parsed.address;
      if (!query) {
        errors.push(
          "Sellelt lingilt ei saanud aadressi kätte. Kleesti aadress käsitsi (nt 'Viljandi mnt 47, Tallinn').",
        );
      } else {
        // Try multiple In-AKS query forms — the official gazetteer is fussy
        // about district names. Drop the district, then drop the city.
        const queries = [query];
        const parts = query.split(",").map((s) => s.trim());
        if (parts.length >= 3) queries.push(parts.slice(0, 2).join(", "));  // drop district
        if (parts.length >= 2) queries.push(parts[0]);                       // street only
        // Dedupe while preserving order
        const seen = new Set<string>();
        const uniq = queries.filter((q) => q && !seen.has(q) && seen.add(q));
        let results: AksAddress[] = [];
        for (const q of uniq) {
          try {
            const r = await searchAddresses(q);
            if (r.length > 0) {
              results = r;
              break;
            }
          } catch (e) {
            errors.push(`In-AKS (${q}): ${(e as Error).message}`);
          }
        }
        if (results.length === 0) {
          errors.push(`Aadressile "${query}" ei leitud vastet. Proovi linnanimeta (nt "${parts[0] ?? query}").`);
        } else {
          const m = results.find((x) => x.liik === "E") || results[0];
          addr = m;
        }
      }

      if (addr) {
        out.picked = addr;
        if (addr.liik === "E" && addr.tunnus) {
          try {
            const b = await getBuilding(addr.tunnus);
            out.ehr = b;
            const ktunnus = b?.katastriyksused[0]?.katastritunnus;
            if (ktunnus) {
              try {
                out.cadastre = await getCadastre(ktunnus);
              } catch (e) {
                errors.push(`Kadastre: ${(e as Error).message}`);
              }
            }
          } catch (e) {
            errors.push(`EHR: ${(e as Error).message}`);
          }
        } else if (addr.tunnus && addr.tunnus.includes(":")) {
          try {
            out.cadastre = await getCadastre(addr.tunnus);
          } catch (e) {
            errors.push(`Kadastre: ${(e as Error).message}`);
          }
        }
      }
    }

    if (out.picked == null && addr) out.picked = addr;

    if (out.cadastre && out.cadastre.estprop_median_eur_m2 == null) {
      const omv = out.cadastre.tais_aadress.split(",").map((s) => s.trim()).slice(-1)[0] ?? null;
      out.cadastre.estprop_median_eur_m2 = estpropMedianFor(omv);
    }

    // Lifestyle: real POI data if we have a WGS84 point; otherwise explicit missing.
    const wgs = wgs84FromCad(out.cadastre);
    if (wgs) {
      const poi = await fetchPOI(wgs[1], wgs[0]);
      out.lifestyle = poi ?? EMPTY_LIFESTYLE;
    } else {
      out.lifestyle = EMPTY_LIFESTYLE;
    }
  } catch (e) {
    errors.push(`Üldine: ${(e as Error).message}`);
  }

  return NextResponse.json(out, {
    headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=3600" },
  });
}

async function resolveAddressForEhr(ehr: EhrBuilding): Promise<AksAddress | null> {
  if (!ehr.taisaadress) return null;
  try {
    const r = await searchAddresses(ehr.taisaadress);
    return r.find((x) => x.liik === "E" && x.tunnus === ehr.ehr_code) || r[0] || null;
  } catch {
    return null;
  }
}
