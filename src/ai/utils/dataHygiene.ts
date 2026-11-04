/**
 * 6-Gate Data Hygiene & Categorical Entity Clustering Engine
 * Provides deterministic + domain-synonym + Jaro-Winkler clustering,
 * robust accounting/international number parsing, and embedded subtotal detection.
 */

const NULL_SENTINELS = new Set([
  '',
  '-',
  '--',
  '—',
  'n/a',
  'na',
  '#n/a',
  'null',
  'none',
  'nil',
  'undefined',
  'nan',
  'tbd',
  'missing',
]);

/**
 * Gate 2: Robust Numeric & Accounting Parser
 * Handles:
 * - Accounting negatives: "($1,250.50)" -> -1250.5
 * - Trailing minus: "1,250-" -> -1250
 * - Magnitude suffixes: "$1.2M" -> 1200000, "450K" -> 450000, "2.5B" -> 2500000000
 * - Currency symbols: $, €, £, ¥, ₹, etc.
 * - Null sentinels: "N/A", "-", "TBD" -> null
 */
export function parseRobustNumber(val: any): number | null {
  if (val === null || val === undefined || typeof val === 'boolean') return null;
  if (typeof val === 'number') {
    return Number.isFinite(val) ? val : null;
  }

  let s = String(val).trim();
  if (!s || NULL_SENTINELS.has(s.toLowerCase())) return null;
  if (s.startsWith('#') || s.startsWith('=')) return null;

  let isNegative = false;
  // Accounting parentheses e.g. ($1,250.50) or (1,250)
  if (/^\(.*\)$/.test(s)) {
    isNegative = true;
    s = s.slice(1, -1).trim();
  } else if (s.endsWith('-') && /\d/.test(s)) {
    isNegative = true;
    s = s.slice(0, -1).trim();
  } else if (s.startsWith('-')) {
    isNegative = true;
    s = s.slice(1).trim();
  }

  // Strip currency symbols and whitespace
  s = s.replace(/[$€£¥₹₩₪₫฿\s]/g, '');
  if (!s) return null;

  // Check magnitude suffix (K, M, B, T)
  let multiplier = 1;
  const suffixMatch = s.match(/^([0-9.,]+)\s*([KkMmBbTt])$/);
  if (suffixMatch) {
    s = suffixMatch[1];
    const suf = suffixMatch[2].toUpperCase();
    if (suf === 'K') multiplier = 1e3;
    else if (suf === 'M') multiplier = 1e6;
    else if (suf === 'B') multiplier = 1e9;
    else if (suf === 'T') multiplier = 1e12;
  } else if (s.endsWith('%')) {
    s = s.slice(0, -1).trim();
  }

  // Handle EU vs US decimal/thousand separators
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > lastDot && lastDot !== -1) {
    // e.g. 1.250,50 -> EU format
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (lastComma !== -1 && lastDot === -1) {
    // Either 1,250 (US integer) or 12,50 (EU decimal)
    const parts = s.split(',');
    if (parts.length === 2 && parts[1].length !== 3) {
      s = s.replace(',', '.');
    } else {
      s = s.replace(/,/g, '');
    }
  } else {
    s = s.replace(/,/g, '');
  }

  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const parsed = parseFloat(s) * multiplier;
  if (!Number.isFinite(parsed)) return null;
  return isNegative ? -parsed : parsed;
}

/**
 * Jaro-Winkler string similarity [0..1]
 */
export function jaroWinklerSimilarity(s1: string, s2: string): number {
  if (s1 === s2) return 1.0;
  const len1 = s1.length;
  const len2 = s2.length;
  if (len1 === 0 || len2 === 0) return 0.0;

  const matchDistance = Math.max(0, Math.floor(Math.max(len1, len2) / 2) - 1);
  const s1Matches = new Array(len1).fill(false);
  const s2Matches = new Array(len2).fill(false);

  let matches = 0;
  for (let i = 0; i < len1; i++) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, len2);
    for (let j = start; j < end; j++) {
      if (s2Matches[j]) continue;
      if (s1[i] !== s2[j]) continue;
      s1Matches[i] = true;
      s2Matches[j] = true;
      matches++;
      break;
    }
  }

  if (matches === 0) return 0.0;

  let t = 0;
  let k = 0;
  for (let i = 0; i < len1; i++) {
    if (!s1Matches[i]) continue;
    while (!s2Matches[k]) k++;
    if (s1[i] !== s2[k]) t++;
    k++;
  }
  t /= 2;

  const jaro = (matches / len1 + matches / len2 + (matches - t) / matches) / 3;
  let prefix = 0;
  const maxPrefix = Math.min(4, len1, len2);
  for (let i = 0; i < maxPrefix; i++) {
    if (s1[i] === s2[i]) prefix++;
    else break;
  }

  return jaro + prefix * 0.1 * (1 - jaro);
}

/**
 * Domain abbreviation & synonym dictionary -> canonical lowercase target
 */
