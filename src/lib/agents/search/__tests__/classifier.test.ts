// TypeScript: unit tests for the classifier schema (M3 fields) and classify() cleanup.
import { describe, expect, it, vi } from 'vitest';
import { classify, classifierSchema } from '@/lib/agents/search/classifier';
import { classifierPrompt } from '@/lib/prompts/search/classifier';

const base = {
  skipSearch: false,
  personalSearch: false,
  academicSearch: false,
  discussionSearch: false,
  showWeatherWidget: false,
  showStockWidget: false,
  showCalculationWidget: false,
};

describe('classifierSchema', () => {
  it('parses freshness, entities and intent', () => {
    const out = classifierSchema.parse({
      classification: {
        ...base,
        freshness: 'current',
        entities: ['Proxmox VE 12'],
        intent: 'fact',
      },
      standaloneFollowUp: 'What are the features of Proxmox VE 12?',
    });
    expect(out.classification).toMatchObject({
      freshness: 'current',
      entities: ['Proxmox VE 12'],
      intent: 'fact',
    });
  });

  it('falls back when a model leaves the new fields out', () => {
    const out = classifierSchema.parse({
      classification: base,
      standaloneFollowUp: 'hi',
    });
    expect(out.classification.freshness).toBe('none');
    expect(out.classification.entities).toEqual([]);
    expect(out.classification.intent).toBe('other');
  });

  it('falls back on unknown enum values and a non-array entities', () => {
    const out = classifierSchema.parse({
      classification: {
        ...base,
        freshness: 'yesterday',
        entities: 'WCAG 2.2',
        intent: 'chit-chat',
      },
      standaloneFollowUp: 'x',
    });
    expect(out.classification.freshness).toBe('none');
    expect(out.classification.entities).toEqual([]);
    expect(out.classification.intent).toBe('other');
  });

  it('still requires the pre-M3 fields', () => {
    expect(() =>
      classifierSchema.parse({
        classification: { freshness: 'none' },
        standaloneFollowUp: 'x',
      }),
    ).toThrow();
  });
});

describe('classify', () => {
  it('trims and de-duplicates entities', async () => {
    const llm = {
      generateObject: vi.fn(async () => ({
        classification: {
          ...base,
          freshness: 'recent',
          entities: [' WCAG 2.2 ', 'WCAG 2.2', ''],
          intent: 'fact',
        },
        standaloneFollowUp: 'Which success criteria were added in WCAG 2.2?',
      })),
    };
    const out = await classify({
      llm: llm as any,
      enabledSources: ['web'],
      query: 'Which success criteria were added in WCAG 2.2?',
      chatHistory: [],
    });
    expect(out.classification.entities).toEqual(['WCAG 2.2']);
    expect(llm.generateObject).toHaveBeenCalledTimes(1);
  });
});

describe('classifierPrompt', () => {
  it('makes search the default and lists the new fields', () => {
    expect(classifierPrompt).toContain('Searching is the default');
    expect(classifierPrompt).toContain('"freshness"');
    expect(classifierPrompt).toContain('"entities"');
    expect(classifierPrompt).toContain('"intent"');
    // The old rule that sent half-remembered facts to "general knowledge".
    expect(classifierPrompt).not.toContain(
      'can be answered based on general knowledge',
    );
  });
});
