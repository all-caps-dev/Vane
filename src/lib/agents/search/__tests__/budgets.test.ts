// TypeScript: unit tests for the per-request research budgets (budgets.ts).
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  budgetEnvName,
  DEFAULT_BUDGETS,
  parseBudgets,
  RequestBudget,
} from '@/lib/agents/search/budgets';

// A tracer stand-in that keeps the events it is given.
const fakeTrace = () => {
  const events: { name: string; data: any }[] = [];
  const tracer = {
    event: (name: string, data: any) => events.push({ name, data }),
  } as any;
  return { events, tracer };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('budget defaults and overrides', () => {
  it('has the documented defaults', () => {
    expect(DEFAULT_BUDGETS.speed).toEqual({
      maxFetches: 0,
      maxBrowserFetches: 0,
      maxSearchCalls: 1,
      maxResearchMs: 30_000,
    });
    expect(DEFAULT_BUDGETS.balanced.maxFetches).toBe(12);
    expect(DEFAULT_BUDGETS.quality).toEqual({
      maxFetches: 24,
      maxBrowserFetches: 6,
      maxSearchCalls: 8,
      maxResearchMs: 180_000,
    });
  });

  it('names env variables VANE_BUDGET_<MODE>_<NAME>', () => {
    expect(budgetEnvName('quality', 'maxBrowserFetches')).toBe(
      'VANE_BUDGET_QUALITY_MAX_BROWSER_FETCHES',
    );
    expect(budgetEnvName('balanced', 'maxResearchMs')).toBe(
      'VANE_BUDGET_BALANCED_MAX_RESEARCH_MS',
    );
  });

  it('applies valid overrides and ignores junk', () => {
    const out = parseBudgets({
      VANE_BUDGET_QUALITY_MAX_FETCHES: '30',
      VANE_BUDGET_BALANCED_MAX_SEARCH_CALLS: 'lots',
      VANE_BUDGET_SPEED_MAX_RESEARCH_MS: '-5',
    });
    expect(out.quality.maxFetches).toBe(30);
    expect(out.balanced.maxSearchCalls).toBe(4);
    expect(out.speed.maxResearchMs).toBe(30_000);
  });
});

describe('RequestBudget', () => {
  const limits = {
    maxFetches: 2,
    maxBrowserFetches: 1,
    maxSearchCalls: 1,
    maxResearchMs: 1000,
  };

  it('decrements and refuses once a budget is spent', () => {
    const budget = new RequestBudget(limits);
    expect(budget.remaining('maxFetches')).toBe(2);
    expect(budget.take('maxFetches')).toBe(true);
    expect(budget.remaining('maxFetches')).toBe(1);
    expect(budget.take('maxFetches')).toBe(true);
    expect(budget.take('maxFetches')).toBe(false);
    expect(budget.remaining('maxFetches')).toBe(0);
    // Other budgets are independent.
    expect(budget.take('maxSearchCalls')).toBe(true);
    expect(budget.usage()).toMatchObject({ maxFetches: 2, maxSearchCalls: 1 });
  });

  it('records budget.exhausted once per budget', () => {
    const { events, tracer } = fakeTrace();
    const budget = new RequestBudget(limits, tracer);
    budget.take('maxBrowserFetches');
    budget.take('maxBrowserFetches');
    budget.take('maxBrowserFetches');

    const exhausted = events.filter((e) => e.name === 'budget.exhausted');
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0].data).toMatchObject({
      budget: 'maxBrowserFetches',
      limit: 1,
    });
    expect(budget.isExhausted('maxBrowserFetches')).toBe(true);
    expect(budget.usage().exhausted).toEqual(['maxBrowserFetches']);
  });

  it('a zero budget refuses the first take', () => {
    const budget = new RequestBudget({ ...limits, maxFetches: 0 });
    expect(budget.take('maxFetches')).toBe(false);
  });

  it('reports the time budget from Date.now', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(10_000);
    const budget = new RequestBudget(limits);
    now.mockReturnValue(10_999);
    expect(budget.timeExceeded()).toBe(false);
    now.mockReturnValue(11_000);
    expect(budget.timeExceeded()).toBe(true);
  });
});
