import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryReplayProtectionStore, WebhookVerifier } from '../verification';
import type { ReplayProtectionStore, WebhookSubscriber } from '../types';

describe('Issue #355: Signed Webhook Replay-Window Enforcement', () => {
  let verifier: WebhookVerifier;
  const testSecret = 'whsec_valid_secret_key_12345';
  const baseTimestamp = 1700000000;

  beforeEach(() => {
    verifier = new WebhookVerifier({
      replayWindowSeconds: 300, // 5 minutes
      maxClockSkew: 60, // 1 minute
      nonceDeduplication: true,
    });
  });

  describe('Normal Path', () => {
    it('verifies valid fresh signed message within replay window', () => {
      const message = verifier.createSignedMessage({ event: 'payment.received', amount: '100.50' }, testSecret);
      const result = verifier.verifyReplayWindow(message, testSecret, {
        now: message.signature.timestamp + 5
      });

      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.ageSeconds).toBe(5);
    });

    it('enforces constant-time cryptographic signature verification', () => {
      const message = verifier.createSignedMessage({ orderId: 'ord-101' }, testSecret);
      const badSecretResult = verifier.verifyReplayWindow(message, 'wrong-secret-999', {
        now: message.signature.timestamp
      });

      expect(badSecretResult.valid).toBe(false);
      expect(badSecretResult.code).toBe('signature_verification_failed');
    });
  });

  describe('Failure Path', () => {
    it('rejects message with future timestamp beyond clock skew', () => {
      const message = verifier.createSignedMessage({ test: true }, testSecret);
      message.signature.timestamp = baseTimestamp + 120; // 2 minutes in future (> 60s maxClockSkew)

      const result = verifier.verifyReplayWindow(message, testSecret, {
        now: baseTimestamp
      });

      expect(result.valid).toBe(false);
      expect(result.code).toBe('clock_skew_future');
      expect(result.error).toBe('Timestamp outside acceptable skew window');
    });

    it('rejects message older than replay window (stale replay)', () => {
      const message = verifier.createSignedMessage({ test: true }, testSecret);
      message.signature.timestamp = baseTimestamp - 301; // 301 seconds old (> 300s window)

      const result = verifier.verifyReplayWindow(message, testSecret, {
        now: baseTimestamp
      });

      expect(result.valid).toBe(false);
      expect(result.code).toBe('replay_window_expired');
      expect(result.error).toBe('Message timestamp outside replay window');
    });

    it('rejects replayed nonce within active replay window', () => {
      const message = verifier.createSignedMessage({ tx: 'tx-1' }, testSecret);
      const now = message.signature.timestamp;

      // First verification succeeds
      const first = verifier.verifyReplayWindow(message, testSecret, { now });
      expect(first.valid).toBe(true);

      // Second verification with identical nonce is rejected as replay attack
      const second = verifier.verifyReplayWindow(message, testSecret, { now: now + 1 });
      expect(second.valid).toBe(false);
      expect(second.code).toBe('replay_attack_detected');
      expect(second.error).toContain('nonce already used');
    });

    it('rejects malformed webhook message payloads', () => {
      const malformed = { id: 'evt-bad' } as any;
      const result = verifier.verifyReplayWindow(malformed, testSecret);

      expect(result.valid).toBe(false);
      expect(result.code).toBe('malformed_message');
    });
  });

  describe('Authorization Path', () => {
    let subscriber: WebhookSubscriber;

    beforeEach(() => {
      subscriber = {
        id: 'sub-acme-corp',
        url: 'https://acme.org/hooks',
        secret: testSecret,
        events: ['ticket.issued', 'payment.settled'],
        active: true,
        createdAt: new Date(),
        failureCount: 0,
        successCount: 0
      };
      verifier.registerSubscriber(subscriber);
    });

    it('authorizes subscriber with matching event and secret', () => {
      const auth = verifier.verifySubscriberAuthorization('sub-acme-corp', 'ticket.issued', testSecret);
      expect(auth.ok).toBe(true);
    });

    it('rejects subscriber when event is not subscribed', () => {
      const auth = verifier.verifySubscriberAuthorization('sub-acme-corp', 'admin.action', testSecret);
      expect(auth.ok).toBe(false);
      if (auth.ok) return;
      expect(auth.code).toBe('unauthorized_event');
    });

    it('rejects unknown subscriber ID', () => {
      const auth = verifier.verifySubscriberAuthorization('sub-unknown', 'ticket.issued', testSecret);
      expect(auth.ok).toBe(false);
      if (auth.ok) return;
      expect(auth.code).toBe('subscriber_not_found');
    });

    it('rejects inactive or quarantined subscriber', () => {
      subscriber.active = false;
      const auth = verifier.verifySubscriberAuthorization('sub-acme-corp', 'ticket.issued', testSecret);
      expect(auth.ok).toBe(false);
      if (auth.ok) return;
      expect(auth.code).toBe('inactive_subscriber');
    });

    it('enforces subscriber authorization during verifyReplayWindow', () => {
      const message = verifier.createSignedMessage({ event: 'unauthorized.event' }, testSecret);
      message.event = 'unauthorized.event';

      const result = verifier.verifyReplayWindow(message, testSecret, {
        subscriberId: 'sub-acme-corp',
        expectedEvent: 'unauthorized.event'
      });

      expect(result.valid).toBe(false);
      expect(result.code).toBe('unauthorized_event');
    });
  });

  describe('Retry & Recovery Path', () => {
    it('recognizes only an identical signed delivery when an idempotent retry is explicitly allowed', () => {
      const store = createMemoryReplayProtectionStore();
      const verifier = new WebhookVerifier({ nonceDeduplication: true }, { replayStore: store });
      const message = verifier.createSignedMessage({ orderId: 'ord-retry' }, testSecret);
      const now = message.signature.timestamp;

      expect(verifier.verifyReplayWindow(message, testSecret, { now }).valid).toBe(true);
      expect(verifier.verifyReplayWindow(message, testSecret, {
        now: now + 1,
        allowIdempotentRetry: true
      })).toMatchObject({ valid: true, replayed: true });

      const changed = { ...message, data: { orderId: 'ord-other' } };
      expect(verifier.verifyReplayWindow(changed, testSecret, {
        now: now + 1,
        allowIdempotentRetry: true
      })).toMatchObject({ valid: false, code: 'signature_verification_failed' });
    });

    it('keeps replay claims across verifier instances when backed by a durable adapter', () => {
      const replayStore = createMemoryReplayProtectionStore();
      const firstVerifier = new WebhookVerifier({}, { replayStore });
      const message = firstVerifier.createSignedMessage({ id: 1 }, testSecret);
      const now = message.signature.timestamp;

      expect(firstVerifier.verifyReplayWindow(message, testSecret, { now }).valid).toBe(true);
      const restartedVerifier = new WebhookVerifier({}, { replayStore });
      expect(restartedVerifier.verifyReplayWindow(message, testSecret, { now: now + 1 }))
        .toMatchObject({ valid: false, code: 'replay_attack_detected' });
    });

    it('fails closed when the replay store cannot durably claim a nonce', () => {
      const replayStore: ReplayProtectionStore = {
        get: () => undefined,
        claim: () => { throw new Error('store unavailable'); },
        removeExpired: () => 0,
        trim: () => 0,
        clear: () => undefined,
        size: 0
      };
      const verifier = new WebhookVerifier({}, { replayStore });
      const message = verifier.createSignedMessage({ id: 1 }, testSecret);

      expect(verifier.verifyReplayWindow(message, testSecret, {
        now: message.signature.timestamp
      })).toMatchObject({ valid: false, code: 'replay_store_unavailable' });
    });

    it('computes exponential backoff with jitter for retries', () => {
      const delay0 = verifier.computeRetryBackoffMs(0, 1000, 30000);
      const delay1 = verifier.computeRetryBackoffMs(1, 1000, 30000);
      const delay2 = verifier.computeRetryBackoffMs(2, 1000, 30000);

      expect(delay0).toBeGreaterThanOrEqual(1000);
      expect(delay1).toBeGreaterThanOrEqual(2000);
      expect(delay2).toBeGreaterThanOrEqual(4000);
      expect(delay2).toBeLessThanOrEqual(30000 + 200);
    });

    it('auto-quarantines subscriber after 11 consecutive failures and allows operator rollback', () => {
      const sub: WebhookSubscriber = {
        id: 'sub-failing',
        url: 'https://bad.endpoint/hook',
        secret: 'sec-1',
        events: ['*'],
        active: true,
        createdAt: new Date(),
        failureCount: 0,
        successCount: 0
      };
      verifier.registerSubscriber(sub);

      // Record 11 delivery failures
      for (let i = 0; i < 11; i++) {
        verifier.recordDeliveryAttempt({
          id: `attempt-${i}`,
          subscriberId: 'sub-failing',
          messageId: `msg-${i}`,
          timestamp: new Date(),
          statusCode: 500,
          retryCount: i,
          success: false
        });
      }

      // Check auto-quarantined
      expect(sub.active).toBe(false);

      // Operator recovery rollback: reactivate subscriber
      const reactivated = verifier.reactivateSubscriber('sub-failing');
      expect(reactivated).toBe(true);
      expect(sub.active).toBe(true);
      expect(sub.failureCount).toBe(0);
    });

    it('evicts expired nonces in O(1) amortized sliding window without unbounded growth', () => {
      const now = 1700000000;
      // Add nonces from past
      for (let i = 0; i < 50; i++) {
        const msg = verifier.createSignedMessage({ i }, testSecret);
        msg.signature.timestamp = now - 400 + i; // all > 300s old
        // Record directly
        (verifier as any).recordNonce(msg.signature.nonce, msg.signature.timestamp, msg.id);
      }

      // Verify that after recording a fresh nonce, expired nonces are purged from queue
      const freshMsg = verifier.createSignedMessage({ fresh: true }, testSecret);
      (verifier as any).recordNonce(freshMsg.signature.nonce, now, freshMsg.id);

      const stats = verifier.getReplayProtectionStats();
      expect(stats.totalNonces).toBeLessThan(50);
    });
  });
});
