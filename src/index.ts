interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * OWID MCP — Our World in Data chart/indicator access (free, no auth)
 *
 * OWID has no public full-text search endpoint, but every chart at
 * ourworldindata.org/grapher/<slug> exposes its data as both CSV and JSON
 * metadata. This pack curates a list of high-signal indicators and lets
 * agents fetch any indicator by slug.
 *
 * Tools:
 * - list_popular_indicators: curated catalog grouped by category
 * - fetch_indicator: tidy long-format data for one indicator, optional country filter
 * - get_indicator_metadata: title, description, units, source, last updated
 */


const GRAPHER_BASE = 'https://ourworldindata.org/grapher';

interface IndicatorRef {
  slug: string;
  title: string;
  category: string;
}

const POPULAR: IndicatorRef[] = [
  // Energy
  { slug: 'energy-consumption-by-source', title: 'Energy consumption by source', category: 'energy' },
  { slug: 'electricity-generation', title: 'Electricity generation', category: 'energy' },
  { slug: 'share-electricity-renewables', title: 'Share of electricity from renewables', category: 'energy' },
  { slug: 'per-capita-energy-use', title: 'Energy use per person', category: 'energy' },
  { slug: 'global-primary-energy', title: 'Global primary energy by source', category: 'energy' },
  // Climate & emissions
  { slug: 'co-emissions-per-capita', title: 'CO₂ emissions per capita', category: 'climate' },
  { slug: 'annual-co2-emissions-per-country', title: 'Annual CO₂ emissions by country', category: 'climate' },
  { slug: 'cumulative-co-emissions', title: 'Cumulative CO₂ emissions', category: 'climate' },
  { slug: 'methane-emissions', title: 'Methane emissions', category: 'climate' },
  { slug: 'temperature-anomaly', title: 'Global mean surface temperature anomaly', category: 'climate' },
  { slug: 'sea-surface-temperature-anomaly', title: 'Sea surface temperature anomaly', category: 'climate' },
  // Health
  { slug: 'life-expectancy', title: 'Life expectancy at birth', category: 'health' },
  { slug: 'child-mortality', title: 'Child mortality rate', category: 'health' },
  { slug: 'maternal-mortality', title: 'Maternal mortality ratio', category: 'health' },
  { slug: 'share-of-deaths-by-cause', title: 'Share of deaths by cause', category: 'health' },
  { slug: 'share-of-adults-who-smoke', title: 'Share of adults who smoke', category: 'health' },
  { slug: 'covid-vaccination-doses-per-capita', title: 'COVID-19 vaccine doses per capita', category: 'health' },
  // Demographics
  { slug: 'population', title: 'Population', category: 'demographics' },
  { slug: 'population-growth-rates', title: 'Population growth rate', category: 'demographics' },
  { slug: 'fertility-rate', title: 'Fertility rate (children per woman)', category: 'demographics' },
  { slug: 'urban-population-share-2050', title: 'Urban population share', category: 'demographics' },
  // Economy
  { slug: 'gdp-per-capita-worldbank', title: 'GDP per capita (World Bank)', category: 'economy' },
  { slug: 'gdp-per-capita-maddison', title: 'GDP per capita (Maddison)', category: 'economy' },
  { slug: 'share-of-the-population-living-in-extreme-poverty', title: 'Extreme poverty rate', category: 'economy' },
  { slug: 'unemployment-rate', title: 'Unemployment rate', category: 'economy' },
  { slug: 'inflation-cpi', title: 'Consumer price inflation', category: 'economy' },
  // Food & agriculture
  { slug: 'global-food', title: 'Global food production', category: 'food' },
  { slug: 'cereal-yield', title: 'Cereal yield', category: 'food' },
  { slug: 'share-of-population-undernourished', title: 'Share of population undernourished', category: 'food' },
  { slug: 'agricultural-land', title: 'Agricultural land use', category: 'food' },
  // Education
  { slug: 'literate-and-illiterate-world-population', title: 'Literacy rate', category: 'education' },
  { slug: 'mean-years-of-schooling-long-run', title: 'Mean years of schooling', category: 'education' },
  // Environment
  { slug: 'forest-area-as-share-of-land-area', title: 'Forest area share of land', category: 'environment' },
  { slug: 'plastic-waste-per-capita', title: 'Plastic waste per capita', category: 'environment' },
  { slug: 'air-pollution-deaths-per-100000', title: 'Air pollution deaths per 100,000', category: 'environment' },
  // Tech & internet
  { slug: 'share-of-individuals-using-the-internet', title: 'Internet usage rate', category: 'tech' },
  { slug: 'cell-phones-per-100-people', title: 'Mobile phones per 100 people', category: 'tech' },
  // Conflict & politics
  { slug: 'military-expenditure-share-gdp', title: 'Military expenditure as share of GDP', category: 'politics' },
  { slug: 'democracy-index-eiu', title: 'Democracy index (EIU)', category: 'politics' },
  { slug: 'corruption-perception-index', title: 'Corruption perceptions index', category: 'politics' },
];

