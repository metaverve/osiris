/**
 * OSIRIS — WHO Disease Outbreak News normaliser.
 *
 * WHO publishes Disease Outbreak News (DON) as keyless OData JSON:
 * `{ "@odata.context": …, value: [{ Id, DonId, UrlName, ItemDefaultUrl,
 * Title, Summary, Overview, Assessment, PublicationDateAndTime, … }] }`.
 * The prose fields are HTML fragments, and — this is the contract that matters —
 * a DON item carries no severity score and no coordinates. WHO names the
 * affected countries in text, and nothing more precise is offerable, so this
 * module derives a country from the text and places it on that country's
 * centroid. It never invents a location: no country match means lat/lng null.
 *
 * Pure and dependency-free apart from the centroid table, so both the route and
 * the client can rely on the same shape. `DiseaseReport` is the object returned
 * by `buildDiseaseReport`, which the route caches.
 */

import { centroidFor } from '@/lib/countryCentroids';

export interface DiseaseOutbreak {
  id: string;
  title: string;
  /** ISO 8601 publication timestamp. Empty string when WHO sent none. */
  published: string;
  summary: string;
  overview: string;
  assessment: string;
  url: string;
  donId: string | null;
  /** Affected country, when the text names one. Centroid anchor, not an event site. */
  country: { name: string; code: string } | null;
  lat: number | null;
  lng: number | null;
}

export interface DiseaseReport {
  outbreaks: DiseaseOutbreak[];
  total: number;
  countries: number;
  latest: string | null;
  source: string;
}

export const WHO_DON_SOURCE = 'WHO Disease Outbreak News';

/** WHO's public item pages live here; ItemDefaultUrl is the slug after it. */
const WHO_ITEM_PATH = '/emergencies/disease-outbreak-news/item/';
export const WHO_ITEM_BASE = `https://www.who.int${WHO_ITEM_PATH}`;

/* ═══════════════════════════════════════════════════════════════
   HTML → text
   ═══════════════════════════════════════════════════════════════ */

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', hellip: '…', bull: '•', middot: '·',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»',
  copy: '©', reg: '®', trade: '™', deg: '°', times: '×', euro: '€', pound: '£',
  eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç', uuml: 'ü', ouml: 'ö', auml: 'ä',
};

/** Decode the entities WHO actually emits, plus numeric references. */
function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * Flatten a WHO HTML fragment to readable text.
 *
 * Kept local rather than imported from a server module: this file is compiled
 * into the client bundle for the panel, and the repo's `htmlToText` lives next
 * to the Telegram scraper. Same contract, fewer imports.
 */
export function htmlToText(input: unknown): string {
  if (typeof input !== 'string' || !input.trim()) return '';
  const text = input
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|ul|ol|blockquote|h[1-6]|tr|table)>/gi, '\n')
    .replace(/<[^>]*>/g, ' ');
  return decodeEntities(text)
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** A single line of text — for titles, ids and slugs. */
function oneLine(input: unknown): string {
  return htmlToText(input).replace(/\s+/g, ' ').trim();
}

/** Guard against an upstream sending a whole article in one field. */
const TEXT_CAP = 4000;

