"use client";

import { useEffect, useMemo, useState } from "react";
import FilterSidebar, { type Filters } from "@/components/FilterSidebar";
import CompareSlot from "@/components/CompareSlot";
import CompareColumnView from "@/components/CompareColumnView";
import { ComparisonTable } from "@/components/ComparisonTable";
import {
  decodeShareUrl,
  defaultScores,
  loadCompare,
  makeId,
  saveCompare,
  type CompareColumn,
} from "@/lib/compareStore";
import { computeScores } from "@/lib/scores";
import { EMPTY_LIFESTYLE } from "@/lib/lifestyle";

const MAX_SLOTS = 5;

type ResolveResponse = {
  input: { raw: string; kind: string };
  picked: { viitepunkt_l: number; viitepunkt_b: number; pikkaadress: string } | null;
  cadastre: { pindala: number; tunnus: string } | null;
  ehr: { ehr_code: string; esmaneKasutus: string | null; energy: { energiaKlass: string | null }[] } | null;
  lifestyle?: { park: { stars: number; label: string; count: number }; school: { stars: number; label: string; count: number }; gym: { stars: number; label: string; count: number }; transit: { stars: number; label: string; count: number }; shop: { stars: number; label: string; count: number }; cafe: { stars: number; label: string; count: number }; restaurant: { stars: number; label: string; count: number } };
  transit?: { stopCount: number; frequency: number } | null;
  radon?: { class: "madal" | "keskmine" | "korge" } | null;
  flood?: { zone: "ei_ole_ohualas" | "100a_ohualas" | "1000a_ohualas" } | null;
  planeeringud?: { name: string; maxFloors: number }[] | null;
  errors: string[];
};