const DOMAIN_ABBREVIATION_MAP: Record<string, string> = {
  // Compass / Regions
  n: 'north',
  no: 'north',
  nth: 'north',
  northern: 'north',
  s: 'south',
  so: 'south',
  sth: 'south',
  southern: 'south',
  e: 'east',
  ea: 'east',
  eastern: 'east',
  w: 'west',
  we: 'west',
  western: 'west',
  ne: 'northeast',
  'n.e': 'northeast',
  nw: 'northwest',
  'n.w': 'northwest',
  se: 'southeast',
  's.e': 'southeast',
  sw: 'southwest',
  's.w': 'southwest',
  cen: 'central',
  cntr: 'central',
  // Countries
  us: 'united states',
  usa: 'united states',
  'u.s': 'united states',
  'u.s.a': 'united states',
  uk: 'united kingdom',
  gb: 'united kingdom',
  gbr: 'united kingdom',
  // Departments
  hr: 'human resources',
  eng: 'engineering',
  fin: 'finance',
  mkt: 'marketing',
  mktg: 'marketing',
  ops: 'operations',
  acct: 'accounting',
  it: 'information technology',
  cs: 'customer success',
  rd: 'research and development',
  'r&d': 'research and development',
};

const CANONICAL_DISTINCT_TERMS = new Set([
  'north',
  'south',
  'east',
  'west',
  'northeast',
  'northwest',
  'southeast',
  'southwest',
  'central',
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
  'q1',
  'q2',
  'q3',
  'q4',
  'male',
  'female',
  'active',
  'inactive',
  'credit',
  'debit',
]);

export interface CategoryClusterItem {
  canonicalValue: string;
  totalCount: number;
  variants: Array<{ rawValue: string; count: number }>;
}

export interface CategoryClusterResult {
  hasCollisions: boolean;
  totalDistinctRaw: number;
  totalCanonicalGroups: number;
  mapping: Record<string, string>; // dirtyRawValue -> canonicalValue
  canonicalCounts: Record<string, number>;
  clusters: CategoryClusterItem[];
  collisionSummary: string[];
}

