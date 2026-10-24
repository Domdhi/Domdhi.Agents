import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const profile = require('../../../.agents/core/profile');
const { getProfile, isAtLeast, PROFILE_ORDER, DEFAULT_PROFILE } = profile;

describe('profile', () => {
  let originalEnv;

  beforeEach(() => {
    originalEnv = process.env.MEMORY_PROFILE;
    delete process.env.MEMORY_PROFILE;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.MEMORY_PROFILE;
    } else {
      process.env.MEMORY_PROFILE = originalEnv;
    }
  });

  describe('profile.getProfile', () => {
    it('getProfile_envUnset_returnsDefault', () => {
      // Arrange
      delete process.env.MEMORY_PROFILE;

      // Act
      const result = getProfile();

      // Assert
      expect(result).toBe('standard');
    });

    it('getProfile_envMinimal_returnsMinimal', () => {
      // Arrange
      process.env.MEMORY_PROFILE = 'minimal';

      // Act
      const result = getProfile();

      // Assert
      expect(result).toBe('minimal');
    });

    it('getProfile_envStandard_returnsStandard', () => {
      // Arrange
      process.env.MEMORY_PROFILE = 'standard';

      // Act
      const result = getProfile();

      // Assert
      expect(result).toBe('standard');
    });

    it('getProfile_envStrict_returnsStrict', () => {
      // Arrange
      process.env.MEMORY_PROFILE = 'strict';

      // Act
      const result = getProfile();

      // Assert
      expect(result).toBe('strict');
    });

    it('getProfile_envInvalidValue_returnsDefaultFallback', () => {
      // Arrange
      process.env.MEMORY_PROFILE = 'bogus';
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      // Act
      const result = getProfile();

      // Assert
      expect(result).toBe('standard');

      stderrSpy.mockRestore();
    });

    it('getProfile_envEmptyString_returnsDefault', () => {
      // Arrange
      process.env.MEMORY_PROFILE = '';

      // Act
      const result = getProfile();

      // Assert
      expect(result).toBe('standard');
    });
  });

  describe('profile.isAtLeast', () => {
    it('isAtLeast_eachLevelSelf_returnsTrue', () => {
      // Arrange / Act / Assert — iterate PROFILE_ORDER as source of truth
      for (const level of PROFILE_ORDER) {
        process.env.MEMORY_PROFILE = level;
        expect(isAtLeast(level)).toBe(true);
      }
    });

    it('isAtLeast_higherCurrentLowerRequired_returnsTrue', () => {
      // Arrange
      process.env.MEMORY_PROFILE = 'strict';

      // Act / Assert
      expect(isAtLeast('minimal')).toBe(true);
      expect(isAtLeast('standard')).toBe(true);
    });

    it('isAtLeast_lowerCurrentHigherRequired_returnsFalse', () => {
      // Arrange
      process.env.MEMORY_PROFILE = 'minimal';

      // Act / Assert
      expect(isAtLeast('standard')).toBe(false);
      expect(isAtLeast('strict')).toBe(false);
    });

    it('isAtLeast_invalidLevel_throws', () => {
      // Arrange
      process.env.MEMORY_PROFILE = 'standard';

      // Act / Assert
      expect(() => isAtLeast('bogus')).toThrow();
      expect(() => isAtLeast('bogus')).toThrowError(/invalid level/);
    });
  });

  describe('profile.exports', () => {
    it('module_exports_containExpectedSurface', () => {
      // Arrange / Act / Assert
      expect(PROFILE_ORDER).toEqual(['minimal', 'standard', 'strict']);
      expect(DEFAULT_PROFILE).toBe('standard');
      expect(typeof getProfile).toBe('function');
      expect(typeof isAtLeast).toBe('function');
    });
  });
});
