// TypeScript: per-request research budgets (fetches, browser fetches, search calls, wall time), enforced in code.
import type { Tracer } from '@/lib/trace';

export type BudgetMode = 'speed' | 'balanced' | 'quality';

export type BudgetLimits = {
  // Pages fetched by the evidence pipeline (HTTP attempts; a browser
  // fallback is part of the same fetch).
  maxFetches: number;
  // Headless-browser fallbacks. Playwright is the memory hog.
  maxBrowserFetches: number;
  // executeSearch calls made by the research loop's tools.
  maxSearchCalls: number;
  // Wall time for the research loop; checked between iterations.
  maxResearchMs: number;
};

export type BudgetName = keyof BudgetLimits;

/*
  Tuned for the 2-core, 4 GB deploy box (measured 2026-11-01: unbounded
  quality mode read 80 to 144 pages per question and was OOM-killed).
  Every number can be overridden with an environment variable named
  VANE_BUDGET_<MODE>_<NAME>, e.g. VANE_BUDGET_QUALITY_MAX_FETCHES=30 or
  VANE_BUDGET_BALANCED_MAX_RESEARCH_MS=120000. The variables are read once,
  on first use; a value that is not a non-negative integer is ignored.
*/
export const DEFAULT_BUDGETS: Record<BudgetMode, BudgetLimits> = {
  speed: {
    maxFetches: 0,
    maxBrowserFetches: 0,
    maxSearchCalls: 1,
    maxResearchMs: 30_000,
  },
  balanced: {
    maxFetches: 12,
    maxBrowserFetches: 3,
    maxSearchCalls: 4,
    maxResearchMs: 90_000,
  },
  quality: {
    maxFetches: 24,
    maxBrowserFetches: 6,
    maxSearchCalls: 8,
    maxResearchMs: 180_000,
  },
};

// Research loop iterations (LLM planning turns) per mode.
export const MAX_ITERATIONS: Record<BudgetMode, number> = {
  speed: 2,
  balanced: 6,
  quality: 6,
};

// Evidence-gap rounds per mode (gapCheck.ts). Quality's second round runs
// only when the first found gaps and its search brought new sources.
export const MAX_GAP_ROUNDS: Record<BudgetMode, number> = {
  speed: 0,
  balanced: 1,
  quality: 2,
};

const BUDGET_NAMES: BudgetName[] = [
  'maxFetches',
  'maxBrowserFetches',
  'maxSearchCalls',
  'maxResearchMs',
];

// maxFetches -> MAX_FETCHES
const envSuffix = (name: BudgetName) =>
  name.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase();

export const budgetEnvName = (mode: BudgetMode, name: BudgetName) =>
  `VANE_BUDGET_${mode.toUpperCase()}_${envSuffix(name)}`;

/* The defaults with any VANE_BUDGET_* overrides applied. Pure, so tests can
   pass their own env. */
export const parseBudgets = (
  env: Record<string, string | undefined>,
): Record<BudgetMode, BudgetLimits> => {
  const out = {} as Record<BudgetMode, BudgetLimits>;
  for (const mode of Object.keys(DEFAULT_BUDGETS) as BudgetMode[]) {
    const limits = { ...DEFAULT_BUDGETS[mode] };
    for (const name of BUDGET_NAMES) {
      const raw = env[budgetEnvName(mode, name)]?.trim();
      if (raw && /^\d+$/.test(raw)) limits[name] = Number(raw);
    }
    out[mode] = limits;
  }
  return out;
};

let parsed: Record<BudgetMode, BudgetLimits> | undefined;

// The limits for one mode; the environment is parsed once per process.
export const getBudgetLimits = (mode: BudgetMode): BudgetLimits => {
  parsed ??= parseBudgets(process.env);
  return { ...(parsed[mode] ?? parsed.balanced) };
};

// The counted budgets (maxResearchMs is a deadline, not a counter).
export type CountedBudget = Exclude<BudgetName, 'maxResearchMs'>;

/*
  One request's budgets. The Researcher creates it and puts it on the
  session next to `trace`; executeSearch and Scraper.scrape take from it.
  JavaScript runs one callback at a time, so take() needs no lock even when
  several fetches run "at once".
*/
export class RequestBudget {
  readonly limits: BudgetLimits;
  readonly startedAt: number;
  private used: Record<CountedBudget, number> = {
    maxFetches: 0,
    maxBrowserFetches: 0,
    maxSearchCalls: 0,
  };
  // Which budgets ran out, so each is traced once per request.
  private exhausted = new Set<BudgetName>();
  private trace?: Tracer;

  constructor(limits: BudgetLimits, trace?: Tracer, startedAt = Date.now()) {
    this.limits = { ...limits };
    this.trace = trace;
    this.startedAt = startedAt;
  }

  static forMode(mode: BudgetMode, trace?: Tracer): RequestBudget {
    return new RequestBudget(getBudgetLimits(mode), trace);
  }

  remaining(name: CountedBudget): number {
    return Math.max(0, this.limits[name] - this.used[name]);
  }

  /* Takes one unit. Returns false, and records 'budget.exhausted' the first
     time, when none is left. */
  take(name: CountedBudget): boolean {
    if (this.used[name] >= this.limits[name]) {
      this.markExhausted(name);
      return false;
    }
    this.used[name]++;
    return true;
  }

  elapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  // True once the research wall-time budget is spent.
  timeExceeded(): boolean {
    return this.elapsedMs() >= this.limits.maxResearchMs;
  }

  isExhausted(name: BudgetName): boolean {
    return this.exhausted.has(name);
  }

  // Records the 'budget.exhausted' trace event once per budget.
  markExhausted(name: BudgetName): void {
    if (this.exhausted.has(name)) return;
    this.exhausted.add(name);
    this.trace?.event('budget.exhausted', {
      budget: name,
      limit: this.limits[name],
      elapsedMs: this.elapsedMs(),
    });
  }

  // Counts for the research span.
  usage(): Record<CountedBudget, number> & { exhausted: BudgetName[] } {
    return { ...this.used, exhausted: [...this.exhausted] };
  }
}
