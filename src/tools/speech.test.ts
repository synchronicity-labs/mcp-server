import { describe, expect, it } from 'vitest';
import { FREE_SCRIPT_LIMIT, freeScriptLimit } from './speech.js';

const billing = {
  plan: null,
  hasActiveCredits: false,
  freeTtsExhausted: false,
  paymentFailureCountExceededLimit: false,
  freeMonthlyLimits: null,
};

describe('freeScriptLimit', () => {
  it('limits the script on the free plan without credits', () => {
    expect(freeScriptLimit(billing)).toEqual(FREE_SCRIPT_LIMIT);
    expect(freeScriptLimit({ ...billing, plan: 'noplan' })).toEqual(FREE_SCRIPT_LIMIT);
  });

  it('has no limit with credits or a paid plan', () => {
    expect(freeScriptLimit({ ...billing, hasActiveCredits: true })).toBeNull();
    expect(freeScriptLimit({ ...billing, plan: 'creator' })).toBeNull();
  });

  it('matches the API: 20 seconds at 16 characters a second', () => {
    expect(FREE_SCRIPT_LIMIT.maxCharacters).toBe(FREE_SCRIPT_LIMIT.maxSeconds * 16);
  });
});
