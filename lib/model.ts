// Launch Radar — the token-radar-01 model: one sealed snapshot in, one ranked board out.
//
// The board ranks every protocol in the snapshot that records no token and is not an exchange or a
// versioned pool: the 40 watchlist slugs (the floor, never the ceiling) plus every pre-token protocol
// below the floor. Live-token protocols are kept apart and shown with the market's own values.
//
// Implied value is fitted from the snapshot itself, never from a list of names:
//
//   comps     = exp(a + b * ln(tvl_usd))            OLS on the traded protocols (log market cap on
//                                                    log TVL), fitted at run time from this snapshot
//   catAdj    = shrunk median log-residual of the protocol's category (categories with >= 8 traded
//                                                    protocols; shrunk by n / (n + 8), clamped to [-1, 1])
//   growth    = 1 + clamp(change_7d, -60, 120) / 100 * 0.5
//   maturity  = 0.6 + min(age_days, 1095) / 1095 * 0.4   (age unknown: 365 days)
//   odds      = the peers' record: among protocols listed at least as long ago as this one, the
//                                                    share whose token already trades, clamped to [0.05, 0.50]
//   implied   = comps * exp(catAdj) * growth * maturity * odds
//
// The fit is validated two ways at run time and the numbers are printed on the dashboard: a held-out
// split (every 5th traded protocol by slug, fitted on the rest) and a walk-forward split (fitted on
// protocols listed before 2025-01-01, tested on those listed after). Both report the median absolute
// log error, so the reader sees how far a comps value can be off.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, stated on the dashboard and changeable in one place. */
export interface ModelConstants {
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  category_min_n: number;
  category_shrink: number;
  category_clamp: number;
  odds_floor: number;
  odds_cap: number;
  airdrop_share: number;
  farmer_count: number;
  walkforward_cutoff: string;
}

export const MODEL: ModelConstants = {
  growth_weight: 0.5,
  growth_floor: -60,
  growth_cap: 120,
  maturity_floor: 0.6,
  maturity_range: 0.4,
  maturity_days: 1095,
  unknown_age_days: 365,
  category_min_n: 8,
  category_shrink: 8,
  category_clamp: 1,
  odds_floor: 0.05,
  odds_cap: 0.5,
  airdrop_share: 0.05,
  farmer_count: 10000,
  walkforward_cutoff: '2025-01-01',
};

/** The model's version label: the dashboard names it. */
export const MODEL_VERSION = 'radar-2-fitted';

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** The fitted comps curve and its two validations, all computed from this snapshot. */
export interface FitReport {
  n_traded: number;
  intercept: number;
  slope: number;
  r2: number;
  resid_sd: number;
  median_ratio: number;
  heldout_n: number;
  heldout_median_log_err: number;
  walkforward_train_n: number;
  walkforward_test_n: number;
  walkforward_median_log_err: number;
  categories: { category: string; n: number; adjustment: number }[];
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    comps_value_usd: number;
    category: string | null;
    category_adjustment: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    launch_odds: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** The dashboard's compact view of one row. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  comps_value_usd: number;
  category_adjustment: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  launch_odds: number;
  watchlist: boolean;
  farm_steps: string[];
}

/** A live-token protocol: it already trades, so the board shows the market's own value. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard needs: the board, the live set, the fit and the model. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  fit: FitReport;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** Ordinary least squares of log(mcap) on log(tvl); null when the set cannot be fitted. */
function ols(traded: SnapshotProtocol[]): { a: number; b: number } | null {
  const pts = traded.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
  if (pts.length < 10) return null;
  const xs = pts.map((p) => Math.log(p.tvl_usd));
  const ys = pts.map((p) => Math.log(p.mcap_usd!));
  const mx = xs.reduce((s, v) => s + v, 0) / xs.length;
  const my = ys.reduce((s, v) => s + v, 0) / ys.length;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < xs.length; i++) {
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    sxx += (xs[i]! - mx) * (xs[i]! - mx);
  }
  if (sxx === 0) return null;
  const b = sxy / sxx;
  return { a: my - b * mx, b };
}

