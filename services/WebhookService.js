import fetch from 'node-fetch';
import blinque from '../index.js'; // Use the singleton instance

/**
 * WebhookService
 * 
 * Acts as the centralized entry point for all external payment notifications.
 * It validates authenticity via HMAC and forwards normalized data to Pylon.
 */
export class WebhookService {
  /**
   * Main processing loop
   * @param {string} gatewayName - 'yoco' or 'paystack'
   * @param {Buffer|string} rawBody - The unparsed request body (critical for HMAC)
   * @param {string} signature - The signature header
   */
  async processWebhook(gatewayName, rawBody, signature) {
    // 1. Access the Raw Provider directly via the dedicated method
    const provider = blinque.getPaymentProvider(gatewayName);
    
    if (!provider) {
      console.error(`[WebhookService] Provider for ${gatewayName} not found.`);
      throw new Error(`Gateway ${gatewayName} initialization failed.`);
    }

    // Ensure body is a string for HMAC verification logic
    const bodyString = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody;

    // 2. Security Verification
    // Each provider handles their unique crypto logic (SHA256 for Yoco, SHA512 for Paystack)
    const isValid = provider.verifyWebhook(bodyString, signature);
    
    if (!isValid) {
      console.warn(`[WebhookService] Security Alert: Invalid signature for ${gatewayName}`);
      throw new Error(`Invalid webhook signature for ${gatewayName}`);
    }

    // 3. Data Normalization
    // Convert Gateway-specific JSON -> Semantq Unified Payment Event
    const rawPayload = JSON.parse(bodyString);
    const normalized = provider.normalizeEvent(rawPayload);

    console.log(`[WebhookService] ${gatewayName.toUpperCase()} event: ${normalized.status} | PaymentRecordId: ${normalized.paymentRecordId}`);

    // 4. Forward to Pylon Core
    // Only forward if we have a valid database reference to update
    if (!normalized.paymentRecordId || normalized.paymentRecordId === 'NaN') {
       console.error(`[WebhookService] Aborting: Normalized event missing valid paymentRecordId.`);
       return false;
    }

    return await this.forwardToPylon(normalized);
  }

  /**
   * Internal Forwarding to Pylon Callback
   * This is the permanent link to your PostgreSQL database logic.
   */
  async forwardToPylon(event) {
    const pylonWebhookUrl = `${process.env.BASE_URL}/@semantq/pylon/packagePayment/packagePayments/callback`;
    
    try {
      const response = await fetch(pylonWebhookUrl, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'X-Blinque-Token': process.env.APP_KEY 
        },
        body: JSON.stringify({
          ...event,
          processedAt: new Date().toISOString(),
          source: 'blinque-webhook-engine'
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[WebhookService] Pylon rejected callback: ${response.status} - ${errorText}`);
        return false;
      }

      console.log(`[WebhookService] Pylon successfully updated Record: ${event.paymentRecordId}`);
      return true;
    } catch (error) {
      console.error('[WebhookService] Failed to reach Pylon service:', error.message);
      return false;
    }
  }
}

export default new WebhookService();