import { describe, it, expect } from 'vitest';
import { hasPermission, hasAnyPermission, hasAllPermissions, ROLE_PERMISSIONS } from '../types';
import { requirePermission, UnauthorizedError, getAuthContext } from '../middleware';

describe('Role-based access control', () => {
  describe('hasPermission', () => {
    it('allows viewers to access public tools', () => {
      expect(hasPermission('viewer', 'view:tools')).toBe(true);
      expect(hasPermission('viewer', 'view:dashboard')).toBe(true);
    });

    it('denies viewers from accessing admin functions', () => {
      expect(hasPermission('viewer', 'admin:health')).toBe(false);
      expect(hasPermission('viewer', 'admin:recovery')).toBe(false);
      expect(hasPermission('viewer', 'admin:metrics')).toBe(false);
    });

    it('allows maintainers to access all functions', () => {
      expect(hasPermission('maintainer', 'view:tools')).toBe(true);
      expect(hasPermission('maintainer', 'view:dashboard')).toBe(true);
      expect(hasPermission('maintainer', 'admin:health')).toBe(true);
      expect(hasPermission('maintainer', 'admin:recovery')).toBe(true);
      expect(hasPermission('maintainer', 'admin:metrics')).toBe(true);
    });

    it('allows service accounts limited admin access', () => {
      expect(hasPermission('service', 'admin:health')).toBe(true);
      expect(hasPermission('service', 'admin:metrics')).toBe(true);
      expect(hasPermission('service', 'view:tools')).toBe(false);
      expect(hasPermission('service', 'admin:recovery')).toBe(false);
    });
  });

  describe('hasAnyPermission', () => {
    it('returns true if user has at least one permission', () => {
      expect(hasAnyPermission('viewer', ['view:tools', 'admin:health'])).toBe(true);
      expect(hasAnyPermission('service', ['view:tools', 'admin:health'])).toBe(true);
    });

    it('returns false if user has none of the permissions', () => {
      expect(hasAnyPermission('viewer', ['admin:health', 'admin:recovery'])).toBe(false);
    });
  });

  describe('hasAllPermissions', () => {
    it('returns true only if user has all permissions', () => {
      expect(hasAllPermissions('maintainer', ['view:tools', 'admin:health'])).toBe(true);
      expect(hasAllPermissions('viewer', ['view:tools', 'view:dashboard'])).toBe(true);
    });

    it('returns false if user lacks any permission', () => {
      expect(hasAllPermissions('viewer', ['view:tools', 'admin:health'])).toBe(false);
    });
  });

  describe('requirePermission', () => {
    it('allows requests with sufficient permissions', () => {
      expect(() =>
        requirePermission({ role: 'viewer' }, 'view:tools')
      ).not.toThrow();
    });

    it('throws UnauthorizedError when permission is denied', () => {
      expect(() =>
        requirePermission({ role: 'viewer' }, 'admin:health')
      ).toThrow(UnauthorizedError);
    });

    it('includes context in error', () => {
      try {
        requirePermission({ role: 'viewer' }, 'admin:recovery');
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(UnauthorizedError);
        const authError = error as UnauthorizedError;
        expect(authError.requiredPermission).toBe('admin:recovery');
        expect(authError.userRole).toBe('viewer');
      }
    });
  });

  describe('getAuthContext', () => {
    it('defaults to viewer role', () => {
      const context = getAuthContext();
      expect(context.role).toBe('viewer');
    });
  });

  describe('ROLE_PERMISSIONS coverage', () => {
    it('defines permissions for all roles', () => {
      expect(ROLE_PERMISSIONS.viewer).toBeDefined();
      expect(ROLE_PERMISSIONS.maintainer).toBeDefined();
      expect(ROLE_PERMISSIONS.service).toBeDefined();
    });

    it('maintains permission hierarchy', () => {
      const viewerPerms = ROLE_PERMISSIONS.viewer;
      const maintainerPerms = ROLE_PERMISSIONS.maintainer;
      
      viewerPerms.forEach(perm => {
        expect(maintainerPerms).toContain(perm);
      });
    });
  });
});
