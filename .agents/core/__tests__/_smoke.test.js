import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

describe('_smoke', () => {
  it('arithmetic_basic_returnsExpected', () => {
    // Arrange
    const a = 1;
    const b = 1;

    // Act
    const result = a + b;

    // Assert
    expect(result).toBe(2);
  });

  it('projectModule_profile_loadsWithoutError', () => {
    // Arrange / Act
    const profile = require('../../../.agents/core/profile');

    // Assert
    expect(profile).toBeDefined();
    expect(typeof profile.getProfile).toBe('function');
    expect(typeof profile.isAtLeast).toBe('function');
    expect(Array.isArray(profile.PROFILE_ORDER)).toBe(true);
    expect(typeof profile.DEFAULT_PROFILE).toBe('string');
  });
});
