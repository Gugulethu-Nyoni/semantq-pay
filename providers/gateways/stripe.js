import { BaseProvider } from '../../core/BaseProvider.js';
import crypto from 'crypto';

export class Stripe extends BaseProvider {
  constructor(credentials) {
    super();
    this.name = 'Stripe';
    this.secretKey = credentials.secretKey;
    this.publicKey = credentials.publicKey;
    this.baseUrl = 'https://api.stripe.com/v1';
    this.webhookSecret = credentials.webhookSecret;
    
    const environment = this.secretKey?.startsWith('sk_live_') ? 'live' : 'test';
    console.log(`[Stripe] Provider Active: ${environment} mode`);
  }

  /**
   * Creates a Stripe Checkout Session.
   * Stripe expects amount in cents/smallest currency unit.
   */
  async createCheckout(payload) {
    const amountInCents = Math.round(parseFloat(payload.amount) * 100);

    const params = new URLSearchParams();
    params.append('payment_method_types[]', 'card');
    params.append('mode', 'payment');
    params.append('success_url', payload.successUrl);
    params.append('cancel_url', payload.cancelUrl);
    params.append('customer_email', payload.email);
    params.append('client_reference_id', String(payload.paymentRecordId));
    
    params.append('line_items[0][price_data][currency]', payload.currency || 'zar');
    params.append('line_items[0][price_data][product_data][name]', 'Subscription Payment');
    params.append('line_items[0][price_data][unit_amount]', amountInCents);
    params.append('line_items[0][quantity]', '1');

    // Pass metadata for webhook identification
    params.append('metadata[paymentRecordId]', String(payload.paymentRecordId));
    params.append('metadata[organizationId]', String(payload.metadata?.organizationId || ''));
    params.append('metadata[pylon_gateway]', 'stripe');

    Object.entries(payload.metadata || {}).forEach(([key, value]) => {
      params.append(`metadata[${key}]`, String(value));
    });

    console.log('[Stripe] Creating checkout session:', {
      amount: amountInCents,
      currency: payload.currency || 'zar',
      paymentRecordId: payload.paymentRecordId
    });

    const response = await this.request('/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });

    return {
      checkoutId: response.id,
      redirectUrl: response.url,
      status: 'pending',
      providerReference: response.id
    };
  }

  /**
   * Webhook Signature Verification
   * Stripe uses HMAC SHA256 with the webhook signing secret.
   * Signature format: t=timestamp,v1=sig1,v0=sig0
   */
  verifyWebhook(rawBody, signatureHeader) {
    if (!signatureHeader || !this.webhookSecret) {
      console.log('[Stripe] Missing signature header or webhook secret');
      return false;
    }

    console.log('[Stripe Debug] Signature header:', signatureHeader);
    console.log('[Stripe Debug] Webhook secret (first 10 chars):', this.webhookSecret.substring(0, 10));
    console.log('[Stripe Debug] Raw body:', rawBody);

    try {
      const parts = signatureHeader.split(',');
      const timestamp = parts.find(p => p.startsWith('t='))?.split('=')[1];
      const signatures = parts
        .filter(p => p.startsWith('v1='))
        .map(p => p.split('=')[1]);

      console.log('[Stripe Debug] Timestamp:', timestamp);
      console.log('[Stripe Debug] Signatures found:', signatures.length);

      if (!timestamp || signatures.length === 0) {
        console.log('[Stripe] Missing timestamp or signatures');
        return false;
      }

      const signedPayload = `${timestamp}.${rawBody}`;
      
      for (const signature of signatures) {
        const expectedSignature = crypto
          .createHmac('sha256', this.webhookSecret)
          .update(signedPayload)
          .digest('hex');

        console.log('[Stripe Debug] Expected:', expectedSignature.substring(0, 20));
        console.log('[Stripe Debug] Received:', signature.substring(0, 20));

        if (expectedSignature === signature) {
          console.log('[Stripe] Signature verified');
          return true;
        }
      }

      console.log('[Stripe] Signature mismatch');
      return false;
    } catch (error) {
      console.error('[Stripe] Webhook Verification Failed:', error.message);
      return false;
    }
  }

  /**
   * Normalizes Stripe's payload into the Semantq Standard format
   */
  normalizeEvent(payload) {
    const { type, data } = payload;

    const statusMap = {
      'checkout.session.completed': 'PAID',
      'checkout.session.expired': 'FAILED',
      'payment_intent.payment_failed': 'FAILED',
      'payment_intent.succeeded': 'PAID'
    };

    // Extract paymentRecordId from metadata
    const paymentRecordId = data?.object?.metadata?.paymentRecordId 
      || data?.object?.client_reference_id;

    const amount = data?.object?.amount_total 
      ? data.object.amount_total / 100 
      : (data?.object?.amount || 0) / 100;

    return {
      paymentRecordId: paymentRecordId,
      status: statusMap[type] || 'PROCESSING',
      amount: amount,
      currency: data?.object?.currency || 'zar',
      gatewayReference: data?.object?.id || data.id,
      pylon_gateway: 'stripe'
    };
  }

  /**
   * Internal Request Wrapper
   */
  async request(url, options = {}) {
    const fullUrl = url.startsWith('http') ? url : `${this.baseUrl}${url}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    try {
      const response = await fetch(fullUrl, {
        ...options,
        signal: controller.signal
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error?.message || 'Stripe request failed');
      }

      return data;
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new Error('Stripe API Timeout (30s)');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

// Temporary alias — Phase 1.2 renames the class to StripeProvider.
// Remove this line when Phase 1.2 lands.
export { Stripe as StripeProvider };
