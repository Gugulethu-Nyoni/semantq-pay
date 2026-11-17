// packages/@semantq/pay/providers/gateways/stripe.js
//
// Stripe payment provider.
// Uses the official Stripe SDK for checkout + webhook verification.
// Event normalization maps Stripe events to SemantqPayPaymentStatus.

import Stripe from 'stripe';
import { PaymentService } from '../../core/PaymentService.js';

const STRIPE_EVENT_STATUS_MAP = {
  'checkout.session.completed':         null,    // resolved by payment_status
  'checkout.session.async_payment_succeeded': 'SUCCEEDED',
  'checkout.session.async_payment_failed':    'FAILED',
  'checkout.session.expired':                 'EXPIRED',
  'payment_intent.succeeded':                 'SUCCEEDED',
  'payment_intent.payment_failed':            'FAILED',
  'payment_intent.canceled':                  'CANCELLED',
  'charge.refunded':                          null,    // resolved by amount_refunded vs amount
};

export class StripeProvider extends PaymentService {
  constructor(credentials) {
    super();

    if (!credentials?.secretKey) {
      throw new Error('[Stripe] credentials.secretKey is required');
    }
    if (!credentials?.webhookSecret) {
      throw new Error('[Stripe] credentials.webhookSecret is required');
    }

    this.name = 'Stripe';
    this.secretKey = credentials.secretKey;
    this.publicKey = credentials.publicKey || null;
    this.webhookSecret = credentials.webhookSecret;

    this.stripe = new Stripe(this.secretKey, {
      apiVersion: '2024-11-20.acacia',
      appInfo: {
        name: '@semantq/pay',
        version: '1.0.0',
      },
    });

    const environment = this.secretKey.startsWith('sk_live_') ? 'live' : 'test';
    console.log(`[Stripe] Provider Active: ${environment} mode`);
  }