/** The median of a sorted-by-value copy; null when empty. */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Fit the comps curve on the traded protocols and validate it twice, all from this snapshot. */
export function fitComps(snapshot: Snapshot, model: ModelConstants = MODEL): FitReport {
  const traded = snapshot.protocols
    .filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0)
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  const fit = ols(traded);
  if (fit === null) throw new SnapshotError('snapshot has too few traded protocols to fit the comps curve');
  const { a, b } = fit;
  const resid = traded.map((p) => Math.log(p.mcap_usd!) - (a + b * Math.log(p.tvl_usd)));
  const meanY = traded.reduce((s, p) => s + Math.log(p.mcap_usd!), 0) / traded.length;
  const ssRes = resid.reduce((s, r) => s + r * r, 0);
  const ssTot = traded.reduce((s, p) => s + (Math.log(p.mcap_usd!) - meanY) ** 2, 0);
  const r2 = ssTot === 0 ? 0 : 1 - ssRes / ssTot;
  const residSd = Math.sqrt(ssRes / Math.max(1, traded.length - 2));
  const ratios = traded.map((p) => p.mcap_usd! / p.tvl_usd).sort((x, y) => x - y);
  const medianRatio = median(ratios) ?? 0;

  // Held-out: every 5th traded protocol by slug is the test set; the rest fits.
  const test = traded.filter((_, i) => i % 5 === 4);
  const train = traded.filter((_, i) => i % 5 !== 4);
  const heldFit = ols(train) ?? fit;
  const heldErrs = test.map((p) => Math.abs(Math.log(p.mcap_usd!) - (heldFit.a + heldFit.b * Math.log(p.tvl_usd))));
  const heldoutMedian = median(heldErrs) ?? 0;

  // Walk-forward: fit on protocols listed before the cutoff, test on those listed after it.
  const wfTrain = traded.filter((p) => p.listed_at !== null && p.listed_at < model.walkforward_cutoff);
  const wfTest = traded.filter((p) => p.listed_at !== null && p.listed_at >= model.walkforward_cutoff);
  const wfFit = ols(wfTrain) ?? fit;
  const wfErrs = wfTest.map((p) => Math.abs(Math.log(p.mcap_usd!) - (wfFit.a + wfFit.b * Math.log(p.tvl_usd))));
  const wfMedian = median(wfErrs) ?? 0;

  // Category adjustments: the shrunk median log-residual per category with enough traded protocols.
  const byCat = new Map<string, number[]>();
  for (const p of traded) {
    const key = p.category ?? 'Uncategorised';
    const list = byCat.get(key) ?? [];
    list.push(Math.log(p.mcap_usd!) - (a + b * Math.log(p.tvl_usd)));
    byCat.set(key, list);
  }
  const categories: FitReport['categories'] = [];
  for (const [category, rs] of [...byCat.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
    if (rs.length < model.category_min_n) continue;
    const med = median(rs) ?? 0;
    const shrunk = med * (rs.length / (rs.length + model.category_shrink));
    const adj = Math.max(-model.category_clamp, Math.min(model.category_clamp, shrunk));
    categories.push({ category, n: rs.length, adjustment: round4(adj) });
  }

  return {
    n_traded: traded.length,
    intercept: round4(a),
    slope: round4(b),
    r2: round4(r2),
    resid_sd: round4(residSd),
    median_ratio: round4(medianRatio),
    heldout_n: test.length,
    heldout_median_log_err: round4(heldoutMedian),
    walkforward_train_n: wfTrain.length,
    walkforward_test_n: wfTest.length,
    walkforward_median_log_err: round4(wfMedian),
    categories,
  };
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** The watchlist's own exclusion rule, applied to the whole board: a wrapped, staked or bridged
 *  product of a token that already trades is not a launch, so it is never ranked — WBTC is
 *  Bitcoin on Ethereum, Binance staked ETH is ETH in a staking product, and neither is a protocol
 *  still waiting on a launch of its own. */
const EXCLUDED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
const EXCHANGE_NAMES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/** Whether a protocol is one the board may rank: pre-token, not an exchange, not a versioned pool,
 *  not a bridge, not a liquid-staking or restaking product, its name carrying no wrapped/staked
 *  word and not beginning with an exchange's name. */
export function isRankable(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return false;
  if (VERSIONED.test(p.name)) return false;
  if (WRAPPED_WORD.test(p.name)) return false;
  if (EXCHANGE_NAMES.some((e) => p.name.startsWith(e))) return false;
  return true;
}

/** The peers' record for a protocol of this age: the share of protocols listed at least as long ago
 *  whose token already trades (a market cap recorded). A protocol that has waited longer has more
 *  age-mates that launched — the odds rise with age, and stay well below one. */
export function launchOdds(p: SnapshotProtocol, snapshot: Snapshot, model: ModelConstants = MODEL): number {
  const age = ageDays(snapshot.as_of, p.listed_at);
  const cohort = snapshot.protocols.filter((q) => {
    const qa = ageDays(snapshot.as_of, q.listed_at);
    if (qa === null) return false;
    return age === null ? true : qa >= age;
  });
  if (cohort.length === 0) return model.odds_floor;
  const withToken = cohort.filter((q) => q.mcap_usd !== null).length;
  const odds = withToken / cohort.length;
  return Math.max(model.odds_floor, Math.min(model.odds_cap, odds));
}

/** The multipliers and the implied value one protocol gets under the fitted model. */
export function impliedValue(
  p: SnapshotProtocol,
  snapshot: Snapshot,
  fit: FitReport,
  catAdj: Map<string, number>,
  model: ModelConstants = MODEL,
): { implied: number; comps: number; cat: number; growthPct: number; growthMult: number; maturityMult: number; odds: number; age: number | null } {
  const age = ageDays(snapshot.as_of, p.listed_at);
  const comps = Math.exp(fit.intercept + fit.slope * Math.log(p.tvl_usd));
  const cat = catAdj.get(p.category ?? 'Uncategorised') ?? 0;
  const rawGrowth = finite(p.change_7d, 0);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMult = model.maturity_floor + (Math.min(Math.max(ageForModel, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
  const odds = launchOdds(p, snapshot, model);
  const implied = Math.max(1, Math.round(comps * Math.exp(cat) * growthMult * maturityMult * odds));
  return { implied, comps: Math.round(comps), cat, growthPct, growthMult, maturityMult, odds, age };
}

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, fit: FitReport, model: ModelConstants = MODEL): BoardRow[] {
  const catAdj = new Map(fit.categories.map((c) => [c.category, c.adjustment]));
  const index = bySlug(snapshot.protocols);
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug on it, whatever its TVL.
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: every other rankable pre-token protocol in the snapshot, below the floor or
  // not — the floor is never the whole board.
  for (const p of snapshot.protocols) {
    if (!chosen.has(p.slug) && isRankable(p)) chosen.set(p.slug, p);
  }

  const scored = [...chosen.values()].map((p) => {
    const v = impliedValue(p, snapshot, fit, catAdj, model);
    return { p, ...v };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    age_days: s.age,
    implied_value_usd: s.implied,
    model: {
      comps_value_usd: s.comps,
      category: s.p.category,
      category_adjustment: round4(s.cat),
      growth_pct: s.growthPct,
      growth_multiplier: round4(s.growthMult),
      maturity_multiplier: round4(s.maturityMult),
      launch_odds: round4(s.odds),
      age_days: s.age,
    },
    farm_steps: farmSteps(s.p, s.age, s.implied, model).map(stepText),
  }));
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** Gas for one transaction on the protocol's first chain, in whole dollars. */
function gasFor(chain: string): number {
  return chain === 'Ethereum' ? 8 : 2;
}

/** The category's one action, in the words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Deposit $${capital} of USDC as margin on ${name} and open one small hedge.`;
  if (c.includes('prediction')) return `Fund $${capital} and place one market position on ${name}.`;
  if (c.includes('curator') || c.includes('allocator') || c.includes('risk')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('rwa')) return `Mint $${capital} of the protocol's yield asset on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.`;
  if (c.includes('governance')) return `Deposit $${capital} and vote once on ${name}'s live proposal on ${chain}.`;
  if (c.includes('payment')) return `Send $${capital} through ${name} on ${chain} and keep the receipt.`;
  if (c.includes('basis') || c.includes('cedefi')) return `Deposit $${capital} of USDC into ${name}'s vault on ${chain} and keep the shares.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/**
 * A protocol's farm plan: seven steps, each an action with a cost and a time. The plan is derived
 * from the protocol's own record (category, chains, TVL, age, implied value), never from a
 * hand-written list of names. The last step is the verdict: the model's own maths on whether the
 * position pays, so a reader can tell a farm worth doing from one worth skipping.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null, implied: number, model: ModelConstants = MODEL): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = gasFor(chain);
  const action = actionFor(p, capital, chain);
  const share = (implied * model.airdrop_share) / model.farmer_count;
  const gasTotal = gas * 6;
  const verdict =
    share >= capital * 0.5
      ? `The model's verdict is farm it: if 5% of the $${implied.toLocaleString('en-US')} implied value reached 10,000 farmers, one share is about $${Math.round(share).toLocaleString('en-US')}, against roughly $${gasTotal} of gas on ${chain}.`
      : `The model's verdict is farm it only if you would use it anyway: if 5% of the $${implied.toLocaleString('en-US')} implied value reached 10,000 farmers, one share is about $${Math.round(share).toLocaleString('en-US')}, against roughly $${gasTotal} of gas on ${chain}.`;
  return [
    {
      text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`,
      cost: `under $${gas} of gas for the first transaction`,
      time: '5 minutes',
    },
    {
      text: action,
      cost: `$${capital} of capital and about $${gas} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: `Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.`,
      cost: `about $${gas} of gas a week`,
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.`,
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: `Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
    {
      text: verdict,
      cost: `about $${gasTotal} of gas across the plan`,
      time: `${hold} days from the first deposit`,
    },
  ];
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** A board row's compact form for data.js. */
export function radarRow(row: BoardRow, watchlist: Set<string>): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    comps_value_usd: row.model.comps_value_usd,
    category_adjustment: row.model.category_adjustment,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    launch_odds: row.model.launch_odds,
    watchlist: watchlist.has(row.slug),
    farm_steps: row.farm_steps,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData; fit: FitReport } {
  const fit = fitComps(snapshot, model);
  const board = buildBoard(snapshot, fit, model);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    fit,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    rows: board.map((r) => radarRow(r, new Set(snapshot.watchlist))),
    live,
  };
  return { board, radar, fit };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
