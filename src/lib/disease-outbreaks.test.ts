import { describe, it, expect } from 'vitest';
import {
  COUNTRY_REFS,
  WHO_ITEM_BASE,
  buildDiseaseReport,
  normaliseCountryText,
  normalizeWhoDon,
  placeOutbreak,
  type DiseaseOutbreak,
} from './disease-outbreaks';

/* Shapes below are trimmed from the live WHO DON OData feed:
   { "@odata.context": …, value: [{ Id, DonId, UrlName, ItemDefaultUrl, Title,
     Summary, Overview, Assessment, PublicationDateAndTime, … }] }.
   Every prose field arrives as an HTML fragment. */

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    Id: 'id-1',
    DonId: '2026-DON625',
    UrlName: '2026-DON625',
    ItemDefaultUrl: '/2026-DON625',
    Title: 'Ebola disease caused by Bundibugyo virus',
    Summary: '<p>An outbreak is ongoing.</p>',
    Overview: '<p>Cases have been reported.</p>',
    Assessment: '<p>Risk is assessed as high.</p>',
    PublicationDateAndTime: '2026-11-06T20:42:12Z',
    ...over,
  };
}

const payload = (...values: unknown[]) => ({ '@odata.context': 'https://www.who.int/api', value: values });

/** An already-normalised item, before placement. */
function item(over: Partial<DiseaseOutbreak> = {}): DiseaseOutbreak {
  return {
    id: 'x',
    title: 'Yellow fever — update',
    published: '2026-11-06T20:42:12Z',
    summary: '',
    overview: '',
    assessment: '',
    url: `${WHO_ITEM_BASE}2026-DON625`,
    donId: '2026-DON625',
    country: null,
    lat: null,
    lng: null,
    ...over,
  };
}

