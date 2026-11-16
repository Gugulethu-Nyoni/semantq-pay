import { BaseProvider } from '../../core/BaseProvider.js';
import crypto from 'crypto'; // Required for secure HMAC verification

export class Yoco extends BaseProvider {
  constructor(credentials) {
    super();
    this.name = 'Yoco';
    this.secretKey = credentials.secretKey;
    this.publicKey = credentials.publicKey;
    this.baseUrl = 'https://payments.yoco.com/api';
    
    const environment = this.secretKey?.startsWith('sk_live_') ? 'live' : 'sandbox';
    console.log(`[Yoco] Provider Active: ${environment} mode`);
  }

  /**
   * Creates the Yoco Checkout session.
   * Ensures amounts are converted to cents for the Yoco API.
   */
  async createCheckout(payload) {
    // Yoco requires an integer in cents (e.g., R10.00 = 1000)
    const amountInCents = Math.round(parseFloat(payload.amount) * 100);

    const yocoRequest = {
      amount: amountInCents,
      currency: payload.currency || 'ZAR',
      cancelUrl: payload.cancelUrl,
      successUrl: payload.successUrl,
      metadata: {
        ...payload.metadata,
        paymentRecordId: String(payload.paymentRecordId || ''),
        organizationId: String(payload.metadata?.organizationId || '')
      }
    };

    const response = await this.request(`${this.baseUrl}/checkouts`, {
      method: 'POST',
      headers: { 
        'Authorization': `Bearer ${this.secretKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(yocoRequest)
    });

    return {
      checkoutId: response.id,
      redirectUrl: response.redirectUrl,
      status: response.status,
      providerReference: response.id 
    };
  }

  /**
   * Webhook Signature Verification
   * Handles Svix format used by Yoco: webhook-signature: "v1,<base64-signature>"
   * with separate webhook-timestamp header.
   * 
   * TODO: Implement full Svix verification (https://docs.svix.com/receiving/verifying-payloads)
   */
  verifyWebhook(rawBody, signatureHeader) {
    if (!signatureHeader) return false;

    // Svix format: "v1,<base64-signature>"
    if (signatureHeader.startsWith('v1,')) return true;

    // Legacy Yoco format: "t=1234567,v1=hash"
    if (signatureHeader.includes('v1=')) {
      try {
        const parts = signatureHeader.split(',');
        const timestamp = parts.find(p => p.startsWith('t='))?.split('=')[1];
        const signature = parts.find(p => p.startsWith('v1='))?.split('=')[1];

        if (!timestamp || !signature) return false;

        const signedPayload = `${timestamp}.${rawBody}`;
        
        const expectedSignature = crypto
          .createHmac('sha256', this.secretKey)
          .update(signedPayload)
          .digest('hex');

        return expectedSignature === signature;
      } catch (error) {
        console.error('[Yoco] Webhook Verification Failed:', error.message);
        return false;
      }
    }

    return false;
  }

  /**
   * Normalizes Yoco's payload into the Semantq Standard format
   */
  normalizeEvent(payload) {
    const { type, payload: data } = payload;

    const statusMap = {
      'payment.succeeded': 'PAID',
      'payment.failed': 'FAILED',
      'payment.cancelled': 'CANCELLED'
    };

    return {
      paymentRecordId: data.metadata?.paymentRecordId,
      status: statusMap[type] || 'PROCESSING',
      amount: data.amount / 100, // Convert back to Rands for Pylon
      gatewayReference: data.id,
      pylon_gateway: 'yoco'
    };
  }

  /**
   * Register a new webhook URL with Yoco via API
   */
  async registerWebhook(url) {
    return await this.request(`${this.baseUrl}/webhooks`, {
      method: 'POST',
      headers: { 
        'Authorization': `Bearer ${this.secretKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: 'Semantq-Pylon-Webhook',
        url: url
      })
    });
  }

  /**
   * Retrieve all registered webhooks for this Secret Key
   */
  async listWebhooks() {
    return await this.request(`${this.baseUrl}/webhooks`, {
      method: 'GET',
      headers: { 
        'Authorization': `Bearer ${this.secretKey}` 
      }
    });
  }

  /**
   * Remove a specific webhook by ID
   */
  async deleteWebhook(id) {
    return await this.request(`${this.baseUrl}/webhooks/${id}`, {
      method: 'DELETE',
      headers: { 
        'Authorization': `Bearer ${this.secretKey}` 
      }
    });
  }
}