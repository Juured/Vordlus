'use client';

import { useEffect, useMemo, useRef, useState } from "react";
import type { CompareColumn } from "@/lib/compareStore";
import "leaflet/dist/leaflet.css";

type PoiCategory = "park" | "school" | "gym" | "transit" | "shop" | "cafe" | "restaurant";

type PoiItem = {
  category: PoiCategory;
  lat: number;
  lon: number;
  name: string;
  columnId: string;
};

const CATEGORY_COLOR: Record<PoiCategory, string> = {
  park: "#16a34a",
  school: "#0f766e",
  gym: "#7c3aed",
  transit: "#2563eb",
  shop: "#ca8a04",
  cafe: "#be123c",
  restaurant: "#c2410c",
};

export default function PropertyMap({ columns }: { columns: CompareColumn[] }) {
  const points = useMemo(
    () =>
      columns
        .filter((col) => col.lat != null && col.lon != null)
        .map((col) => ({ id: col.id, label: col.input.raw, lat: col.lat as number, lon: col.lon as number })),
    [columns],
  );

  const [poiItems, setPoiItems] = useState<PoiItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mapRootRef = useRef<HTMLDivElement | null>(null);
  const mapInstanceRef = useRef<any>(null);
  const leafletRef = useRef<any>(null);
  const markersRef = useRef<any[]>([]);

  const center = useMemo(() => {
    if (points.length === 0) return { lat: 59.43696, lon: 24.75353, zoom: 13 };
    const avgLat = points.reduce((sum, p) => sum + p.lat, 0) / points.length;
    const avgLon = points.reduce((sum, p) => sum + p.lon, 0) / points.length;
    return { lat: avgLat, lon: avgLon, zoom: 13 };
  }, [points]);

  useEffect(() => {
    let canceled = false;
    async function loadPoi() {
      if (points.length === 0) {
        setPoiItems([]);
        setError(null);
        setLoading(false);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const fetched = await Promise.all(
          points.map(async (point) => {
            const params = new URLSearchParams({
              lat: String(point.lat),
              lon: String(point.lon),
              radius: "1000",
              detail: "1",
            });
            const res = await fetch(`/api/poi?${params.toString()}`);
            if (!res.ok) throw new Error(`POI API: ${res.status}`);
            const json = await res.json();
            const items = Array.isArray(json.items) ? json.items : [];
            return items
              .filter((item: any) => item?.category === "cafe" || item?.category === "restaurant")
              .map((item: any) => ({
                category: item.category as PoiCategory,
                lat: Number(item.lat),
                lon: Number(item.lon),
                name: String(item.name ?? item.category ?? ""),
                columnId: point.id,
              }));
          }),
        );
        if (!canceled) {
          setPoiItems(fetched.flat());
        }
      } catch (err) {
        if (!canceled) setError((err as Error).message);
      } finally {
        if (!canceled) setLoading(false);
      }
    }

    loadPoi();
    return () => {
      canceled = true;
    };
  }, [points]);

  useEffect(() => {
    if (!mapRootRef.current) return;
    if (mapInstanceRef.current) {
      mapInstanceRef.current.remove();
      mapInstanceRef.current = null;
    }

    let active = true;
    (async () => {
      try {
        const imported = await import("leaflet");
        const Leaflet = (imported as any).default ?? imported;
        if (!active || !mapRootRef.current) return;
        leafletRef.current = Leaflet;
        const map = Leaflet.map(mapRootRef.current, {
          zoomControl: false,
          attributionControl: true,
          dragging: true,
        });
        Leaflet.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
          maxZoom: 19,
        }).addTo(map);
        map.setView([center.lat, center.lon], center.zoom);
        mapInstanceRef.current = map;
      } catch (err) {
        if (!active) return;
        setError("Kaardi laadimine ebaõnnestus");
        console.error(err);
      }
    })();

    return () => {
      active = false;
      if (mapInstanceRef.current) {
        mapInstanceRef.current.remove();
        mapInstanceRef.current = null;
      }
    };
  }, [center.lat, center.lon, center.zoom]);

  useEffect(() => {
    if (!mapInstanceRef.current) return;
    if (!leafletRef.current) return;
    markersRef.current.forEach((marker) => marker.remove());
    markersRef.current = [];

    const map = mapInstanceRef.current;
    const Leaflet = leafletRef.current;
    if (points.length > 0) {
      const bounds = Leaflet.latLngBounds(points.map((p) => [p.lat, p.lon]));
      points.forEach((point) => {
        const marker = Leaflet.circleMarker([point.lat, point.lon], {
          radius: 8,
          color: "#111827",
          fillColor: "#ffffff",
          fillOpacity: 1,
          weight: 2,
        }).addTo(map);
        marker.bindTooltip(point.label, { direction: "top", offset: [0, -10], permanent: false });
        markersRef.current.push(marker);
      });
      poiItems.forEach((poi) => {
        const marker = Leaflet.circleMarker([poi.lat, poi.lon], {
          radius: 5,
          color: CATEGORY_COLOR[poi.category],
          fillColor: CATEGORY_COLOR[poi.category],
          fillOpacity: 0.9,
          weight: 1,
        }).addTo(map);
        marker.bindTooltip(poi.name, { direction: "top", offset: [0, -8], permanent: false });
        markersRef.current.push(marker);
      });
      map.fitBounds(bounds.pad(0.4), { maxZoom: 15, animate: false });
    }
  }, [points, poiItems]);

  return (
    <div className="rounded-lg border border-rule bg-white">
      <div className="px-4 py-3 border-b border-rule flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">Kaart</p>
          <p className="text-[14px] text-ink">Valitud asukohad ja naabruskonna kohvikud/restoranid</p>
        </div>
        <div className="text-right text-[12px] text-muted">
          {loading ? "Laeb POI-d…" : error ? error : `${poiItems.length} kohvikut/restorani kaart`}
        </div>
      </div>
      <div className="relative h-[520px]">
        <div ref={mapRootRef} className="h-full w-full" />
        {points.length === 0 && (
          <div className="absolute inset-0 grid place-items-center bg-white/80 p-6 text-center">
            <p className="text-[15px] font-semibold text-ink">Sisesta aadress, et näha kaarti.</p>
            <p className="mt-2 text-[13px] text-muted">Kaardile joonistame valitud aadressid ja nende läheduses asuvad kohvikud/restoranid.</p>
          </div>
        )}
      </div>
      <div className="px-4 py-4">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[12px] text-muted">
          <span className="inline-flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-[#111827]" />Aadress
          </span>
          <span className="inline-flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-[#be123c]" />Kohvik
          </span>
          <span className="inline-flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-[#c2410c]" />Restoran
          </span>
          <span className="text-right text-[11px] text-muted">Pea meeles: OSM-i andmed võivad olla ebatäpsed.</span>
        </div>
      </div>
    </div>
  );
}
