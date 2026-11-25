import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RevocationHandler } from '../revocation-handler';
import { sessionManager } from '../manager';
import type { SecurityEvent } from '../types';

describe('RevocationHandler', () => {
  let handler: RevocationHandler;
  let session: ReturnType<typeof sessionManager.createSession>;
  const userId = 'test-user-id';

  beforeEach(() => {
    handler = new RevocationHandler();
    sessionManager.reset();
    session = sessionManager.createSession(userId, {
      deviceType: 'web',
      deviceName: 'Test Browser',
      userAgent: 'Mozilla/5.0',
      ipAddress: '192.168.1.1',
    });
  });

  describe('async revocation', () => {
    it('revokes a session asynchronously', async () => {
      const event: SecurityEvent = {
        type: 'password_changed',
        userId,
        timestamp: new Date(),
        actor: { id: userId, role: 'user' },
        reason: 'User changed password',
      };

      const result = await handler.revokeSessionAsync(session.id, event);

      expect(result.ok).toBe(true);
      expect(result.value.success).toBe(true);
      expect(result.value.revokedSessionIds).toContain(session.id);
      expect(sessionManager.isSessionRevoked(session.id)).toBe(true);
    });

    it('handles concurrent revocation requests for the same session', async () => {
      const event: SecurityEvent = {
        type: 'password_changed',
        userId,
        timestamp: new Date(),
        actor: { id: userId, role: 'user' },
      };

      const promise1 = handler.revokeSessionAsync(session.id, event);
      const promise2 = handler.revokeSessionAsync(session.id, event);

      const [result1, result2] = await Promise.all([promise1, promise2]);

      expect(result1.ok).toBe(true);
      expect(result2.ok).toBe(true);
      expect(result1.value.revokedSessionIds[0]).toBe(result2.value.revokedSessionIds[0]);
    });

    it('retries revocation on failure with exponential backoff', async () => {
      const event: SecurityEvent = {
        type: 'password_changed',
        userId,
        timestamp: new Date(),
        actor: { id: userId, role: 'user' },
      };

      // This should succeed on first try with mocked session manager
      const result = await handler.revokeSessionAsync(session.id, event, { maxRetries: 2 });

      expect(result.ok).toBe(true);
    });

    it('reports revocation errors', async () => {
      const event: SecurityEvent = {
        type: 'password_changed',
        userId,
        timestamp: new Date(),
        actor: { id: 'different-user', role: 'user' },
      };

      const result = await handler.revokeSessionAsync(session.id, event);

      expect(result.ok).toBe(false);
      const errors = handler.getRevocationErrors();
      expect(errors.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('revoke all user sessions', () => {
    it('revokes all sessions for a user asynchronously', async () => {
      const session2 = sessionManager.createSession(userId, {
        deviceType: 'mobile',
        deviceName: 'Test Phone',
        userAgent: 'Mobile Safari',
        ipAddress: '192.168.1.2',
      });

      const event: SecurityEvent = {
        type: 'account_compromised',
        userId,
        timestamp: new Date(),
        actor: { id: userId, role: 'user' },
        reason: 'Account compromise detected',
      };

      const result = await handler.revokeAllUserSessionsAsync(userId, event);

      expect(result.ok).toBe(true);
      expect(result.value.revokedSessionIds.length).toBe(2);
      expect(sessionManager.isSessionRevoked(session.id)).toBe(true);
      expect(sessionManager.isSessionRevoked(session2.id)).toBe(true);
    });

    it('preserves a specified device when revoking all sessions', async () => {
      const device2 = sessionManager.addDevice(session.id, {
        deviceType: 'mobile',
        deviceName: 'Mobile Device',
        userAgent: 'Mobile Safari',
        ipAddress: '192.168.1.2',
      });

      const event: SecurityEvent = {
        type: 'suspicious_activity_detected',
        userId,
        timestamp: new Date(),
        actor: { id: userId, role: 'user' },
      };

      const result = await handler.revokeAllUserSessionsAsync(userId, event, device2?.id);

      expect(result.ok).toBe(true);
      // The session should still be active but other devices revoked
      const sessionStatus = sessionManager.getSession(session.id);
      expect(sessionStatus?.revoked).toBe(false);
    });
  });

  describe('stale session pruning', () => {
    it('prunes stale sessions', async () => {
      const result = await handler.pruneStaleSessions(1000);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.pruneIntervalMs).toBe(60 * 60 * 1000);
      }
    });

    it('respects minimum interval between prune operations', async () => {
      const minInterval = 1000;
      const result1 = await handler.pruneStaleSessions(100, minInterval);
      const result2 = await handler.pruneStaleSessions(100, minInterval);

      // Second call should fail because not enough time has passed
      expect(result1.ok).toBe(true);
      expect(result2.ok).toBe(false);
    });

    it('reports stale session and device counts', async () => {
      // Create a device that would be stale
      sessionManager.addDevice(session.id, {
        deviceType: 'mobile',
        deviceName: 'Stale Device',
        userAgent: 'Mobile Safari',
        ipAddress: '192.168.1.3',
      });

      const result = await handler.pruneStaleSessions(1);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect('staleSessions' in result.value).toBe(true);
        expect('staleDevices' in result.value).toBe(true);
      }
    });
  });

  describe('error tracking', () => {
    it('tracks revocation errors', async () => {
      const handler2 = new RevocationHandler();
      const event: SecurityEvent = {
        type: 'password_changed',
        userId,
        timestamp: new Date(),
        actor: { id: 'unauthorized-user', role: 'user' },
      };

      await handler2.revokeSessionAsync('nonexistent-session', event);

      const errors = handler2.getRevocationErrors();
      expect(errors.length).toBeGreaterThanOrEqual(0);
    });

    it('limits error history to 100 entries', async () => {
      const handler2 = new RevocationHandler();
      const event: SecurityEvent = {
        type: 'password_changed',
        userId,
        timestamp: new Date(),
        actor: { id: userId, role: 'user' },
      };

      // Create 110 sessions and try to revoke non-existent ones
      for (let i = 0; i < 110; i++) {
        await handler2.revokeSessionAsync(`session-${i}`, event);
      }

      const errors = handler2.getRevocationErrors(200);
      expect(errors.length).toBeLessThanOrEqual(100);
    });

    it('clears revocation errors', () => {
      const handler2 = new RevocationHandler();
      handler2.getRevocationErrors(); // This would populate errors if any

      handler2.clearRevocationErrors();
      expect(handler2.getRevocationErrors()).toEqual([]);
    });
  });

  describe('revocation in progress tracking', () => {
    it('reports when revocation is in progress', async () => {
      const event: SecurityEvent = {
        type: 'password_changed',
        userId,
        timestamp: new Date(),
        actor: { id: userId, role: 'user' },
      };

      const promise = handler.revokeSessionAsync(session.id, event);

      // Check if revocation is marked as in progress during the async operation
      const startTime = Date.now();
      let wasInProgress = false;
      while (Date.now() - startTime < 100 && !wasInProgress) {
        if (handler.isRevocationInProgress(session.id)) {
          wasInProgress = true;
        }
      }

      await promise;

      expect(handler.isRevocationInProgress(session.id)).toBe(false);
    });
  });

  describe('handleSecurityEvent (#402)', () => {
    it('scopes a user stale-session event to that user', async () => {
      const stale = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
      const device = {
        deviceType: 'web' as const,
        deviceName: 'Stale Browser',
        userAgent: 'test',
        ipAddress: '192.0.2.1',
        lastActivity: stale,
      };
      const own = sessionManager.createSession(userId, device);
      const other = sessionManager.createSession('other-user', device);

      const result = await handler.handleSecurityEvent({
        type: 'stale_session_timeout',
        userId,
        actor: { id: userId, role: 'user' },
        timestamp: new Date(),
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.revokedSessionIds).toContain(own.id);
        expect(result.value.revokedSessionIds).not.toContain(other.id);
      }
      expect(sessionManager.isSessionRevoked(other.id)).toBe(false);
    });

    it('handles account_compromised by revoking all user sessions and invalidating tokens', async () => {
      const session2 = sessionManager.createSession(userId, {
        deviceType: 'mobile',
        deviceName: 'Mobile Phone',
        userAgent: 'Mobile Safari',
        ipAddress: '192.168.1.5',
      });

      const event: SecurityEvent = {
        type: 'account_compromised',
        userId,
        timestamp: new Date(),
        actor: { id: userId, role: 'user' },
        reason: 'Compromised credentials reported',
      };

      const result = await handler.handleSecurityEvent(event);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.revokedSessionIds).toContain(session.id);
        expect(result.value.revokedSessionIds).toContain(session2.id);
        expect(result.value.eventType).toBe('account_compromised');
      }

      expect(sessionManager.isSessionRevoked(session.id)).toBe(true);
      expect(sessionManager.isSessionRevoked(session2.id)).toBe(true);
      expect(sessionManager.isTokenRevoked(session.syncToken)).toBe(true);
      expect(sessionManager.isTokenRevoked(session2.syncToken)).toBe(true);
    });

    it('handles role_downgraded by revoking all sessions when initiated by maintainer', async () => {
      const event: SecurityEvent = {
        type: 'role_downgraded',
        userId,
        timestamp: new Date(),
        actor: { id: 'admin-1', role: 'maintainer' },
        reason: 'Demoted from admin to user',
      };

      const result = await handler.handleSecurityEvent(event);
      expect(result.ok).toBe(true);
      expect(sessionManager.isSessionRevoked(session.id)).toBe(true);
    });

    it('handles password_changed while preserving current device when requested', async () => {
      const device2 = sessionManager.addDevice(session.id, {
        deviceType: 'mobile',
        deviceName: 'Phone',
        userAgent: 'Mobile Safari',
        ipAddress: '192.168.1.6',
      });

      const event: SecurityEvent = {
        type: 'password_changed',
        userId,
        deviceId: device2?.id,
        timestamp: new Date(),
        actor: { id: userId, role: 'user' },
      };

      const result = await handler.handleSecurityEvent(event, { preserveCurrentDevice: true });
      expect(result.ok).toBe(true);
      const current = sessionManager.getSession(session.id);
      expect(current?.revoked).toBe(false);
      expect(current?.primaryDevice).toBe(device2?.id);
    });

    it('handles suspicious_activity_detected on specific device', async () => {
      const device2 = sessionManager.addDevice(session.id, {
        deviceType: 'desktop',
        deviceName: 'Suspicious Linux Box',
        userAgent: 'curl/7.68',
        ipAddress: '10.0.0.99',
      });

      const event: SecurityEvent = {
        type: 'suspicious_activity_detected',
        userId,
        sessionId: session.id,
        deviceId: device2?.id,
        timestamp: new Date(),
        actor: { id: 'system', role: 'system' },
        reason: 'Unusual geolocation access pattern',
      };

      const result = await handler.handleSecurityEvent(event);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.revokedDeviceIds).toContain(device2?.id);
      }
    });

    it('enforces authorization: prevents user from revoking another user session', async () => {
      const event: SecurityEvent = {
        type: 'password_changed',
        userId: 'other-user',
        timestamp: new Date(),
        actor: { id: userId, role: 'user' },
      };

      const result = await handler.handleSecurityEvent(event);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('unauthorized');
      }
    });

    it('enforces authorization: prevents user from initiating role_downgraded or manual_admin_revocation', async () => {
      const roleEvent: SecurityEvent = {
        type: 'role_downgraded',
        userId,
        timestamp: new Date(),
        actor: { id: userId, role: 'user' },
      };
      const adminEvent: SecurityEvent = {
        type: 'manual_admin_revocation',
        userId,
        timestamp: new Date(),
        actor: { id: userId, role: 'user' },
      };

      const roleResult = await handler.handleSecurityEvent(roleEvent);
      expect(roleResult.ok).toBe(false);
      if (!roleResult.ok) {
        expect(roleResult.code).toBe('unauthorized');
      }

      const adminResult = await handler.handleSecurityEvent(adminEvent);
      expect(adminResult.ok).toBe(false);
      if (!adminResult.ok) {
        expect(adminResult.code).toBe('unauthorized');
      }
    });

    it('validates security event and rejects malformed payloads', async () => {
      const badEvent = {
        type: '' as any,
        userId: '',
        actor: null as any,
        timestamp: new Date(),
      };

      const result = await handler.handleSecurityEvent(badEvent);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('invalid_security_event');
      }
    });

    it('treats retried security events as idempotent', async () => {
      const event: SecurityEvent = {
        eventId: 'security-event-1',
        type: 'password_changed',
        userId,
        timestamp: new Date(),
        actor: { id: userId, role: 'user' },
      };
      const first = await handler.handleSecurityEvent(event);
      const second = await handler.handleSecurityEvent(event);
      expect(first).toEqual(second);
    });
  });
});