function capped(input: unknown): string {
  const text = htmlToText(input);
  if (text.length <= TEXT_CAP) return text;
  const cut = text.slice(0, TEXT_CAP);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > TEXT_CAP * 0.8 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/* ═══════════════════════════════════════════════════════════════
   Country placement
   ═══════════════════════════════════════════════════════════════ */

type CountryRef = readonly [code: string, name: string, aliases?: readonly string[]];

/**
 * Country names and the aliases WHO text actually uses → ISO alpha-2.
 *
 * Aliases exist for the spellings in DON titles: WHO writes "Democratic
 * Republic of the Congo", "Côte d'Ivoire", "Türkiye", "Republic of Korea",
 * "Lao PDR" and "Viet Nam" far more often than the short English forms. A few
 * codes below have no centroid in the shared table (e.g. eSwatini); the country
 * is still named, the coordinates stay null rather than guessed.
 */
export const COUNTRY_REFS: readonly CountryRef[] = [
  // Africa
  ['DZ', 'Algeria'], ['AO', 'Angola'], ['BJ', 'Benin'], ['BW', 'Botswana'],
  ['BF', 'Burkina Faso'], ['BI', 'Burundi'], ['CV', 'Cabo Verde', ['Cape Verde']],
  ['CM', 'Cameroon'], ['CF', 'Central African Republic'], ['TD', 'Chad'], ['KM', 'Comoros'],
  ['CG', 'Republic of the Congo', ['Congo Republic', 'Congo-Brazzaville']],
  ['CD', 'Democratic Republic of the Congo',
    ['Democratic Republic of Congo', 'DR Congo', 'DRC', 'Congo, Democratic Republic of the']],
  ['CI', "Côte d'Ivoire", ['Ivory Coast']], ['DJ', 'Djibouti'], ['EG', 'Egypt'],
  ['GQ', 'Equatorial Guinea'], ['ER', 'Eritrea'], ['SZ', 'eSwatini', ['Eswatini', 'Swaziland']],
  ['ET', 'Ethiopia'], ['GA', 'Gabon'], ['GM', 'Gambia', ['The Gambia']], ['GH', 'Ghana'],
  ['GN', 'Guinea'], ['GW', 'Guinea-Bissau'], ['KE', 'Kenya'], ['LS', 'Lesotho'],
  ['LR', 'Liberia'], ['LY', 'Libya'], ['MG', 'Madagascar'], ['MW', 'Malawi'], ['ML', 'Mali'],
  ['MR', 'Mauritania'], ['MU', 'Mauritius'], ['MA', 'Morocco'], ['MZ', 'Mozambique'],
  ['NA', 'Namibia'], ['NE', 'Niger'], ['NG', 'Nigeria'], ['RW', 'Rwanda'],
  ['ST', 'São Tomé and Príncipe', ['Sao Tome and Principe']], ['SN', 'Senegal'],
  ['SC', 'Seychelles'], ['SL', 'Sierra Leone'], ['SO', 'Somalia'], ['ZA', 'South Africa'],
  ['SS', 'South Sudan'], ['SD', 'Sudan'], ['TZ', 'Tanzania', ['United Republic of Tanzania']],
  ['TG', 'Togo'], ['TN', 'Tunisia'], ['UG', 'Uganda'], ['ZM', 'Zambia'], ['ZW', 'Zimbabwe'],
  // Americas
  ['AR', 'Argentina'], ['BS', 'Bahamas'], ['BB', 'Barbados'], ['BZ', 'Belize'],
  ['BO', 'Bolivia', ['Plurinational State of Bolivia']], ['BR', 'Brazil'], ['CA', 'Canada'],
  ['CL', 'Chile'], ['CO', 'Colombia'], ['CR', 'Costa Rica'], ['CU', 'Cuba'],
  ['DO', 'Dominican Republic'], ['EC', 'Ecuador'], ['SV', 'El Salvador'], ['GT', 'Guatemala'],
  ['GY', 'Guyana'], ['HT', 'Haiti'], ['HN', 'Honduras'], ['JM', 'Jamaica'], ['MX', 'Mexico'],
  ['NI', 'Nicaragua'], ['PA', 'Panama'], ['PY', 'Paraguay'], ['PE', 'Peru'],
  ['PR', 'Puerto Rico'], ['SR', 'Suriname'], ['TT', 'Trinidad and Tobago'],
  ['US', 'United States', ['United States of America', 'USA', 'U.S.', 'U.S.A.', 'US']],
  ['UY', 'Uruguay'], ['VE', 'Venezuela', ['Bolivarian Republic of Venezuela']],
  // Asia
  ['AF', 'Afghanistan'], ['AM', 'Armenia'], ['AZ', 'Azerbaijan'], ['BH', 'Bahrain'],
  ['BD', 'Bangladesh'], ['BT', 'Bhutan'], ['BN', 'Brunei', ['Brunei Darussalam']],
  ['KH', 'Cambodia'], ['CN', 'China', ["People's Republic of China"]], ['CY', 'Cyprus'],
  ['GE', 'Georgia'], ['HK', 'Hong Kong'], ['IN', 'India'], ['ID', 'Indonesia'],
  ['IR', 'Iran', ['Islamic Republic of Iran']], ['IQ', 'Iraq'], ['IL', 'Israel'],
  ['JP', 'Japan'], ['JO', 'Jordan'], ['KZ', 'Kazakhstan'],
  ['KP', 'North Korea', ['DPRK', "Democratic People's Republic of Korea"]],
  ['KR', 'South Korea', ['Republic of Korea']], ['KW', 'Kuwait'],
  ['KG', 'Kyrgyzstan', ['Kyrgyz Republic']],
  ['LA', 'Laos', ['Lao PDR', "Lao People's Democratic Republic"]], ['LB', 'Lebanon'],
  ['MO', 'Macau', ['Macao']], ['MY', 'Malaysia'], ['MV', 'Maldives'], ['MN', 'Mongolia'],
  ['MM', 'Myanmar', ['Burma']], ['NP', 'Nepal'], ['OM', 'Oman'], ['PK', 'Pakistan'],
  ['PS', 'Palestine', ['State of Palestine', 'Palestinian Territories', 'Gaza Strip', 'West Bank']],
  ['PH', 'Philippines'], ['QA', 'Qatar'], ['SA', 'Saudi Arabia'], ['SG', 'Singapore'],
  ['LK', 'Sri Lanka'], ['SY', 'Syria', ['Syrian Arab Republic']], ['TW', 'Taiwan'],
  ['TJ', 'Tajikistan'], ['TH', 'Thailand'], ['TL', 'Timor-Leste', ['East Timor']],
  ['TR', 'Türkiye', ['Turkey', 'Turkiye']], ['TM', 'Turkmenistan'],
  ['AE', 'United Arab Emirates', ['UAE']], ['UZ', 'Uzbekistan'],
  ['VN', 'Vietnam', ['Viet Nam']], ['YE', 'Yemen'],
  // Europe
  ['AL', 'Albania'], ['AD', 'Andorra'], ['AT', 'Austria'], ['BY', 'Belarus'],
  ['BE', 'Belgium'], ['BA', 'Bosnia and Herzegovina', ['Bosnia']], ['BG', 'Bulgaria'],
  ['HR', 'Croatia'], ['CZ', 'Czechia', ['Czech Republic']], ['DK', 'Denmark'],
  ['EE', 'Estonia'], ['FI', 'Finland'], ['FR', 'France'], ['DE', 'Germany'],
  ['GR', 'Greece'], ['HU', 'Hungary'], ['IS', 'Iceland'], ['IE', 'Ireland'],
  ['IT', 'Italy'], ['XK', 'Kosovo'], ['LV', 'Latvia'], ['LI', 'Liechtenstein'],
  ['LT', 'Lithuania'], ['LU', 'Luxembourg'], ['MT', 'Malta'],
  ['MD', 'Moldova', ['Republic of Moldova']], ['MC', 'Monaco'], ['ME', 'Montenegro'],
  ['NL', 'Netherlands', ['Holland', 'The Netherlands']],
  ['MK', 'North Macedonia', ['Macedonia']], ['NO', 'Norway'], ['PL', 'Poland'],
  ['PT', 'Portugal'], ['RO', 'Romania'], ['RU', 'Russia', ['Russian Federation']],
  ['SM', 'San Marino'], ['RS', 'Serbia'], ['SK', 'Slovakia'], ['SI', 'Slovenia'],
  ['ES', 'Spain'], ['SE', 'Sweden'], ['CH', 'Switzerland'], ['UA', 'Ukraine'],
  ['GB', 'United Kingdom', ['UK', 'Great Britain', 'Britain']],
  ['VA', 'Vatican City', ['Holy See']],
  // Oceania
  ['AU', 'Australia'], ['FJ', 'Fiji'], ['NZ', 'New Zealand'], ['PG', 'Papua New Guinea'],
  ['WS', 'Samoa'], ['TO', 'Tonga'], ['VU', 'Vanuatu'], ['SB', 'Solomon Islands'],
];

interface CountryMatcher {
  code: string;
  name: string;
  alias: string;
  rx: RegExp;
}

/**
 * Fold a text into the form the alias table is written in: diacritics stripped
 * ("Côte d'Ivoire" → "Cote d'Ivoire", "Türkiye" → "Turkiye"), typographic
 * apostrophes and dashes straightened, whitespace collapsed. Case is preserved
 * because short acronyms are matched case-sensitively.
 */
export function normaliseCountryText(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Every alias as a whole-word matcher, longest first.
 *
 * Longest-first is what disambiguates the nested names WHO writes: "Democratic
 * Republic of the Congo" must win over "Republic of the Congo", "Guinea-Bissau"
 * over "Guinea", "Papua New Guinea" over "New Guinea". A two- or three-letter
 * acronym is matched case-sensitively for the same reason: as a word, "US" is
 * far more often a pronoun than a country.
 */
const COUNTRY_MATCHERS: readonly CountryMatcher[] = (() => {
  const out: CountryMatcher[] = [];
  const seen = new Set<string>();
  for (const [code, name, extra = []] of COUNTRY_REFS) {
    for (const alias of [name, ...extra]) {
      const folded = normaliseCountryText(alias);
      if (!folded || seen.has(folded)) continue;
      seen.add(folded);
      const acronym = folded.length <= 3 && folded === folded.toUpperCase();
      out.push({
        code,
        name,
        alias: folded,
        rx: new RegExp(
          `(?<![\\p{L}\\p{N}])${escapeRegExp(folded)}(?![\\p{L}\\p{N}])`,
          acronym ? 'u' : 'iu',
        ),
      });
    }
  }
  return out.sort((a, b) => b.alias.length - a.alias.length);
})();

function countryIn(text: string): CountryMatcher | null {
  if (!text) return null;
  for (const matcher of COUNTRY_MATCHERS) {
    if (matcher.rx.test(text)) return matcher;
  }
  return null;
}

/**
 * Fill the country and its centroid anchor from the bulletin's text.
 *
 * The title leads: a DON headline is curated by WHO and names the affected
 * countries, whereas the body often lists every country in a region. When the
 * title names nothing, overview and summary are searched together. When
 * nothing matches, country stays null and so do lat/lng — WHO gives no
 * coordinates and a region name is not a location.
 */
export function placeOutbreak(item: DiseaseOutbreak): DiseaseOutbreak {
  const title = normaliseCountryText(oneLine(item.title));
  const body = normaliseCountryText(`${item.overview} ${item.summary}`);
  const hit = countryIn(title) ?? countryIn(body);
  if (!hit) return { ...item, country: null, lat: null, lng: null };

  const centroid = centroidFor(hit.code);
  return {
    ...item,
    country: { name: hit.name, code: hit.code },
    // centroidFor returns [lng, lat]; unknown codes (e.g. SZ) keep null.
    lat: centroid ? centroid[1] : null,
    lng: centroid ? centroid[0] : null,
  };
}

/* ═══════════════════════════════════════════════════════════════
   Normalisation
   ═══════════════════════════════════════════════════════════════ */

interface WhoDonRow {
  Id?: unknown;
  DonId?: unknown;
  UrlName?: unknown;
  ItemDefaultUrl?: unknown;
  Title?: unknown;
  OverrideTitle?: unknown;
  Summary?: unknown;
  Overview?: unknown;
  Assessment?: unknown;
  PublicationDateAndTime?: unknown;
  PublicationDate?: unknown;
  DateCreated?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** The OData envelope's rows, tolerating a bare array as well. */
function rowsOf(payload: unknown): WhoDonRow[] {
  if (Array.isArray(payload)) return payload.filter(isRecord) as WhoDonRow[];
  if (isRecord(payload) && Array.isArray(payload.value)) {
    return payload.value.filter(isRecord) as WhoDonRow[];
  }
  return [];
}

/** ISO string for a timestamp WHO sent, or '' when it sent something useless. */
function isoOf(value: unknown): string {
  const raw = oneLine(value);
  if (!raw) return '';
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? '' : new Date(ms).toISOString();
}

/**
 * WHO's item URL. The API returns `ItemDefaultUrl` as a site-relative slug
 * ("/2026-DON625"); this pins it under the known item path rather than trusting
 * an arbitrary absolute URL. Verified live: both forms resolve 200.
 */
function itemUrl(row: WhoDonRow): string {
  const raw = oneLine(row.ItemDefaultUrl) || oneLine(row.UrlName);
  if (!raw) return '';
  let slug = raw;
  if (/^https?:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw);
      if (!/(^|\.)who\.int$/i.test(parsed.hostname)) return '';
      // An absolute URL WHO already resolved: keep it when it is under the
      // canonical item path, otherwise take just its path and re-pin it.
      if (parsed.pathname.startsWith(WHO_ITEM_PATH)) {
        return `${parsed.origin}${parsed.pathname}`;
      }
      slug = parsed.pathname;
    } catch {
      return '';
    }
  }
  const path = slug
    .split('/')
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join('/');
  return path ? `${WHO_ITEM_BASE}${path}` : '';
}

/**
 * Normalise a WHO DON payload: trim, strip HTML, drop unusable rows, dedupe by
 * id and sort newest first. Malformed input — null, a non-array `value`, a
 * proxy error page — yields an empty list rather than throwing.
 */
export function normalizeWhoDon(payload: unknown): DiseaseOutbreak[] {
  const byId = new Map<string, DiseaseOutbreak>();

  for (const row of rowsOf(payload)) {
    const title = oneLine(row.Title) || oneLine(row.OverrideTitle) || oneLine(row.UrlName);
    // A bulletin without a title is not something the panel can render.
    if (!title) continue;

    const url = itemUrl(row);
    if (!url) continue;

    const donId = oneLine(row.DonId) || oneLine(row.UrlName) || null;
    const id = oneLine(row.Id) || donId || url;
    if (byId.has(id)) continue;

    byId.set(id, {
      id,
      title,
      published:
        isoOf(row.PublicationDateAndTime) || isoOf(row.PublicationDate) || isoOf(row.DateCreated),
      summary: capped(row.Summary),
      overview: capped(row.Overview),
      assessment: capped(row.Assessment),
      url,
      donId,
      country: null,
      lat: null,
      lng: null,
    });
  }

  const publishedMs = (item: DiseaseOutbreak): number => {
    const ms = Date.parse(item.published);
    return Number.isNaN(ms) ? 0 : ms;
  };
  return [...byId.values()].sort((a, b) => publishedMs(b) - publishedMs(a));
}

/** Roll already-normalised rows into the report shape the route returns. */
export function summariseOutbreaks(outbreaks: DiseaseOutbreak[]): DiseaseReport {
  const codes = new Set<string>();
  for (const item of outbreaks) {
    if (item.country) codes.add(item.country.code);
  }
  const latest = outbreaks.find((item) => item.published)?.published ?? null;
  return {
    outbreaks,
    total: outbreaks.length,
    countries: codes.size,
    latest,
    source: WHO_DON_SOURCE,
  };
}

/** Payload → placed, sorted, deduped rows plus the counts the route publishes. */
export function buildDiseaseReport(payload: unknown): DiseaseReport {
  return summariseOutbreaks(normalizeWhoDon(payload).map(placeOutbreak));
}
