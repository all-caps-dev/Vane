// TypeScript: the eval's required-fact check matches key terms, not whole sentences.
import { describe, expect, it } from 'vitest';
import { factStated, factTerms } from '../run';

describe('factTerms', () => {
  it('splits a fact into exact terms and names', () => {
    expect(factTerms('Proxmox VE 9 is based on Debian 13 "Trixie"')).toEqual({
      exact: ['Trixie', '9', '13'],
      names: ['VE', 'Debian'],
    });
  });

  it('keeps flags, code-like tokens and an acronym first word', () => {
    const terms = factTerms(
      'ZHA needs no broker; use --jinja and search.formats',
    );
    expect(terms?.exact).toEqual(['--jinja', 'search.formats']);
    expect(terms?.names).toEqual(['ZHA']);
  });

  it('returns null for a fact with nothing to check', () => {
    expect(factTerms('Does not invent a requirement')).toBeNull();
    expect(
      factTerms(
        'Says it depends on implementation rather than a flat yes or no',
      ),
    ).toBeNull();
  });
});

describe('factStated', () => {
  // The live answers from the 2026-11-15 smoke test (f01, f12).
  const f01 =
    'Proxmox VE 9 is based on **Debian 13 "Trixie"**, and Proxmox VE 9.0 was released on **August 5, 2025**[2].';
  const f12 =
    'WCAG 2.2 added **nine** new success criteria[1]. | 2.4.11, 2.4.12 | 2.4.13 | 2.5.7 | 2.5.8 | 3.2.6 | 3.3.7 | 3.3.8, 3.3.9 | The version also **removed** 4.1.1 Parsing[2].';

  it('matches a correct answer worded differently', () => {
    expect(factStated('Proxmox VE 9 is based on Debian 13 "Trixie"', f01)).toBe(
      true,
    );
    expect(factStated('Proxmox VE 9.0 was released in August 2025', f01)).toBe(
      true,
    );
    expect(
      factStated(
        'It adds 9 criteria: 2.4.11, 2.4.12, 2.4.13, 2.5.7, 2.5.8, 3.2.6, 3.3.7, 3.3.8, 3.3.9',
        f12,
      ),
    ).toBe(true);
    expect(factStated('4.1.1 Parsing was removed as obsolete', f12)).toBe(true);
  });

  it('misses when a number or date is absent or wrong', () => {
    expect(
      factStated('WCAG 2.2 became a W3C Recommendation on 5 October 2023', f12),
    ).toBe(false);
    expect(factStated('Proxmox VE 9.0 was released in August 2024', f01)).toBe(
      false,
    );
  });

  it('does not match a version inside a longer one', () => {
    expect(
      factStated('Criterion 2.4.1 applies', 'See 2.4.11 and 2.4.12.'),
    ).toBe(false);
    expect(factStated('Version 2.2 is current', 'WCAG 2.2.')).toBe(true);
  });

  it('ignores thousands separators', () => {
    expect(factStated('Launch price $3,999', 'It launched at $3999.')).toBe(
      true,
    );
  });

  it('returns null for judge-only facts', () => {
    expect(factStated('Does not invent a requirement', f01)).toBeNull();
  });

  it('needs two thirds of the names', () => {
    // Names: Mosquitto, Home, Assistant (Zigbee2MQTT is an exact term).
    const fact = 'Uses Mosquitto with Zigbee2MQTT and Home Assistant';
    expect(factStated(fact, 'Zigbee2MQTT talks to Home Assistant.')).toBe(true);
    expect(factStated(fact, 'Zigbee2MQTT needs Mosquitto.')).toBe(false);
    expect(factStated(fact, 'Mosquitto and Home Assistant only.')).toBe(false);
  });
});