describe('normalizeWhoDon', () => {
  it('reads the OData envelope and trims the title', () => {
    const [out] = normalizeWhoDon(payload(row({ Title: '  Ebola virus  ' })));
    expect(out.title).toBe('Ebola virus');
  });

  it('strips HTML and decodes entities from every prose field', () => {
    const [out] = normalizeWhoDon(
      payload(
        row({
          Summary: '<p>Risk &amp; response &lt;ongoing&gt;</p>',
          Overview: '<p>First line</p><p>Second line</p>',
          Assessment: '<ul><li>Assessed</li></ul>',
        }),
      ),
    );
    expect(out.summary).toBe('Risk & response <ongoing>');
    expect(out.overview).toBe('First line\nSecond line');
    expect(out.assessment).toBe('Assessed');
  });

  it('sorts newest first, whatever order WHO sends', () => {
    const out = normalizeWhoDon(
      payload(
        row({ Id: 'old', PublicationDateAndTime: '2026-10-20T00:00:00Z' }),
        row({ Id: 'new', PublicationDateAndTime: '2026-11-06T00:00:00Z' }),
        row({ Id: 'mid', PublicationDateAndTime: '2026-11-01T00:00:00Z' }),
      ),
    );
    expect(out.map((o) => o.id)).toEqual(['new', 'mid', 'old']);
  });

  it('dedupes by id, keeping the first copy', () => {
    const out = normalizeWhoDon(
      payload(row({ Id: 'same', Title: 'First' }), row({ Id: 'same', Title: 'Second' })),
    );
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('First');
  });

  it('builds the item URL from ItemDefaultUrl, falling back to UrlName', () => {
    const out = normalizeWhoDon(
      payload(
        row({ Id: 'a', ItemDefaultUrl: '/2026-DON625' }),
        row({ Id: 'b', ItemDefaultUrl: undefined, UrlName: '2026-DON624' }),
      ),
    );
    expect(out.map((o) => o.url)).toEqual([
      `${WHO_ITEM_BASE}2026-DON625`,
      `${WHO_ITEM_BASE}2026-DON624`,
    ]);
  });

  it('refuses an absolute item URL that points off who.int', () => {
    const out = normalizeWhoDon(
      payload(
        row({ Id: 'ok', ItemDefaultUrl: 'https://www.who.int/emergencies/disease-outbreak-news/item/2026-DON625' }),
        row({ Id: 'bad', ItemDefaultUrl: 'https://evil.example/2026-DON625' }),
      ),
    );
    expect(out.map((o) => o.id)).toEqual(['ok']);
    expect(out[0].url).toBe(`${WHO_ITEM_BASE}2026-DON625`);
  });

  it('falls back through the publication timestamps, then yields an empty string', () => {
    const out = normalizeWhoDon(
      payload(
        row({ Id: 'a', PublicationDateAndTime: undefined, PublicationDate: '2026-11-02T19:00:00Z' }),
        row({ Id: 'b', PublicationDateAndTime: undefined, PublicationDate: undefined, DateCreated: '' }),
      ),
    );
    const byId = new Map(out.map((o) => [o.id, o]));
    expect(byId.get('a')?.published).toBe('2026-11-02T19:00:00.000Z');
    expect(byId.get('b')?.published).toBe('');
  });

  it('drops rows with no title or no usable URL', () => {
    const out = normalizeWhoDon(
      payload(
        row({ Id: 'a', Title: '', OverrideTitle: undefined, UrlName: undefined }),
        row({ Id: 'b', Title: 'Has a title', ItemDefaultUrl: undefined, UrlName: undefined }),
      ),
    );
    expect(out).toEqual([]);
  });

  it('answers an empty feed for malformed payloads rather than throwing', () => {
    expect(normalizeWhoDon(null)).toEqual([]);
    expect(normalizeWhoDon(undefined)).toEqual([]);
    expect(normalizeWhoDon(42)).toEqual([]);
    expect(normalizeWhoDon({ value: 'not an array' })).toEqual([]);
    expect(normalizeWhoDon([row()])).toHaveLength(1);
  });

  it('never attaches a country or coordinates while normalising', () => {
    const [out] = normalizeWhoDon(payload(row({ Title: 'Ebola — Democratic Republic of the Congo' })));
    expect(out.country).toBeNull();
    expect(out.lat).toBeNull();
    expect(out.lng).toBeNull();
  });
});

