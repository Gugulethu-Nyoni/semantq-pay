/**
 * CheckoutService
 * Part of @semantq/blinque
 * 
 * Orchestrates the hand-off between the application logic and specific 
 * payment providers (Yoco, Paystack, etc.) using a semantic data model.
 */
export class CheckoutService {
  constructor(paymentProvider) {
    this.paymentProvider = paymentProvider;
  }

  /**
   * Universal Payment Orchestrator
   * Works for physical ecommerce (Botaniq) and digital subscriptions (Pylon).
   * 
   * @param {Object} data - Raw input from the controller
   * @returns {Promise<Object>} - Standardized checkout response (url/token)
   */
  async initiateCheckout(data) {
    // 1. Normalize the payload using the semantic 'paymentRecordId'
    // This maps various incoming IDs (orderId for shop, organizationId for SaaS) 
    // to a single unified reference that matches your DB schema.
    const payload = {
      paymentRecordId: data.paymentRecordId || data.orderId || data.organizationId,
      amount: data.amount || data.total,
      currency: data.currency || 'ZAR',
      email: data.email, // Required for Paystack and customer receipts
      metadata: {
        // Distinguish between physical goods and SaaS subscriptions
        category: data.shippingQuoteId ? 'ECOMMERCE' : 'SUBSCRIPTION',
        ...data.metadata // Preserves packageId, billingCycle, or custom tags
      },
      successUrl: data.successUrl,
      cancelUrl: data.cancelUrl
    };

    // 2. Logging for Debugging
    // We now log the semantic 'paymentRecordId' instead of 'externalId'
    console.log('[CheckoutService] Initializing Session:', { 
      email: payload.email, 
      paymentRecordId: payload.paymentRecordId, 
      amount: payload.amount 
    });

    // 3. Validation Check
    if (!payload.paymentRecordId) {
      throw new Error('[CheckoutService] Missing paymentRecordId. Cannot initiate checkout without a database reference.');
    }

    // 4. Provider Execution
    // The specific Provider class (Yoco.js or Paystack.js) will receive this 
    // payload and map 'paymentRecordId' into its specific metadata or reference fields.
    return await this.paymentProvider.createCheckout(payload);
  }
}