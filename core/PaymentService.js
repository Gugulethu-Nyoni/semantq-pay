// packages/@semantq/pay/core/PaymentService.js
//
// Abstract contract every payment provider must implement.
// No concrete logic. Every method throws if not overridden.
//
// Providers extend this class and implement:
//   - createCheckout(instruction)       → { checkoutId, redirectUrl, providerReference, providerPaymentIntent? }
//   - verifyPayment(providerReference)  → { status, amountMinor, currency }
//   - verifyWebhook(rawBody, headers)   → parsed payload (throws with code: 'INVALID_SIGNATURE' on failure)
//   - normalizeEvent(rawPayload)        → { paymentRecordId, status, amountMinor, currency, providerGateway, providerReference, providerPaymentIntent?, providerCreatedAt? }
//
// Instruction contract (TrustedPaymentInstruction):
//   {
//     paymentRecordId: string,       // application payment record id
//     amountMinor: integer,          // server-authoritative amount in minor units
//     currency: string,              // lowercase ISO, e.g. 'zar'
//     description?: string,          // shown to customer
//     email?: string,                // customer email
//     successUrl: string,            // redirect after payment
//     cancelUrl: string,             // redirect on cancel
//     metadata?: object,             // application context, free-form
//   }

import { BaseProvider } from './BaseProvider.js';

export class PaymentService extends BaseProvider {
  constructor() {
    super();
    if (this.constructor === PaymentService) {
      throw new Error('PaymentService is abstract and cannot be instantiated directly.');
    }
  }

  /**
   * @abstract
   * @param {Object} instruction — TrustedPaymentInstruction
   * @returns {Promise<{ checkoutId: string, redirectUrl: string, providerReference: string, providerPaymentIntent?: string }>}
   */
  async createCheckout(instruction) {
    throw new Error(`[${this.name || 'Provider'}] createCheckout() must be implemented.`);
  }

  /**
   * @abstract
   * @param {string} providerReference
   * @returns {Promise<{ status: string, amountMinor: number, currency: string }>}
   */
  async verifyPayment(providerReference) {
    throw new Error(`[${this.name || 'Provider'}] verifyPayment() must be implemented.`);
  }

  /**
   * @abstract
   * @param {Buffer} rawBody — raw webhook body (never re-serialized)
   * @param {Object} headers — full request header object
   * @returns {Object} parsed webhook payload, or throws with code 'INVALID_SIGNATURE'
   */
  verifyWebhook(rawBody, headers) {
    throw new Error(`[${this.name || 'Provider'}] verifyWebhook() must be implemented.`);
  }

  /**
   * @abstract
   * @param {Object} rawPayload — result of verifyWebhook
   * @returns {{
   *   paymentRecordId: string,
   *   status: 'PENDING'|'PROCESSING'|'SUCCEEDED'|'FAILED'|'CANCELLED'|'EXPIRED'|'REFUNDED'|'PARTIALLY_REFUNDED',
   *   amountMinor: number,
   *   currency: string,
   *   providerGateway: string,
   *   providerReference: string,
   *   providerPaymentIntent?: string,
   *   providerCreatedAt?: Date,
   *   raw?: Object
   * }}
   */
  normalizeEvent(rawPayload) {
    throw new Error(`[${this.name || 'Provider'}] normalizeEvent() must be implemented.`);
  }
}