describe('placeOutbreak — country anchors, not guessed coordinates', () => {
  it('places a country named in the title', () => {
    const out = placeOutbreak(item({ title: 'Ebola disease — Democratic Republic of the Congo' }));
    expect(out.country).toEqual({ name: 'Democratic Republic of the Congo', code: 'CD' });
    expect(out.lat).toBeCloseTo(-3);
    expect(out.lng).toBeCloseTo(24);
  });

  it('prefers the title over a body that names a different country', () => {
    const out = placeOutbreak(
      item({ title: 'Measles — United Kingdom', overview: 'Cases were also reported in France.' }),
    );
    expect(out.country?.code).toBe('GB');
  });

  it('falls back to the body when the title names no country', () => {
    const out = placeOutbreak(item({ title: 'Yellow fever — update', overview: 'Transmission continues in Kenya.' }));
    expect(out.country?.code).toBe('KE');
  });

  it('does not guess when nothing matches', () => {
    const out = placeOutbreak(item({ title: 'Yellow fever — WHO African Region' }));
    expect(out.country).toBeNull();
    expect(out.lat).toBeNull();
    expect(out.lng).toBeNull();
  });

  it('names a country it has no centroid for without inventing coordinates', () => {
    const out = placeOutbreak(item({ title: 'Malaria — eSwatini' }));
    expect(out.country).toEqual({ name: 'eSwatini', code: 'SZ' });
    expect(out.lat).toBeNull();
    expect(out.lng).toBeNull();
  });

  it('longest name wins for nested names', () => {
    expect(placeOutbreak(item({ title: 'Outbreak — Democratic Republic of the Congo' })).country?.code).toBe('CD');
    expect(placeOutbreak(item({ title: 'Outbreak — Republic of the Congo' })).country?.code).toBe('CG');
    expect(placeOutbreak(item({ title: 'Outbreak — Guinea-Bissau' })).country?.code).toBe('GW');
    expect(placeOutbreak(item({ title: 'Outbreak — Papua New Guinea' })).country?.code).toBe('PG');
  });

  it('matches whole words: Niger is not Nigeria', () => {
    expect(placeOutbreak(item({ title: 'Measles — Nigeria' })).country?.code).toBe('NG');
    expect(placeOutbreak(item({ title: 'Measles — Niger' })).country?.code).toBe('NE');
  });

  it('matches the spellings WHO actually publishes', () => {
    const cases: [string, string][] = [
      ["Côte d'Ivoire", 'CI'],
      ['Ivory Coast', 'CI'],
      ['Türkiye', 'TR'],
      ['Turkey', 'TR'],
      ['Republic of Korea', 'KR'],
      ['South Korea', 'KR'],
      ['DPRK', 'KP'],
      ['Lao PDR', 'LA'],
      ['Viet Nam', 'VN'],
      ['Russian Federation', 'RU'],
      ['Islamic Republic of Iran', 'IR'],
      ['Czech Republic', 'CZ'],
      ['Swaziland', 'SZ'],
      ['Burma', 'MM'],
      ['Cape Verde', 'CV'],
      ['United States of America', 'US'],
      ['UK', 'GB'],
    ];
    for (const [name, code] of cases) {
      expect(placeOutbreak(item({ title: `Outbreak — ${name}` })).country?.code, name).toBe(code);
    }
  });

  it('matches acronyms case-sensitively so the pronoun "us" is not a country', () => {
    expect(placeOutbreak(item({ title: 'Outbreak — US' })).country?.code).toBe('US');
    expect(placeOutbreak(item({ title: 'This is with us' })).country).toBeNull();
  });

  it('is pure: the input item is left untouched', () => {
    const original = item({ title: 'Cholera — Haiti' });
    const placed = placeOutbreak(original);
    expect(original.country).toBeNull();
    expect(placed.country?.code).toBe('HT');
  });

  it('folds diacritics before matching', () => {
    expect(normaliseCountryText("Côte d'Ivoire")).toBe("Cote d'Ivoire");
  });
});

describe('the country table', () => {
  it('covers at least a hundred countries', () => {
    expect(COUNTRY_REFS.length).toBeGreaterThanOrEqual(100);
  });

  it('keys every entry by an ISO alpha-2 code', () => {
    for (const [code] of COUNTRY_REFS) expect(code).toMatch(/^[A-Z]{2}$/);
  });
});

describe('buildDiseaseReport', () => {
  it('counts countries and takes the newest publication date', () => {
    const report = buildDiseaseReport(
      payload(
        row({
          Id: 'a',
          Title: 'Ebola — Democratic Republic of the Congo',
          PublicationDateAndTime: '2026-11-06T00:00:00Z',
        }),
        row({
          Id: 'b',
          Title: 'Yellow fever — Kenya',
          PublicationDateAndTime: '2026-11-01T00:00:00Z',
        }),
        row({
          Id: 'c',
          Title: 'Cholera — Kenya',
          PublicationDateAndTime: '2026-10-20T00:00:00Z',
        }),
      ),
    );
    expect(report.total).toBe(3);
    expect(report.countries).toBe(2);
    expect(report.latest).toBe('2026-11-06T00:00:00.000Z');
    expect(report.source).toBe('WHO Disease Outbreak News');
    expect(report.outbreaks[0].country?.code).toBe('CD');
  });

  it('empty payload yields a coherent empty report', () => {
    expect(buildDiseaseReport({ value: [] })).toEqual({
      outbreaks: [],
      total: 0,
      countries: 0,
      latest: null,
      source: 'WHO Disease Outbreak News',
    });
  });
});