const tools: McpToolExport['tools'] = [
  {
    name: 'list_popular_indicators',
    description:
      'List curated Our World in Data indicators (slug + title) for common categories: energy, climate, health, demographics, economy, food, education, environment, tech, politics. Use the slug with fetch_indicator. Not exhaustive — visit ourworldindata.org for the full catalog.',
    inputSchema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          description: 'Optional category filter',
          enum: ['energy', 'climate', 'health', 'demographics', 'economy', 'food', 'education', 'environment', 'tech', 'politics'],
        },
      },
      required: [],
    },
  },
  {
    name: 'fetch_indicator',
    description:
      'Fetch tidy long-format data for an OWID indicator by slug (e.g., "co-emissions-per-capita", "life-expectancy"). Returns rows of {entity, year, value}. Optional country filter accepts ISO codes or names ("USA", "World", "China"). Browse slugs at ourworldindata.org/charts.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'OWID chart slug (the URL path segment)' },
        country: { type: 'string', description: 'Filter to a single entity (country/region name or ISO code)' },
        since_year: { type: 'number', description: 'Drop rows before this year' },
        until_year: { type: 'number', description: 'Drop rows after this year' },
        limit: { type: 'number', description: 'Cap number of rows returned (default 5000)' },
      },
      required: ['slug'],
    },
  },
  {
    name: 'get_indicator_metadata',
    description:
      'Fetch metadata for an OWID indicator: title, subtitle, units, source(s), last updated. Helpful before fetching to verify the slug.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'OWID chart slug' },
      },
      required: ['slug'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'list_popular_indicators':
      return listPopular(args.category as string | undefined);
    case 'fetch_indicator':
      return fetchIndicator(
        args.slug as string,
        args.country as string | undefined,
        args.since_year as number | undefined,
        args.until_year as number | undefined,
        (args.limit as number) ?? 5000,
      );
    case 'get_indicator_metadata':
      return getMetadata(args.slug as string);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function listPopular(category?: string) {
  const filtered = category ? POPULAR.filter((p) => p.category === category) : POPULAR;
  return {
    count: filtered.length,
    note: 'Use slug with fetch_indicator. For the full OWID catalog browse ourworldindata.org/charts.',
    indicators: filtered,
  };
}

async function fetchIndicator(
  slug: string,
  country: string | undefined,
  since: number | undefined,
  until: number | undefined,
  limit: number,
) {
  const url = `${GRAPHER_BASE}/${encodeURIComponent(slug)}.csv?v=1&csvType=full&useColumnShortNames=true`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`OWID error: ${res.status} (slug "${slug}" may not exist — check ourworldindata.org/grapher/${slug})`);
  }
  const csv = await res.text();
  const rows = parseCsv(csv);
  if (rows.length === 0) return { slug, count: 0, columns: [], rows: [] };

  const header = rows[0];
  const entityIdx = header.findIndex((h) => /^entity$/i.test(h));
  const yearIdx = header.findIndex((h) => /^year$/i.test(h));
  const valueCols = header
    .map((h, i) => ({ name: h, i }))
    .filter((c) => c.i !== entityIdx && c.i !== yearIdx && c.i !== header.findIndex((h2) => /^code$/i.test(h2)));

  const normCountry = country?.toLowerCase().trim();
  const out: Record<string, unknown>[] = [];
  for (let i = 1; i < rows.length && out.length < limit; i++) {
    const r = rows[i];
    const entity = entityIdx >= 0 ? r[entityIdx] : '';
    if (normCountry && entity.toLowerCase() !== normCountry) continue;
    const year = yearIdx >= 0 ? Number(r[yearIdx]) : NaN;
    if (since != null && year < since) continue;
    if (until != null && year > until) continue;

    const row: Record<string, unknown> = { entity, year: Number.isFinite(year) ? year : null };
    for (const c of valueCols) {
      const v = r[c.i];
      const num = v === '' || v == null ? null : Number(v);
      row[c.name] = Number.isFinite(num as number) ? num : v;
    }
    out.push(row);
  }

  return {
    slug,
    source_url: `https://ourworldindata.org/grapher/${slug}`,
    columns: ['entity', 'year', ...valueCols.map((c) => c.name)],
    count: out.length,
    rows: out,
  };
}

async function getMetadata(slug: string) {
  const url = `${GRAPHER_BASE}/${encodeURIComponent(slug)}.metadata.json?v=1`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`OWID error: ${res.status} (slug "${slug}" may not exist)`);
  }
  const meta = (await res.json()) as {
    chart?: { title?: string; subtitle?: string; note?: string };
    columns?: Record<
      string,
      {
        titleShort?: string;
        titleLong?: string;
        unit?: string;
        shortUnit?: string;
        descriptionShort?: string;
        descriptionFromProducer?: string;
        producerShort?: string;
        citationShort?: string;
        lastUpdated?: string;
        nextUpdate?: string;
      }
    >;
  };

  const cols = meta.columns ?? {};
  return {
    slug,
    source_url: `https://ourworldindata.org/grapher/${slug}`,
    title: meta.chart?.title ?? null,
    subtitle: meta.chart?.subtitle ?? null,
    note: meta.chart?.note ?? null,
    columns: Object.entries(cols).map(([key, c]) => ({
      key,
      title: c.titleLong ?? c.titleShort ?? key,
      unit: c.unit ?? c.shortUnit ?? null,
      description: c.descriptionShort ?? c.descriptionFromProducer ?? null,
      producer: c.producerShort ?? null,
      citation: c.citationShort ?? null,
      last_updated: c.lastUpdated ?? null,
      next_update: c.nextUpdate ?? null,
    })),
  };
}

// ── CSV parsing (minimal RFC-4180 subset OWID emits) ─────────────────
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') {
        row.push(cell);
        cell = '';
      } else if (ch === '\n') {
        row.push(cell);
        rows.push(row);
        row = [];
        cell = '';
      } else if (ch === '\r') {
        // skip; handled by \n
      } else {
        cell += ch;
      }
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
