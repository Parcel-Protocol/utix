import { err, ok, type Result } from '@/core/result/result';
import type {
  SessionErrorCode,
  RevocationReport,
  SecurityEvent,
  CrossDeviceSession,
  SecurityEventHandlingOptions,
} from './types.ts';
import { sessionManager } from './manager.ts';

export interface RevocationError {
  code: SessionErrorCode;
  message: string;
  retryable: boolean;
  timestamp: Date;
}

export interface RevocationOptions {
  maxRetries?: number;
  backoffMs?: number;
  timeoutMs?: number;
}

export interface StaleSessionPruneReport extends RevocationReport {
  readonly pruneIntervalMs: number;
  readonly staleSessions: number;
  readonly staleDevices: number;
}

export class RevocationHandler {
  private revocationInProgress = new Map<string, Promise<RevocationReport>>();
  private lastPruneTime: Map<string, Date> = new Map();
  private revocationErrors: RevocationError[] = [];
  private handledSecurityEvents = new Map<string, RevocationReport>();

  constructor(private options: RevocationOptions = {}) {}

  async revokeSessionAsync(
    sessionId: string,
    event: SecurityEvent,
    opts?: RevocationOptions
  ): Promise<Result<RevocationReport, SessionErrorCode>> {
    // Check if revocation is already in progress
    const existing = this.revocationInProgress.get(sessionId);
    if (existing) {
      try {
        const report = await existing;
        return ok(report);
      } catch (error) {
        return err('revocation_failed');
      }
    }

    const promise = this.performRevocation(sessionId, event, opts);
    this.revocationInProgress.set(sessionId, promise);

    try {
      const report = await promise;
      return ok(report);
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error
          ? (error.code as SessionErrorCode)
          : 'revocation_failed';
      this.recordError({
        code,
        message: error instanceof Error ? error.message : `Failed to revoke session ${sessionId}: ${code}`,
        retryable: code === 'revocation_failed' || code === 'revocation_retries_exhausted',
        timestamp: new Date(),
      });
      return err(code);
    } finally {
      this.revocationInProgress.delete(sessionId);
    }
  }

