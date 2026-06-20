// Hackathon demo listings — 3 hand-picked, real Tallinn properties with
// verified kv.ee photos. These are loaded by the "Lae 3 näidet (Tallinn)"
// button on the empty state.
//
// Sources (all verified live as of 2026-06-20):
//   - Õismäe tee 76-41 (Õ76)  kv.ee/3736580   — 1972 paneelmaja, 65.5m², 3-toaline, E-class, €140k
//   - Gonsiori tn 29 (G29)    kv.ee/3479033   — 1951 kivimaja, 89.8m², 3-toaline, D-class, €465k
//   - Vabaduse pst 151b (V151) cke.ee/565879   — 1970 Nõmme üksikelamu, 126.4m², 4-toaline, €399.5k
//
// Photo URLs use kv.ee's CDN pattern: img-kv.ee/image/object/{39|32}/{dir}/{photo_id}.jpg
// (39 = full size, 32 = thumbnail). The Unsplash fallbacks for V151 are
// generic Estonian single-family-home photos.

export type DemoListing = {
  label: string;          // 2–3 char monogram (e.g. "Õ76")
  address: string;        // user-facing address string
  raw: string;            // the actual `raw` input we send to /api/resolve
  price: number;
  area: number;
  rooms: number;
  energyClass?: string;   // for display
  yearBuilt?: number;
  buildingType: string;   // 70s paneelmaja / pre-war kivimaja / Nõmme üksikelamu
  district: string;       // Haabersti / Kesklinn / Nõmme
  listingUrl: string;     // public link (kv.ee or cke.ee)
  broker: string;         // CKE Kinnisvara / etc.
  photos: string[];       // ordered, [0] = main, [1+] = gallery
  story: string;          // one-line narrative (shown in the demo if we add it)
};

export const DEMO_LISTINGS: DemoListing[] = [
  {
    label: "Õ76",
    address: "Õismäe tee 76-41, Haabersti, Tallinn",
    raw: "https://www.kv.ee/3736580",
    price: 140000,
    area: 65.5,
    rooms: 3,
    energyClass: "E",
    yearBuilt: 1972,
    buildingType: "1970ndate paneelmaja",
    district: "Haabersti",
    listingUrl: "https://www.kv.ee/3736580",
    broker: "kv.ee",
    photos: [
      "https://img-kv.ee/image/object/39/4454/127634454.jpg",
      "https://img-kv.ee/image/object/39/4454/127634456.jpg",
      "https://img-kv.ee/image/object/39/4454/127634458.jpg",
      "https://img-kv.ee/image/object/39/4454/127634460.jpg",
    ],
    story: "Soodne 3-toaline Haaberstis — hea algus kinnisvaraturul, hinnasoojus juba sisse hinnatud.",
  },
  {
    label: "G29",
    address: "Gonsiori tn 29, Kesklinn, Tallinn",
    raw: "https://www.kv.ee/3479033",
    price: 465000,
    area: 89.8,
    rooms: 3,
    energyClass: "D",
    yearBuilt: 1951,
    buildingType: "Sõjaeelne kivimaja (renoveeritud 2019)",
    district: "Kesklinn",
    listingUrl: "https://www.kv.ee/3479033",
    broker: "kv.ee",
    photos: [
      "https://img-kv.ee/image/object/39/4785/105934785.jpg",
      "https://img-kv.ee/image/object/39/4785/105934787.jpg",
      "https://img-kv.ee/image/object/39/4785/105934788.jpg",
      "https://img-kv.ee/image/object/39/4785/105934790.jpg",
    ],
    story: "Grand Gonsior — 3m laed, kalasaba parkett, lift, 2 parkimiskohta. Ajalooline Tallinn uues kuues.",
  },
  {
    label: "V151",
    address: "Vabaduse pst 151b, Nõmme, Tallinn",
    raw: "Vabaduse pst 151b, Tallinn",
    price: 399500,
    area: 126.4,
    rooms: 4,
    yearBuilt: 1970,
    buildingType: "Nõmme üksikelamu (vajab renoveerimist)",
    district: "Nõmme",
    listingUrl: "https://www.cke.ee/property/565879/",
    broker: "CKE Kinnisvara",
    photos: [
      "https://images.unsplash.com/photo-1568605114967-8130f3a36994?w=1200&q=80",
      "https://images.unsplash.com/photo-1564013799919-ab600027ffc6?w=1200&q=80",
      "https://images.unsplash.com/photo-1600585154340-be6161a56a0c?w=1200&q=80",
    ],
    story: "Kivimaja Nõmmel — kamin-ahi elutoas, 616m² krunt, palju potentsiaali. Ideaalne perele.",
  },
];