function normalizeLookupKey(str: string): string {
  return str
    .trim()
    .toLowerCase()
    .replace(/[.,;!?]+$/g, '') // strip trailing punctuation like "N." -> "n"
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Checks whether two strings differ in embedded numbers or single-character tier identifiers
 * (e.g., "Store 1" vs "Store 2", "Tier A" vs "Tier B") so they are NEVER falsely merged.
 */
function hasConflictingIdentifierTokens(a: string, b: string): boolean {
  const numsA = a.match(/\d+/g) || [];
  const numsB = b.match(/\d+/g) || [];
  if (numsA.join(',') !== numsB.join(',')) return true;

  // Check single-letter suffix like "Tier A" vs "Tier B" or "Type X" vs "Type Y"
  const suffixLetterA = a.trim().match(/\b([a-zA-Z])$/);
  const suffixLetterB = b.trim().match(/\b([a-zA-Z])$/);
  if (suffixLetterA && suffixLetterB && suffixLetterA[1].toLowerCase() !== suffixLetterB[1].toLowerCase()) {
    return true;
  }

  const normA = normalizeLookupKey(a);
  const normB = normalizeLookupKey(b);
  if (CANONICAL_DISTINCT_TERMS.has(normA) && CANONICAL_DISTINCT_TERMS.has(normB) && normA !== normB) {
    return true;
  }

  return false;
}

/**
 * Gate 4: 4-Stage Categorical Entity Clustering
 * Detects and groups case collisions, trailing punctuation ("N."), abbreviations ("N" -> "North"),
 * and high-confidence typos while protecting distinct alphanumeric IDs ("Store 1" vs "Store 2").
 */
export function clusterCategoryValues(rawValues: any[]): CategoryClusterResult {
  const exactFreq = new Map<string, number>();

  for (const v of rawValues) {
    if (v === null || v === undefined) continue;
    const str = String(v);
    if (str.trim() === '') continue;
    exactFreq.set(str, (exactFreq.get(str) || 0) + 1);
  }

  // Sort distinct raw values by frequency descending, then length descending (prefer full words like "North" over "N")
  const sortedRaw = Array.from(exactFreq.entries()).sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return b[0].trim().length - a[0].trim().length;
  });

  // Map normalized key -> best canonical display string
  const canonicalGroups = new Map<
    string,
    {
      canonicalDisplay: string;
      normKey: string;
      variants: Array<{ rawValue: string; count: number }>;
      totalCount: number;
    }
  >();

  // First pass: group by deterministic normalized key (case + whitespace + trailing punctuation)
  for (const [rawVal, count] of sortedRaw) {
    const trimmed = rawVal.trim();
    const normKey = normalizeLookupKey(trimmed);
    if (!normKey) continue;

    const existing = canonicalGroups.get(normKey);
    if (existing) {
      existing.variants.push({ rawValue: rawVal, count });
      existing.totalCount += count;
      // Prefer properly capitalized full form without trailing spaces
      if (
        existing.canonicalDisplay !== existing.canonicalDisplay.trim() &&
        rawVal === trimmed
      ) {
        existing.canonicalDisplay = trimmed;
      }
    } else {
      canonicalGroups.set(normKey, {
        canonicalDisplay: trimmed,
        normKey,
        variants: [{ rawValue: rawVal, count }],
        totalCount: count,
      });
    }
  }

  // Second pass: merge domain abbreviations (e.g. "n" -> "north", "w" -> "west")
  // if the target canonical key exists in canonicalGroups!
  const groupKeys = Array.from(canonicalGroups.keys());
  for (const key of groupKeys) {
    const group = canonicalGroups.get(key);
    if (!group) continue;
    const strippedKey = key.replace(/\./g, '');
    const mappedTarget = DOMAIN_ABBREVIATION_MAP[key] || DOMAIN_ABBREVIATION_MAP[strippedKey];
    if (mappedTarget && mappedTarget !== key && canonicalGroups.has(mappedTarget)) {
      const targetGroup = canonicalGroups.get(mappedTarget)!;
      targetGroup.variants.push(...group.variants);
      targetGroup.totalCount += group.totalCount;
      canonicalGroups.delete(key);
    }
  }

  // Third pass: Jaro-Winkler >= 0.91 fuzzy clustering for multi-character strings (len >= 4)
  const remainingGroups = Array.from(canonicalGroups.values()).sort(
    (a, b) => b.totalCount - a.totalCount
  );
  const mergedIndices = new Set<number>();

  for (let i = 0; i < remainingGroups.length; i++) {
    if (mergedIndices.has(i)) continue;
    const primary = remainingGroups[i];
    if (primary.normKey.length < 4) continue;

    for (let j = i + 1; j < remainingGroups.length; j++) {
      if (mergedIndices.has(j)) continue;
      const candidate = remainingGroups[j];
      if (candidate.normKey.length < 4) continue;
      if (hasConflictingIdentifierTokens(primary.canonicalDisplay, candidate.canonicalDisplay)) {
        continue;
      }

      const sim = jaroWinklerSimilarity(primary.normKey, candidate.normKey);
      if (sim >= 0.91) {
        primary.variants.push(...candidate.variants);
        primary.totalCount += candidate.totalCount;
        mergedIndices.add(j);
        canonicalGroups.delete(candidate.normKey);
      }
    }
  }

  // Build final output
  const mapping: Record<string, string> = {};
  const canonicalCounts: Record<string, number> = {};
  const clusters: CategoryClusterItem[] = [];
  const collisionSummary: string[] = [];

  const finalGroups = Array.from(canonicalGroups.values()).sort(
    (a, b) => b.totalCount - a.totalCount
  );

  for (const g of finalGroups) {
    canonicalCounts[g.canonicalDisplay] = g.totalCount;
    clusters.push({
      canonicalValue: g.canonicalDisplay,
      totalCount: g.totalCount,
      variants: g.variants,
    });

    const dirtyVariants: string[] = [];
    for (const v of g.variants) {
      if (v.rawValue !== g.canonicalDisplay) {
        mapping[v.rawValue] = g.canonicalDisplay;
        dirtyVariants.push(`"${v.rawValue}" (${v.count})`);
      }
    }

    if (dirtyVariants.length > 0) {
      collisionSummary.push(
        `"${g.canonicalDisplay}" (${g.totalCount} total) <- merges ${dirtyVariants.join(', ')}`
      );
    }
  }

  return {
    hasCollisions: Object.keys(mapping).length > 0,
    totalDistinctRaw: exactFreq.size,
    totalCanonicalGroups: finalGroups.length,
    mapping,
    canonicalCounts,
    clusters,
    collisionSummary,
  };
}

/**
 * Gate 1: Detects embedded "Subtotal", "Sub-Total", or "Grand Total" summary rows inside a table.
 * Returns 1-based Excel row numbers.
 */
export function detectEmbeddedSubtotalRows(rows2D: any[][], hasHeader: boolean = true): number[] {
  if (!Array.isArray(rows2D) || rows2D.length <= 1) return [];
  const startR = hasHeader ? 1 : 0;
  const trapRowNumbers: number[] = [];

  const subtotalRegex = /^(sub[\s-]*total|grand[\s-]*total|total(\s+all|\s+revenue|\s+sales)?)$/i;

  for (let r = startR; r < rows2D.length; r++) {
    const row = rows2D[r];
    if (!Array.isArray(row)) continue;

    // Check first 3 columns for summary keywords
    const checkCols = Math.min(row.length, 3);
    for (let c = 0; c < checkCols; c++) {
      const cellStr = String(row[c] ?? '').trim();
      if (cellStr && subtotalRegex.test(cellStr)) {
        trapRowNumbers.push(r + 1); // 1-based Excel row number
        break;
      }
    }
  }

  return trapRowNumbers;
}