  async revokeAllUserSessionsAsync(
    userId: string,
    event: SecurityEvent,
    exceptDeviceId?: string,
    opts?: RevocationOptions
  ): Promise<Result<RevocationReport, SessionErrorCode>> {
    const options = { ...this.options, ...opts };
    const maxRetries = options.maxRetries ?? 3;
    let lastError: SessionErrorCode = 'revocation_failed';

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = sessionManager.revokeAllUserSessions(userId, event, exceptDeviceId);
        if (result.ok) {
          this.recordSuccess(userId);
          return result;
        }
        lastError = result.code;

        if (attempt < maxRetries) {
          const delay = this.exponentialBackoff(attempt, options.backoffMs ?? 100);
          await this.sleep(delay);
        }
      } catch (error) {
        lastError = 'revocation_failed';
        if (attempt < maxRetries) {
          const delay = this.exponentialBackoff(attempt, options.backoffMs ?? 100);
          await this.sleep(delay);
        }
      }
    }

    this.recordError({
      code: lastError,
      message: `Failed to revoke all sessions for user ${userId} after ${maxRetries + 1} attempts`,
      retryable: true,
      timestamp: new Date(),
    });

    return err(lastError);
  }

  async pruneStaleSessions(
    staleThresholdMs: number = 30 * 24 * 60 * 60 * 1000,
    minIntervalMs: number = 60 * 60 * 1000
  ): Promise<Result<StaleSessionPruneReport, SessionErrorCode>> {
    const now = new Date();
    const lastPrune = this.lastPruneTime.get('global');

    // Avoid pruning too frequently
    if (lastPrune && now.getTime() - lastPrune.getTime() < minIntervalMs) {
      return err('revocation_failed');
    }

    try {
      const baseResult = sessionManager.pruneStaleSessions({
        staleThresholdMs,
        actor: { id: 'system', role: 'system' },
        now,
      });

      if (!baseResult.ok) {
        return baseResult;
      }

      const baseReport = baseResult.value;
      const pruneReport: StaleSessionPruneReport = {
        ...baseReport,
        pruneIntervalMs: minIntervalMs,
        staleSessions: baseReport.revokedSessionIds.length,
        staleDevices: baseReport.revokedDeviceIds.length,
      };

      this.lastPruneTime.set('global', now);
      return ok(pruneReport);
    } catch (error) {
      this.recordError({
        code: 'revocation_failed',
        message: `Failed to prune stale sessions: ${error instanceof Error ? error.message : 'unknown error'}`,
        retryable: true,
        timestamp: new Date(),
      });
      return err('revocation_failed');
    }
  }

  /**
   * Evaluates and applies session invalidation in response to a SecurityEvent (#402).
   *
   * Enforces role authorization, event-driven invalidation scoping,
   * token disconnection, cross-device invalidation, and retry resilience.
   *
   * Time Complexity: O(S * D) where S is sessions and D is devices per session.
   * Space Complexity: O(R) for revoked identifiers in report.
   */
  async handleSecurityEvent(
    event: SecurityEvent,
    opts?: SecurityEventHandlingOptions
  ): Promise<Result<RevocationReport, SessionErrorCode>> {
    if (!event || !event.type || !event.userId || !event.actor) {
      return err('invalid_security_event');
    }

    // Role-based Authorization Gate
    if (event.actor.role === 'user') {
      if (event.actor.id !== event.userId) {
        return err('unauthorized');
      }
      // Users cannot perform admin-only security event operations
      if (event.type === 'role_downgraded' || event.type === 'manual_admin_revocation') {
        return err('unauthorized');
      }
    }

    const options = { ...this.options, ...opts };

    if (event.eventId) {
      const previous = this.handledSecurityEvents.get(event.eventId);
      if (previous) return ok(previous);
    }

    const result = await (async () => {
      switch (event.type) {
      case 'account_compromised':
        return this.revokeAllUserSessionsAsync(event.userId, event, undefined, options);

      case 'role_downgraded':
        return this.revokeAllUserSessionsAsync(event.userId, event, undefined, options);

      case 'password_changed': {
        const exceptDeviceId = options.preserveCurrentDevice && event.deviceId ? event.deviceId : undefined;
        return this.revokeAllUserSessionsAsync(event.userId, event, exceptDeviceId, options);
      }

      case 'suspicious_activity_detected': {
        if (event.sessionId && event.deviceId) {
          const deviceResult = sessionManager.revokeDevice(event.sessionId, event.deviceId, event);
          if (deviceResult.ok) {
            this.recordSuccess(event.sessionId);
            return deviceResult;
          }
          this.recordError({
            code: deviceResult.error,
            message: `Failed to revoke device ${event.deviceId} on session ${event.sessionId}`,
            retryable: false,
            timestamp: new Date(),
          });
          return deviceResult;
        }

        if (event.sessionId) {
          return this.revokeSessionAsync(event.sessionId, event, options);
        }

        return this.revokeAllUserSessionsAsync(event.userId, event, undefined, options);
      }

      case 'manual_admin_revocation': {
        if (event.sessionId) {
          return this.revokeSessionAsync(event.sessionId, event, options);
        }
        return this.revokeAllUserSessionsAsync(event.userId, event, undefined, options);
      }

      case 'stale_session_timeout': {
        if (event.sessionId) {
          return this.revokeSessionAsync(event.sessionId, event, options);
        }
        const pruneResult = event.actor.role === 'user'
          ? sessionManager.pruneStaleSessions({ actor: event.actor })
          : await this.pruneStaleSessions();
        if (pruneResult.ok) {
          return ok({
            success: true,
            eventType: 'stale_session_timeout',
            userId: event.userId,
            revokedSessionIds: pruneResult.value.revokedSessionIds,
            revokedDeviceIds: pruneResult.value.revokedDeviceIds,
            timestamp: new Date(),
            reason: event.reason,
          });
        }
        return err(pruneResult.code);
      }

      default:
        return err('invalid_security_event');
      }
    })();
    if (result.ok && event.eventId) this.handledSecurityEvents.set(event.eventId, result.value);
    return result;
  }

  private async performRevocation(
    sessionId: string,
    event: SecurityEvent,
    opts?: RevocationOptions
  ): Promise<RevocationReport> {
    const options = { ...this.options, ...opts };
    const maxRetries = options.maxRetries ?? 3;
    const nonRetryable: SessionErrorCode[] = [
      'session_not_found',
      'device_not_found',
      'unauthorized',
      'invalid_security_event',
    ];

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const result = sessionManager.revokeSession(sessionId, event);

      if (result.ok) {
        this.recordSuccess(sessionId);
        return result.value;
      }

      if (nonRetryable.includes(result.code)) {
        throw {
          code: result.code,
          message: `Revocation failed: ${result.code}`,
        };
      }

      if (attempt < maxRetries) {
        const delay = this.exponentialBackoff(attempt, options.backoffMs ?? 100);
        await this.sleep(delay);
      }
    }

    throw {
      code: 'revocation_retries_exhausted',
      message: `Could not revoke session after ${maxRetries + 1} attempts`,
    };
  }

  private exponentialBackoff(attempt: number, baseMs: number): number {
    return baseMs * Math.pow(2, attempt);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private recordSuccess(identifier: string): void {
    this.lastPruneTime.set(identifier, new Date());
  }

  private recordError(error: RevocationError): void {
    this.revocationErrors.push(error);
    // Keep only last 100 errors
    if (this.revocationErrors.length > 100) {
      this.revocationErrors.shift();
    }
  }

  getRevocationErrors(limit: number = 50): RevocationError[] {
    return this.revocationErrors.slice(-limit);
  }

  clearRevocationErrors(): void {
    this.revocationErrors = [];
  }

  isRevocationInProgress(sessionId: string): boolean {
    return this.revocationInProgress.has(sessionId);
  }
}

export const revocationHandler = new RevocationHandler();
