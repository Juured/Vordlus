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
  // The full address format is "county, city, district, street+number".
  // The street+number chunk is the one containing a digit. Use that.
  const chunks = address.split(",").map((s) => s.trim()).filter(Boolean);
  // Find the chunk with a building number
  const withNumber = chunks.find((c) => /\d/.test(c));
  const target = withNumber ?? chunks[0] ?? "";
  const tokens = target.split(/\s+/);
  const streetTok = tokens[0] ?? "";
  const numTok = tokens.find((t) => /^\d+[a-z]?$/i.test(t));
  // If the first token starts with a digit, scan for a letter-starting token
  let letter = "";
  if (/^\d/.test(streetTok)) {
    const letterTok = tokens.find((t) => /^[a-zA-ZÜÖÄÕüöäõ]/.test(t));
    letter = letterTok ? letterTok.charAt(0).toUpperCase() : "";
  } else {
    letter = streetTok.charAt(0).toUpperCase();
  }
  return letter + (numTok ?? "");
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