  /**
   * Create a Stripe Checkout Session.
   *
   * @param {Object} instruction — TrustedPaymentInstruction
   * @param {string} instruction.paymentRecordId
   * @param {number} instruction.amountMinor
   * @param {string} instruction.currency          — lowercase ISO, e.g. 'zar'
   * @param {string} [instruction.description]
   * @param {string} [instruction.email]
   * @param {string} instruction.successUrl
   * @param {string} instruction.cancelUrl
   * @param {Object} [instruction.metadata]
   * @returns {Promise<{ checkoutId, redirectUrl, providerReference, providerPaymentIntent }>}
   */
  async createCheckout(instruction) {
    if (!Number.isInteger(instruction.amountMinor) || instruction.amountMinor <= 0) {
      throw new Error('[Stripe] amountMinor must be a positive integer');
    }
    if (!instruction.paymentRecordId) {
      throw new Error('[Stripe] paymentRecordId is required');
    }
    if (!instruction.successUrl || !instruction.cancelUrl) {
      throw new Error('[Stripe] successUrl and cancelUrl are required');
    }

    const currency = (instruction.currency || 'zar').toLowerCase();

    const metadata = {
      ...(instruction.metadata || {}),
      paymentRecordId: String(instruction.paymentRecordId),
      providerGateway: 'stripe',
    };

    const session = await this.stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency,
            unit_amount: instruction.amountMinor,
            product_data: {
              name: instruction.description || 'Payment',
            },
          },
          quantity: 1,
        },
      ],
      customer_email: instruction.email || undefined,
      client_reference_id: String(instruction.paymentRecordId),
      metadata,
      payment_intent_data: {
        metadata,
      },
      success_url: instruction.successUrl,
      cancel_url: instruction.cancelUrl,
    });

    console.log('[Stripe] Checkout session created', {
      sessionId: session.id,
      paymentRecordId: instruction.paymentRecordId,
      amountMinor: instruction.amountMinor,
      currency,
    });

    return {
      checkoutId: session.id,
      redirectUrl: session.url,
      providerReference: session.id,
      providerPaymentIntent: typeof session.payment_intent === 'string'
        ? session.payment_intent
        : session.payment_intent?.id || null,
    };
  }

  /**
   * Server-side verification of a checkout session.
   *
   * @param {string} sessionId
   * @returns {Promise<{ status: string, amountMinor: number, currency: string }>}
   */
  async verifyPayment(sessionId) {
    const session = await this.stripe.checkout.sessions.retrieve(sessionId);

    let status = 'PENDING';
    if (session.payment_status === 'paid') {
      status = 'SUCCEEDED';
    } else if (session.payment_status === 'unpaid') {
      if (session.status === 'expired') status = 'EXPIRED';
      else if (session.status === 'complete') status = 'PROCESSING';
    }

    return {
      status,
      amountMinor: session.amount_total || 0,
      currency: (session.currency || 'zar').toLowerCase(),
    };
  }

  /**
   * Verify a Stripe webhook signature.
   * Uses the official SDK's constructEvent — constant-time comparison,
   * timestamp tolerance, all edge cases handled.
   *
   * @param {Buffer} rawBody
   * @param {Object} headers
   * @returns {Object} parsed Stripe event
   * @throws Error with code 'INVALID_SIGNATURE' on failure
   */
  verifyWebhook(rawBody, headers) {
    const signature = headers['stripe-signature'];

    if (!signature) {
      const err = new Error('[Stripe] Missing stripe-signature header');
      err.code = 'INVALID_SIGNATURE';
      throw err;
    }

    if (!Buffer.isBuffer(rawBody)) {
      const err = new Error('[Stripe] rawBody must be a Buffer');
      err.code = 'INVALID_SIGNATURE';
      throw err;
    }

    try {
      return this.stripe.webhooks.constructEvent(
        rawBody,
        signature,
        this.webhookSecret,
      );
    } catch (verifyErr) {
      const err = new Error(`[Stripe] Webhook verification failed: ${verifyErr.message}`);
      err.code = 'INVALID_SIGNATURE';
      throw err;
    }
  }

  /**
   * Normalize a Stripe event to the canonical Semantq Pay payment event.
   *
   * @param {Object} event — result of verifyWebhook
   * @returns {Object}
   */
  normalizeEvent(event) {
    const type = event.type;
    const object = event.data?.object || {};

    // Resolve status from event type
    let status = STRIPE_EVENT_STATUS_MAP[type];

    // Special case: checkout.session.completed — status depends on payment_status
    if (type === 'checkout.session.completed') {
      if (object.payment_status === 'paid') {
        status = 'SUCCEEDED';
      } else if (object.payment_status === 'unpaid') {
        status = 'PROCESSING';   // async payment in flight
      } else {
        status = 'PROCESSING';
      }
    }

    // Special case: charge.refunded — full vs partial
    if (type === 'charge.refunded') {
      const refunded = object.amount_refunded || 0;
      const total = object.amount || 0;
      status = refunded >= total ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
    }

    if (!status) {
      const err = new Error(`[Stripe] Unsupported event type: ${type}`);
      err.code = 'UNSUPPORTED_EVENT';
      throw err;
    }

    // Extract paymentRecordId from metadata or client_reference_id
    const metadata = object.metadata || {};
    const paymentRecordId =
      metadata.paymentRecordId ||
      object.client_reference_id ||
      null;

    if (!paymentRecordId) {
      const err = new Error(`[Stripe] Cannot resolve paymentRecordId from event ${type}`);
      err.code = 'UNSUPPORTED_EVENT';
      throw err;
    }

    // Amount — checkout sessions use amount_total; payment_intents use amount;
    // charges use amount. Always integer minor units.
    let amountMinor = 0;
    if (typeof object.amount_total === 'number') amountMinor = object.amount_total;
    else if (typeof object.amount === 'number') amountMinor = object.amount;
    else if (typeof object.amount_received === 'number') amountMinor = object.amount_received;

    const currency = (object.currency || 'zar').toLowerCase();

    const providerReference =
      object.id ||
      (typeof object.payment_intent === 'string' ? object.payment_intent : object.payment_intent?.id) ||
      null;

    const providerPaymentIntent =
      typeof object.payment_intent === 'string'
        ? object.payment_intent
        : object.payment_intent?.id ||
          (type.startsWith('payment_intent') ? object.id : null);

    return {
      paymentRecordId: String(paymentRecordId),
      status,
      amountMinor,
      currency,
      providerGateway: 'stripe',
      providerReference,
      providerPaymentIntent,
      providerCreatedAt: event.created ? new Date(event.created * 1000) : new Date(),
      providerEventId: event.id,
      eventType: type,
      raw: event,
    };
  }
}

// Temporary alias — keeps old imports working until index.js is updated in later phases
export { StripeProvider as Stripe };
