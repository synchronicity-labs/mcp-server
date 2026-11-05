import { describe, expect, it } from 'vitest';
import { OrganizationSession } from './organization-selection.js';

const HOME = { id: '00000000-0000-4000-8000-0000000000a1', name: 'Home' };
const ACME = { id: '00000000-0000-4000-8000-0000000000a2', name: 'Acme' };

describe('OrganizationSession features', () => {
  it('keeps features read for the active organization in the current selection', () => {
    const session = new OrganizationSession();
    session.rememberDefault(HOME);
    expect(session.activeFeatures()).toBeUndefined();
    expect(session.recordFeatures(['stem_separation'], session.featureStamp(), HOME.id)).toBe(true);
    expect(session.activeFeatures()).toEqual(['stem_separation']);
    // An answer without an organization is kept for the active one.
    expect(session.recordFeatures(['scene_detection'], session.featureStamp(), undefined)).toBe(
      true,
    );
    expect(session.activeFeatures()).toEqual(['scene_detection']);
  });

  it('refuses a read that began before a switch, or answered for another organization', () => {
    const session = new OrganizationSession();
    session.rememberDefault(HOME);
    const beforeSwitch = session.featureStamp();
    session.select(ACME, ['scene_detection', 'stem_separation']);
    expect(session.recordFeatures(['stem_separation'], beforeSwitch, HOME.id)).toBe(false);
    // Even stamped after the switch, Home's answer is not Acme's.
    expect(session.recordFeatures(['stem_separation'], session.featureStamp(), HOME.id)).toBe(
      false,
    );
    expect(session.activeFeatures()).toEqual(['scene_detection', 'stem_separation']);
  });

  it('forgets features on a switch that brings none, so they are read again', () => {
    const session = new OrganizationSession();
    session.select(HOME, ['stem_separation']);
    session.select(ACME, undefined);
    expect(session.activeFeatures()).toBeUndefined();
    expect(session.recordFeatures(undefined, session.featureStamp(), ACME.id)).toBe(true);
    expect(session.activeFeatures()).toBeUndefined();
  });
});
