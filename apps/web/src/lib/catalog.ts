import { z } from "zod";

const artworkSchema = z.object({
  slug: z.string().min(1),
  title: z.string().min(1),
  artist: z.string().min(1),
  year: z.number().int().min(1000).max(2100),
  medium: z.string().min(1),
  location: z.string().min(1),
  valuationUsd: z.number().positive(),
  fractionPriceUsd: z.number().positive(),
  totalFractions: z.number().int().positive(),
  availableFractions: z.number().int().nonnegative(),
  projectSlug: z.string().min(1),
  status: z.enum(["Verified", "Vault ready", "Fractionalized"]),
  accent: z.tuple([z.string(), z.string()]),
  description: z.string().min(40),
  provenance: z.array(z.string().min(1)).min(2),
});

const projectSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  curator: z.string().min(1),
  location: z.string().min(1),
  thesis: z.string().min(40),
  assetSlugs: z.array(z.string().min(1)).min(1),
  accent: z.tuple([z.string(), z.string()]),
});

export type Artwork = z.infer<typeof artworkSchema>;
export type Project = z.infer<typeof projectSchema>;

const rawArtworks: Artwork[] = [
  {
    slug: "blue-hour-archive",
    title: "Blue Hour Archive",
    artist: "Mina Okafor",
    year: 2024,
    medium: "Pigment, linen, mineral ground",
    location: "Lagos",
    valuationUsd: 184000,
    fractionPriceUsd: 46,
    totalFractions: 4000,
    availableFractions: 1620,
    projectSlug: "material-memory",
    status: "Fractionalized",
    accent: ["#264653", "#d6a84b"],
    description:
      "A layered study of evening light and urban memory, documented from studio completion through independent condition review.",
    provenance: [
      "Artist studio record",
      "Independent condition report",
      "Curator intake review",
    ],
  },
  {
    slug: "soft-monument-no-3",
    title: "Soft Monument No. 3",
    artist: "Ana Ribeiro",
    year: 2023,
    medium: "Woven fiber and natural dye",
    location: "Lisbon",
    valuationUsd: 96000,
    fractionPriceUsd: 32,
    totalFractions: 3000,
    availableFractions: 780,
    projectSlug: "material-memory",
    status: "Vault ready",
    accent: ["#9b5d46", "#e4c6a1"],
    description:
      "Hand-woven fiber turns architectural weight into a tactile surface, with a custody record prepared for testnet vaulting.",
    provenance: [
      "Workshop certificate",
      "Material analysis",
      "Custody intake record",
    ],
  },
  {
    slug: "field-notes-vii",
    title: "Field Notes VII",
    artist: "Eli Navarro",
    year: 2022,
    medium: "Oil, wax, and graphite on panel",
    location: "Mexico City",
    valuationUsd: 128000,
    fractionPriceUsd: 40,
    totalFractions: 3200,
    availableFractions: 1184,
    projectSlug: "signals-in-earth",
    status: "Verified",
    accent: ["#566246", "#d5a64f"],
    description:
      "A cartographic abstraction built from field sketches, soil tones, and erased marks, presented with a complete studio record.",
    provenance: [
      "Studio inventory",
      "Gallery exhibition record",
      "High-resolution condition capture",
    ],
  },
  {
    slug: "kinetic-plain",
    title: "Kinetic Plain",
    artist: "Sora Han",
    year: 2025,
    medium: "Aluminum, lacquer, and light",
    location: "Seoul",
    valuationUsd: 242000,
    fractionPriceUsd: 55,
    totalFractions: 4400,
    availableFractions: 2160,
    projectSlug: "light-as-structure",
    status: "Vault ready",
    accent: ["#725d8a", "#ddd4a7"],
    description:
      "A modular light work whose changing reflection is captured through installation diagrams, component records, and conservator notes.",
    provenance: [
      "Fabrication log",
      "Installation diagrams",
      "Conservator component review",
    ],
  },
  {
    slug: "afterimage-garden",
    title: "Afterimage Garden",
    artist: "Noor Al-Sayed",
    year: 2024,
    medium: "Archival print and hand-applied pigment",
    location: "Amman",
    valuationUsd: 76000,
    fractionPriceUsd: 25,
    totalFractions: 3040,
    availableFractions: 920,
    projectSlug: "light-as-structure",
    status: "Verified",
    accent: ["#476f67", "#e0a79a"],
    description:
      "Botanical fragments and architectural shadows meet in a numbered edition documented from capture to final pigment application.",
    provenance: [
      "Edition certificate",
      "Print studio record",
      "Curator authenticity review",
    ],
  },
  {
    slug: "weather-system-i",
    title: "Weather System I",
    artist: "Jules Mensah",
    year: 2023,
    medium: "Ceramic, glaze, and steel",
    location: "Accra",
    valuationUsd: 152000,
    fractionPriceUsd: 38,
    totalFractions: 4000,
    availableFractions: 1440,
    projectSlug: "signals-in-earth",
    status: "Fractionalized",
    accent: ["#274c54", "#c77745"],
    description:
      "A ceramic assembly maps pressure and movement through repeated forms, backed by firing records and a component-level condition survey.",
    provenance: [
      "Kiln and firing record",
      "Component inventory",
      "Independent condition survey",
    ],
  },
];

const rawProjects: Project[] = [
  {
    slug: "material-memory",
    name: "Material Memory",
    curator: "Atelier North",
    location: "Lisbon · Lagos",
    thesis:
      "A study of how fiber, pigment, and repeated handwork can carry personal history into durable public records.",
    assetSlugs: ["blue-hour-archive", "soft-monument-no-3"],
    accent: ["#7e4c3d", "#d9b16f"],
  },
  {
    slug: "signals-in-earth",
    name: "Signals in Earth",
    curator: "Common Field Office",
    location: "Accra · Mexico City",
    thesis:
      "Works that translate weather, terrain, and field observation into objects with transparent material and custody histories.",
    assetSlugs: ["field-notes-vii", "weather-system-i"],
    accent: ["#344d45", "#c8824f"],
  },
  {
    slug: "light-as-structure",
    name: "Light as Structure",
    curator: "Meridian Assembly",
    location: "Seoul · Amman",
    thesis:
      "A collection about light as both a physical material and a documentation problem across installation, print, and time.",
    assetSlugs: ["kinetic-plain", "afterimage-garden"],
    accent: ["#4b526f", "#d1bd85"],
  },
];

export const artworks = z.array(artworkSchema).parse(rawArtworks);
export const projects = z.array(projectSchema).parse(rawProjects);

export function getArtwork(slug: string) {
  return artworks.find((artwork) => artwork.slug === slug);
}

export function getProject(slug: string) {
  return projects.find((project) => project.slug === slug);
}

export function getProjectArtworks(project: Project) {
  return project.assetSlugs
    .map(getArtwork)
    .filter((artwork): artwork is Artwork => Boolean(artwork));
}

export function formatUsd(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}
