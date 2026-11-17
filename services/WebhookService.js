// packages/@semantq/pay/services/WebhookService.js
//
// Webhook processing pipeline. Provider-agnostic.
//
// Responsibilities:
//   1. Resolve the provider for a given gateway.
//   2. Verify the signature (throws INVALID_SIGNATURE on failure).
//   3. Normalize the raw event into a canonical payment event.
//   4. Persist the webhook event (dedupe via unique constraint).
//   5. Update the payment record (monotonic status transitions).
//   6. Call the host application's paymentEventHandler, if registered.
//
// This service does NOT:
//   - Know about Pylon, CrowdKit, registrants, subscriptions, or any host app.
//   - POST to any external URL.
//   - Modify application business state directly.

import getPrismaClient from '../../../../lib/prisma.js';
import pay from '../index.js';

const TERMINAL_STATUSES = new Set([
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'EXPIRED',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
]);

const ALLOWED_TRANSITIONS = {
  PENDING:    new Set(['PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED']),
  PROCESSING: new Set(['PROCESSING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED']),
  SUCCEEDED:  new Set(['SUCCEEDED', 'REFUNDED', 'PARTIALLY_REFUNDED']),
  FAILED:     new Set(['FAILED']),
  CANCELLED:  new Set(['CANCELLED']),
  EXPIRED:    new Set(['EXPIRED']),
  REFUNDED:   new Set(['REFUNDED', 'PARTIALLY_REFUNDED']),
  PARTIALLY_REFUNDED: new Set(['PARTIALLY_REFUNDED', 'REFUNDED']),
};

class WebhookService {

  async processWebhook(gatewayName, rawBody, headers) {
    console.log('[WebhookService] ENTERED', {
      gateway: gatewayName,
      hasRawBody: !!rawBody,
      rawBodyLen: rawBody?.length,
    });
    // ── 1. Resolve provider ────────────────────────────────────
    let provider;
    try {
      provider = pay.getPaymentProvider(gatewayName);
    } catch (err) {
      const e = new Error(`[WebhookService] Provider '${gatewayName}' not registered`);
      e.code = 'UNKNOWN_GATEWAY';
      throw e;
    }

    // ── 2. Verify signature (throws INVALID_SIGNATURE) ─────────
    const rawPayload = provider.verifyWebhook(rawBody, headers);

    // ── 3. Normalize to canonical event ────────────────────────
    let normalized;
    try {
      normalized = provider.normalizeEvent(rawPayload);
    } catch (err) {
      // Unsupported event type — ack but do not persist as processed
      if (err.code === 'UNSUPPORTED_EVENT') {
        const e = new Error(`[WebhookService] Unsupported event from ${gatewayName}`);
        e.code = 'UNSUPPORTED_EVENT';
        throw e;
      }
      throw err;
    }

    const {
      paymentRecordId,
      status,
      amountMinor,
      currency,
      providerGateway,
      providerReference,
      providerPaymentIntent,
      providerCreatedAt,
      providerEventId,
      eventType,
      raw,
    } = normalized;

    console.log('[WebhookService] NORMALIZED', {
      paymentRecordId,
      providerEventId,
      eventType,
      status,
      amountMinor,
      currency,
    });

    if (!paymentRecordId || !providerEventId) {
      const e = new Error('[WebhookService] Normalized event missing required identity fields');
      e.code = 'INVALID_EVENT';
      throw e;
    }

    console.log('[WebhookService] Event received', {
      gateway: providerGateway,
      eventId: providerEventId,
      eventType,
      paymentRecordId,
      status,
      amountMinor,
      currency,
    });

    // ── 4. Persist webhook event (dedupe) ──────────────────────
    const prisma = await getPrismaClient();

    let webhookRow;
    try {
      webhookRow = await prisma.semantqPayWebhookEvent.create({
        data: {
          paymentRecordId: String(paymentRecordId),
          providerGateway: String(providerGateway),
          providerEventId: String(providerEventId),
          eventType: String(eventType),
          status: String(status),
          providerCreatedAt: providerCreatedAt || null,
          rawPayload: raw || rawPayload,
          processedAt: new Date(),
        },
      });
      console.log('[WebhookService] PERSISTED', { webhookRowId: webhookRow.id });
    } catch (err) {
      if (err.code === 'P2002') {
        // Duplicate event — already processed
        console.log('[WebhookService] Duplicate event, ignoring', {
          gateway: providerGateway,
          eventId: providerEventId,
        });
        return {
          status,
          duplicate: true,
          paymentRecordId,
        };
      }
      throw err;
    }

    // ── 5. Upsert payment record (monotonic) ───────────────────
    const existingPayment = await prisma.semantqPayPayment.findUnique({
      where: { paymentRecordId: String(paymentRecordId) },
    });

    let payment;
    if (!existingPayment) {
      // First event for this payment — create it
      payment = await prisma.semantqPayPayment.create({
        data: {
          paymentRecordId: String(paymentRecordId),
          providerGateway: String(providerGateway),
          providerReference: providerReference || null,
          providerPaymentIntent: providerPaymentIntent || null,
          amountMinor: Number(amountMinor) || 0,
          currency: String(currency || 'zar').toLowerCase(),
          status,
          description: null,
          metadata: null,
          rawProviderEvent: raw || rawPayload,
        },
      });
    } else {
      // Existing payment — check monotonic transition
      const allowed = ALLOWED_TRANSITIONS[existingPayment.status];
      const transitionOk = allowed ? allowed.has(status) : false;

      if (!transitionOk) {
        console.warn('[WebhookService] Rejected status transition', {
          paymentRecordId,
          from: existingPayment.status,
          to: status,
          eventId: providerEventId,
        });
        payment = existingPayment;
      } else {
        payment = await prisma.semantqPayPayment.update({
          where: { id: existingPayment.id },
          data: {
            status,
            providerReference: providerReference || existingPayment.providerReference,
            providerPaymentIntent: providerPaymentIntent || existingPayment.providerPaymentIntent,
            rawProviderEvent: raw || rawPayload,
          },
        });
      }
    }

    // ── 6. Notify host application ─────────────────────────────
    const handler = pay.getPaymentEventHandler();
    if (typeof handler === 'function') {
      const event = {
        paymentRecordId: String(paymentRecordId),
        status,
        amountMinor: Number(amountMinor) || 0,
        currency: String(currency || 'zar').toLowerCase(),
        providerGateway: String(providerGateway),
        providerReference: providerReference || null,
        providerPaymentIntent: providerPaymentIntent || null,
        providerCreatedAt: providerCreatedAt || null,
        providerEventId,
        eventType,
        raw,
        webhookEventId: webhookRow.id,
      };

      try {
        await handler(event);
      } catch (err) {
        // Handler failed — mark webhook event as failed, re-throw so route returns 500
        await prisma.semantqPayWebhookEvent.update({
          where: { id: webhookRow.id },
          data: { status: 'FAILED' },
        });
        console.error('[WebhookService] Payment handler threw', {
          gateway: providerGateway,
          eventId: providerEventId,
          message: err.message,
        });
        throw err;
      }
    }

    return {
      status,
      duplicate: false,
      paymentRecordId,
      webhookEventId: webhookRow.id,
    };
  }
}

export default new WebhookService();
