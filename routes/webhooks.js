import express from 'express';
import WebhookService from '../services/WebhookService.js';

const router = express.Router();

/**
 * Yoco Webhook Endpoint
 * Receives raw webhook from Yoco, verifies signature, normalizes, and forwards to Pylon.
 */
router.post('/yoco', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const signature = req.headers['yoco-signature'];
    const rawBody = req.body;
    
    await WebhookService.processWebhook('yoco', rawBody, signature);
    
    // Always return 200 to Yoco to acknowledge receipt
    res.status(200).json({ received: true });
  } catch (error) {
    console.error('[Yoco Webhook] Error:', error.message);
    // Still return 200 to prevent Yoco from retrying
    res.status(200).json({ received: true, error: error.message });
  }
});

/**
 * Paystack Webhook Endpoint
 * Receives raw webhook from Paystack, verifies signature, normalizes, and forwards to Pylon.
 */
router.post('/paystack', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const signature = req.headers['x-paystack-signature'];
    const rawBody = req.body;
    
    await WebhookService.processWebhook('paystack', rawBody, signature);
    
    // Always return 200 to Paystack to acknowledge receipt
    res.status(200).json({ received: true });
  } catch (error) {
    console.error('[Paystack Webhook] Error:', error.message);
    // Still return 200 to prevent Paystack from retrying
    res.status(200).json({ received: true, error: error.message });
  }
});

export default router;