export default function Home() {
  const [columns, setColumns] = useState<CompareColumn[]>([]);
  const [filters, setFilters] = useState<Filters>({});
  const [ready, setReady] = useState(false);

  // Load from localStorage + URL share
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const shared = params.get("c");
    if (shared) {
      const inputs = decodeShareUrl(shared);
      if (inputs.length > 0) {
        const initial: CompareColumn[] = inputs.slice(0, MAX_SLOTS).map((raw) => ({
          id: makeId(),
          input: { raw },
          cadastre: null,
          ehr: null,
          lifestyle: EMPTY_LIFESTYLE,
          transit: null,
          radon: null,
          flood: null,
          planeeringud: null,
          scores: defaultScores(),
          fetchedAt: 0,
          errors: [],
        }));
        setColumns(initial);
        setReady(true);
        return;
      }
    }
    setColumns(loadCompare());
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
    saveCompare(columns);
  }, [columns, ready]);

  // Price per m² helper — only from manualPrice + manualArea
  const pricePerM2Of = (col: CompareColumn): number | null => {
    if (col.input.manualPrice != null && col.input.manualArea != null && col.input.manualArea > 0) {
      return col.input.manualPrice / col.input.manualArea;
    }
    return null;
  };

  // Filtered set — pre-compute price/area for filtering
  const filtered = useMemo(() => {
    return columns.filter((col) => {
      const c = col.cadastre;
      const e = col.ehr;
      // For filtering we want the user's input if available, otherwise
      // building-level data (single-unit only).
      const nimetus = e?.nimetus?.toLowerCase() ?? "";
      const isMulti = nimetus.includes("korterelamu") || nimetus.includes("korter");
      const price = col.input.manualPrice ?? null;
      const area = col.input.manualArea ?? (isMulti ? null : e?.suletud_netopind ?? null);
      const rooms = col.input.manualRooms ?? (isMulti ? null : e?.tubadeArv ?? null);
      const energy = e?.energy[0]?.energiaKlass ?? null;
      if (filters.priceMin != null && price != null && price < filters.priceMin) return false;
      if (filters.priceMax != null && price != null && price > filters.priceMax) return false;
      if (filters.areaMin != null && area != null && area < filters.areaMin) return false;
      if (filters.areaMax != null && area != null && area > filters.areaMax) return false;
      if (filters.roomsMin != null && rooms != null && rooms < filters.roomsMin) return false;
      if (filters.energy?.length) {
        if (!energy || !filters.energy.includes(energy)) return false;
      }
      if (filters.minOverall && col.scores.overall > 0) {
        if (col.scores.overall < filters.minOverall) return false;
      }
      if (filters.greenMortgageOnly && col.scores.greenMortgage.score < 4) return false;
      if (filters.minParkStars != null && filters.minParkStars > 0 && col.lifestyle.park.stars < filters.minParkStars) return false;
      if (filters.minSchoolStars != null && filters.minSchoolStars > 0 && col.lifestyle.school.stars < filters.minSchoolStars) return false;
      if (filters.minTransitStars != null && filters.minTransitStars > 0 && col.lifestyle.transit.stars < filters.minTransitStars) return false;
      return true;
    });
  }, [columns, filters]);

  // Batch median €/m² for Fair Value scoring
  const medianPriceM2 = useMemo(() => {
    const pps: number[] = [];
    for (const col of filtered) {
      const v = pricePerM2Of(col);
      if (v != null) pps.push(v);
    }
    if (pps.length === 0) return null;
    pps.sort((a, b) => a - b);
    return pps[Math.floor(pps.length / 2)];
  }, [filtered]);

  // Augment each filtered column with live scores that depend on the
  // batch median. The stored `scores` is the fallback (no median).
  const filteredWithScores = useMemo(() => {
    return filtered.map((col) => {
      const liveScores = computeScores({
        c: col.cadastre,
        e: col.ehr,
        lifestyle: col.lifestyle,
        marketMedian: medianPriceM2,
        pricePerM2Override: pricePerM2Of(col),
        unitArea: col.input.manualArea ?? null,
      });
      return { ...col, scores: liveScores };
    });
  }, [filtered, medianPriceM2]);

  async function resolveSlot(
    raw: string,
    manual?: { price?: number | null; area?: number | null; rooms?: number | null },
  ): Promise<{ ok: boolean; error?: string }> {
    if (!raw.trim()) return { ok: false, error: "Sisesta aadress või ID" };
    try {
      const r = await fetch("/api/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ raw, manual }),
      });
      if (!r.ok) return { ok: false, error: `Server viga: ${r.status}` };
      const j: ResolveResponse = await r.json();
      const cad = (j.cadastre as CompareColumn["cadastre"]) ?? null;
      const e = (j.ehr as CompareColumn["ehr"]) ?? null;
      const lifestyle = (j.lifestyle as CompareColumn["lifestyle"]) ?? EMPTY_LIFESTYLE;
      const newCol: CompareColumn = {
        id: makeId(),
        input: {
          raw,
          manualPrice: manual?.price ?? null,
          manualArea: manual?.area ?? null,
          manualRooms: manual?.rooms ?? null,
        },
        cadastre: cad,
        ehr: e,
        lifestyle,
        transit: j.transit ?? null,
        radon: j.radon ?? null,
        flood: j.flood ?? null,
        planeeringud: j.planeeringud ?? null,
        // Stored scores are best-effort (no median yet)
        scores: computeScores({
          c: cad,
          e,
          lifestyle,
          marketMedian: null,
          pricePerM2Override: null,
          unitArea: manual?.area ?? null,
        }),
        fetchedAt: Date.now(),
        errors: j.errors,
      };
      setColumns((prev) => {
        const idx = prev.findIndex((c) => c.input.raw === raw);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = newCol;
          return next.slice(0, MAX_SLOTS);
        }
        return [...prev, newCol].slice(0, MAX_SLOTS);
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  function updateSlot(index: number, col: CompareColumn | null) {
    setColumns((prev) => {
      const next = [...prev];
      if (col) next[index] = col;
      else next.splice(index, 1);
      return next;
    });
  }

  function removeColumn(id: string) {
    setColumns((prev) => prev.filter((c) => c.id !== id));
  }

  function clearAll() {
    if (!confirm("Eemaldada kõik võrdlused?")) return;
    setColumns([]);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.delete("c");
      window.history.replaceState({}, "", url.toString());
    }
  }

  async function shareUrl() {
    const inputs = columns.map((c) => c.input.raw);
    if (inputs.length === 0) return;
    const b64 = (() => {
      const json = JSON.stringify(inputs);
      if (typeof btoa === "function") return btoa(unescape(encodeURIComponent(json)));
      return Buffer.from(json, "utf-8").toString("base64");
    })();
    const url = new URL(window.location.href);
    url.searchParams.set("c", b64);
    await navigator.clipboard.writeText(url.toString());
    alert("Link kopeeritud!");
  }

  // Add a column by replacing the empty slot when user clicks a slot button.
  function setColumnAt(idx: number, col: CompareColumn) {
    setColumns((prev) => {
      const next = [...prev];
      next[idx] = col;
      return next;
    });
  }

  return (
    <>
      {/* ============== TOP BAR ============== */}
      <header className="border-b border-rule bg-paper sticky top-0 z-30">
        <div className="max-w-compare mx-auto px-5 sm:px-8 py-4 flex items-center justify-between">
          <a href="/" className="flex items-center gap-2.5">
            <span aria-hidden="true" className="grid place-items-center w-7 h-7 bg-ink text-paper font-display text-[19px] leading-none">
              v
            </span>
            <span className="font-display text-[20px] text-ink tracking-tight">võrdlus</span>
            <span className="hidden sm:inline text-[12px] text-muted ml-2">· Kinnisvara võrdlus</span>
          </a>
          <nav className="flex items-center gap-5 text-[13px] text-ink">
            <button
              onClick={shareUrl}
              disabled={columns.length === 0}
              className="hidden sm:flex items-center gap-1.5 hover:text-accent transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                <path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M16 6l-4-4-4 4M12 2v14" />
              </svg>
              Jaga
            </button>
            <button
              onClick={clearAll}
              disabled={columns.length === 0}
              className="flex items-center gap-1.5 hover:text-accent transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
              </svg>
              Tühjenda
            </button>
          </nav>
        </div>
      </header>

      {/* ============== MASTHEAD ============== */}
      <section className="border-b border-rule">
        <div className="max-w-compare mx-auto px-5 sm:px-8 py-10 sm:py-14">
          <p className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted">Kinnisvara võrdlus</p>
          <h1 className="display mt-3 text-ink text-balance max-w-[44ch]">
            Võrdle kuni viit kinnisvaraobjekti
            <span className="text-faint"> kõrvuti.</span>
          </h1>
          <p className="mt-4 text-muted max-w-prose text-[15px]">
            Sisesta kuni viis aadressi, kv.ee linki või katastri numbrit. Meie koostame
            kinnistu, ehitise ja energiamärgise andmed kõrvuti ning anname viis skoori:
            Fair Value (hind vs turu mediaan), TCO (elamiskulud), Appreciation
            (tuleviku väärtus), Elustiil (naabruskond) ja Rohelaen (rohelaenu sobivus).
          </p>
        </div>
      </section>

      {/* ============== GRID ============== */}
      <section className="max-w-compare mx-auto px-5 sm:px-8 py-8 lg:py-12">
        <div className="flex flex-col lg:flex-row gap-6 lg:gap-8 items-start">
          <FilterSidebar
            filters={filters}
            onChange={setFilters}
            matchCount={filteredWithScores.length}
            totalCount={columns.length}
          />

          <div className="flex-1 min-w-0 w-full">
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-6">
              {Array.from({ length: MAX_SLOTS }).map((_, i) => (
                <CompareSlot
                  key={i}
                  index={i}
                  column={columns[i] ?? null}
                  onChange={(c) => updateSlot(i, c)}
                  onResolve={resolveSlot}
                />
              ))}
            </div>

            {filteredWithScores.length === 0 ? (
              <EmptyState onTryExample={async () => {
                // Realistic 2025–2026 Estonian listing examples with actual
                // market prices. These cover three different building types:
                //   - 70s üksikelamu (single-family, expensive per m²)
                //   - 60s korterelamu (soviet-era apartment, typical)
                //   - 30s korterelamu (pre-war, central)
                const examples: { raw: string; price: number; area: number; rooms: number }[] = [
                  // Viljandi 47, Nõmme — 199 m² üksikelamu, 1970, D-energy.
                  // 2026 market ~€420k
                  { raw: "Viljandi mnt 47, Tallinn", price: 420000, area: 199, rooms: 5 },
                  // Pärnu mnt 28 — 6-korruseline korterelamu, 1937.
                  // Typical 2-toaline ~55 m², ~€220k
                  { raw: "Pärnu mnt 28, Tallinn", price: 220000, area: 55, rooms: 2 },
                  // Tartu mnt 84a — suur korterelamu Kesklinnas, 1930.
                  // Typical 3-toaline ~75 m², ~€310k
                  { raw: "Tartu mnt 84a, Tallinn", price: 310000, area: 75, rooms: 3 },
                ];
                for (const ex of examples) {
                  await resolveSlot(ex.raw, { price: ex.price, area: ex.area, rooms: ex.rooms });
                }
              }} />
            ) : (
              <>
                <div className="flex items-baseline justify-between mb-4">
                  <h2 className="display-tight text-[22px] text-ink">
                    Võrdlus · <span className="text-faint">{filteredWithScores.length} objekti</span>
                  </h2>
                  {medianPriceM2 != null && (
                    <p className="text-[11px] text-muted hidden sm:block">
                      Turu mediaan: <span className="text-ink font-mono">€{Math.round(medianPriceM2).toLocaleString("et-EE")}</span> / m²
                    </p>
                  )}
                </div>
                <div className="overflow-x-auto no-scrollbar -mx-5 sm:-mx-8 px-5 sm:px-8 pb-2">
                  <div
                    className="grid gap-3"
                    style={{ gridTemplateColumns: `repeat(${filteredWithScores.length}, minmax(240px, 1fr))` }}
                  >
                    {filteredWithScores.map((col, i) => (
                      <CompareColumnView
                        key={col.id}
                        column={col}
                        index={i}
                        medianPriceM2={medianPriceM2}
                        onRemove={() => removeColumn(col.id)}
                      />
                    ))}
                  </div>
                </div>
                <ComparisonTable columns={filteredWithScores} />
              </>
            )}
          </div>
        </div>
      </section>

      <footer className="border-t border-rule mt-12">
        <div className="max-w-compare mx-auto px-5 sm:px-8 py-6 flex flex-col sm:flex-row sm:items-baseline gap-2 justify-between text-[12px] text-muted">
          <p>
            <span className="font-display text-ink">võrdlus</span> · Ehitatud vabade Eesti
            avalike andmete peale (In-AKS, Maa-amet X-tee, Ehitisregister, OpenStreetMap). Mitte
            õigus- ega finantsnõustamine.
          </p>
          <p className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-faint">v2.0 · 2026</p>
        </div>
      </footer>
    </>
  );
}

