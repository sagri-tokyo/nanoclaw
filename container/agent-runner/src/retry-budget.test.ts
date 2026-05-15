import { describe, it, expect } from 'vitest';
import {
  RetryBudget,
  DEFAULT_MAX_529_RETRIES,
  readMax529Retries,
} from './retry-budget.js';

describe('RetryBudget', () => {
  it('does not flag exceeded while count stays at or below the budget', () => {
    const budget = new RetryBudget(2);
    expect(budget.consume({ errorStatus: 529 })).toEqual({
      exceeded: false,
      count: 1,
    });
    expect(budget.consume({ errorStatus: 529 })).toEqual({
      exceeded: false,
      count: 2,
    });
  });

  it('flags exceeded on the retry that crosses the budget', () => {
    const budget = new RetryBudget(2);
    budget.consume({ errorStatus: 529 });
    budget.consume({ errorStatus: 529 });
    expect(budget.consume({ errorStatus: 529 })).toEqual({
      exceeded: true,
      count: 3,
    });
  });

  it('ignores non-529 error statuses', () => {
    const budget = new RetryBudget(0);
    expect(budget.consume({ errorStatus: 503 })).toEqual({
      exceeded: false,
      count: 0,
    });
    expect(budget.consume({ errorStatus: null })).toEqual({
      exceeded: false,
      count: 0,
    });
    expect(budget.consume({ errorStatus: 429 })).toEqual({
      exceeded: false,
      count: 0,
    });
  });

  it('formats a budget-exhausted message that names the count and status', () => {
    const budget = new RetryBudget(1);
    budget.consume({ errorStatus: 529 });
    budget.consume({ errorStatus: 529 });
    expect(budget.exceededMessage()).toEqual(
      'Anthropic Overloaded (HttpStatus529) after 2 retries',
    );
  });

  it('rejects a negative or non-integer max', () => {
    expect(() => new RetryBudget(-1)).toThrow();
    expect(() => new RetryBudget(1.5)).toThrow();
  });
});

describe('readMax529Retries', () => {
  it('returns the default when the env var is unset', () => {
    expect(readMax529Retries({})).toEqual(DEFAULT_MAX_529_RETRIES);
  });

  it('returns the default when the env var is empty', () => {
    expect(readMax529Retries({ AGENT_RUNNER_MAX_529_RETRIES: '' })).toEqual(
      DEFAULT_MAX_529_RETRIES,
    );
  });

  it('parses a valid integer env var', () => {
    expect(
      readMax529Retries({ AGENT_RUNNER_MAX_529_RETRIES: '12' }),
    ).toEqual(12);
  });

  it('throws on a non-integer env var', () => {
    expect(() =>
      readMax529Retries({ AGENT_RUNNER_MAX_529_RETRIES: 'abc' }),
    ).toThrow();
  });

  it('throws on a negative env var', () => {
    expect(() =>
      readMax529Retries({ AGENT_RUNNER_MAX_529_RETRIES: '-1' }),
    ).toThrow();
  });
});
