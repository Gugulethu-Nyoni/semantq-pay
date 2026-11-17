// packages/@semantq/pay/services/CheckoutService.js
//
// Orchestrates checkout creation. Provider-agnostic.
// Validates the TrustedPaymentInstruction before delegating to the provider.
//
// The host application is responsible for:
//   - Computing the authoritative amount (amountMinor).
//   - Providing the paymentRecordId (its own payment record).
//   - Providing successUrl / cancelUrl.
//   - Providing the customer email if required by the gateway.
//
// This service is stateless. No persistence, no DB, no callback registration.

export class CheckoutService {
  constructor(paymentProvider) {
    if (!paymentProvider) {
      throw new Error('[CheckoutService] paymentProvider is required');
    }
    this.paymentProvider = paymentProvider;
  }

  /**
   * Validate a TrustedPaymentInstruction.
   * Throws on invalid instruction. No mutation.
   *
   * @param {Object} instruction
   */
  _validateInstruction(instruction) {
    if (!instruction || typeof instruction !== 'object') {
      throw new Error('[CheckoutService] instruction must be an object');
    }

    if (!instruction.paymentRecordId || typeof instruction.paymentRecordId !== 'string') {
      throw new Error('[CheckoutService] instruction.paymentRecordId is required (string)');
    }

    if (!Number.isInteger(instruction.amountMinor) || instruction.amountMinor <= 0) {
      throw new Error('[CheckoutService] instruction.amountMinor must be a positive integer');
    }

    if (!instruction.currency || typeof instruction.currency !== 'string') {
      throw new Error('[CheckoutService] instruction.currency is required (string)');
    }

    if (!instruction.successUrl || typeof instruction.successUrl !== 'string') {
      throw new Error('[CheckoutService] instruction.successUrl is required (string)');
    }

    if (!instruction.cancelUrl || typeof instruction.cancelUrl !== 'string') {
      throw new Error('[CheckoutService] instruction.cancelUrl is required (string)');
    }
  }

  /**
   * Initiate a checkout session with the underlying provider.
   *
   * @param {Object} instruction — TrustedPaymentInstruction
   * @returns {Promise<{ checkoutId, redirectUrl, providerReference, providerPaymentIntent? }>}
   */
  async initiateCheckout(instruction) {
    this._validateInstruction(instruction);

    const payload = {
      paymentRecordId: String(instruction.paymentRecordId),
      amountMinor: instruction.amountMinor,
      currency: instruction.currency.toLowerCase(),
      description: instruction.description || 'Payment',
      email: instruction.email || null,
      successUrl: instruction.successUrl,
      cancelUrl: instruction.cancelUrl,
      metadata: instruction.metadata || {},
    };

    console.log('[CheckoutService] Initiating checkout', {
      paymentRecordId: payload.paymentRecordId,
      amountMinor: payload.amountMinor,
      currency: payload.currency,
      provider: this.paymentProvider.name,
    });

    const result = await this.paymentProvider.createCheckout(payload);

    if (!result || !result.redirectUrl) {
      throw new Error('[CheckoutService] Provider did not return a redirectUrl');
    }

    return result;
  }
}