function EmptyState({ onTryExample }: { onTryExample: () => void }) {
  return (
    <div className="rounded-lg border border-rule bg-white p-8 sm:p-12 text-center">
      <p className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted">Alusta võrdlust</p>
      <h3 className="display mt-2 text-[28px] text-ink max-w-prose mx-auto">
        Sisesta esimene aadress või klõpsa näidet.
      </h3>
      <p className="mt-3 text-muted max-w-prose mx-auto text-[14.5px]">
        Iga objekt saab neli skoori: <strong>Fair Value</strong> (hind vs turu mediaan),
        <strong> TCO</strong> (igakuised kulud küte + elekter), <strong>Appreciation</strong> (tuleviku väärtus) ja
        <strong> Elustiil</strong> (park, kool, transport 1 km raadiuses).
      </p>
      <button
        onClick={onTryExample}
        className="mt-6 bg-ink text-paper text-[12px] font-semibold tracking-wider uppercase
                   px-5 py-3 hover:bg-ink/85 transition-colors"
      >
        Lae 3 näidet (Tallinn)
      </button>
      <p className="mt-4 text-[11.5px] text-faint">
        Või kleebi oma kv.ee / city24.ee link — meie otsime aadressi URL-ist ja
        In-AKS-ist.
      </p>
    </div>
  );
}
