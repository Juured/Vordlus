// Comparison state — a list of comparison "columns", each tied to a property.
// Persisted to localStorage and sharable via URL.

import type { CadastreRecord, EhrBuilding } from "./estdata";
import type { Lifestyle } from "./lifestyle";
import type { PropertyScores } from "./scores";

export type CompareInput = {
  raw: string;
  manualPrice?: number | null;
  manualArea?: number | null;
  manualRooms?: number | null;
};

export type CompareColumn = {
  id: string; // stable uuid for the column
  input: CompareInput;
  cadastre: CadastreRecord | null;
  ehr: EhrBuilding | null;
  lifestyle: Lifestyle;
  transit: { stopCount: number; frequency: number } | null;
  radon: { class: "madal" | "keskmine" | "korge" } | null;
  flood: { zone: "ei_ole_ohualas" | "100a_ohualas" | "1000a_ohualas" } | null;
  planeeringud: { name: string; maxFloors: number }[] | null;
  scores: PropertyScores; // 4-score evaluation
  fetchedAt: number;
  errors: string[];
};

const STORAGE_KEY = "vordlus.compare.v1";

export function loadCompare(): CompareColumn[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveCompare(cols: CompareColumn[]) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cols));
  } catch {}
}

export function makeId(): string {
  return Math.random().toString(36).slice(2, 10);
}

// URL share: encode just the raw inputs as base64-JSON.
// ?c=<base64> in the URL → restored on load.
export function encodeShareUrl(cols: CompareColumn[]): string {
  const inputs = cols.map((c) => c.input.raw);
  if (inputs.length === 0) return "";
  const json = JSON.stringify(inputs);
  if (typeof btoa === "function") return btoa(unescape(encodeURIComponent(json)));
  return Buffer.from(json, "utf-8").toString("base64");
}

export function decodeShareUrl(b64: string): string[] {
  try {
    const json =
      typeof atob === "function"
        ? decodeURIComponent(escape(atob(b64)))
        : Buffer.from(b64, "base64").toString("utf-8");
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

// Default scores — used while data is loading
import { computeScores } from "./scores";
import { EMPTY_LIFESTYLE } from "./lifestyle";

export function defaultScores(): PropertyScores {
  return computeScores({
    c: null,
    e: null,
    lifestyle: EMPTY_LIFESTYLE,
    marketMedian: null,
  });
}
