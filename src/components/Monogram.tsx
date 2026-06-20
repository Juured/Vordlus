"use client";

type Props = {
  address: string;
  buildingType?: string | null;
  index: number;
  overallScore: number;
  overallLabel: string;
  onClose?: () => void;
};

const MULTI = ["korterelamu", "korter"];

function deriveGlyph(address: string): string {
  if (!address.trim()) return "—";
  const firstChunk = address.split(",")[0]?.trim() ?? "";
  const tokens = firstChunk.split(/\s+/);
  const numTok = tokens.find((t) => /^\d+[a-z]?$/i.test(t));
  const streetTok = tokens.find((t) => /^[A-Za-zÜÖÄÕüöäõ]/.test(t)) ?? "";
  return streetTok.charAt(0).toUpperCase() + (numTok ?? "");
}

export function Monogram({ address, buildingType, index, overallScore, overallLabel, onClose }: Props) {
  const glyph = deriveGlyph(address);
  const isMulti = !!buildingType && MULTI.some((m) => buildingType.toLowerCase().includes(m));
  const bgClass = isMulti ? "photo-cool" : "photo-warm";
  return (
    <div className={`relative w-full aspect-[4/3] ${bgClass}`}>
      <div
        aria-hidden="true"
        className="absolute inset-0 grid place-items-center"
        style={{ fontFamily: '"Fraunces", ui-serif, Georgia, serif', fontWeight: 300, fontSize: 96, lineHeight: 1, color: "#1A1A1A", opacity: 0.92, letterSpacing: "-0.04em" }}
      >
        {glyph}
      </div>
      <span className="absolute top-2 left-2 text-[10px] font-semibold tracking-wider uppercase bg-white/90 backdrop-blur px-2 py-0.5 text-ink">
        #{String(index + 1).padStart(2, "0")}
      </span>
      {onClose && (
        <button
          onClick={onClose}
          aria-label="Sulge"
          className="absolute top-2 right-2 w-7 h-7 grid place-items-center bg-white/90 backdrop-blur border border-rule text-ink text-[12px] hover:bg-ink hover:text-paper transition-colors"
        >
          ✕
        </button>
      )}
      {overallScore > 0 && (
        <span className="absolute bottom-2 right-2 bg-ink text-paper text-[10px] font-semibold tracking-wider uppercase px-2 py-0.5">
          {overallScore.toFixed(1)} / 5 · {overallLabel}
        </span>
      )}
    </div>
  );
}
