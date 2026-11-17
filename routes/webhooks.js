// packages/@semantq/pay/routes/webhooks.js
//
// Single generic webhook route. Provider identified by URL param.
// Signature verification and event normalisation happen inside
// WebhookService, using the provider's own verification method.
//
// The body is preserved by bodyParser.json's verify hook in server.js:
//   req.rawBody = Buffer.from(buf)  (for /@semantq/pay/webhook/*)
//
// So this route must NOT call express.raw() — the body is already consumed.

import express from 'express';
import WebhookService from '../services/WebhookService.js';
import pay from '../index.js';

const router = express.Router();

router.post('/webhook/:gateway', async (req, res) => {
  const { gateway } = req.params;
  console.log('[PAY-WEBHOOK-ROUTE] HIT', {
    gateway,
    hasRawBody: !!req.rawBody,
    rawBodyLen: req.rawBody?.length,
    hasSignature: !!req.headers['stripe-signature'],
  });

  if (!req.rawBody || !Buffer.isBuffer(req.rawBody)) {
    console.error('[Pay:WEBHOOK] rawBody missing for', gateway);
    return res.status(400).json({
      error: 'Raw body not captured',
      code: 'NO_RAW_BODY',
    });
  }

  if (!pay.isReady()) {
    return res.status(503).json({
      error: 'Payment engine not initialized',
      code: 'ENGINE_NOT_READY',
    });
  }

  try {
    const event = await WebhookService.processWebhook(
      gateway,
      req.rawBody,
      req.headers,
    );

    return res.status(200).json({
      received: true,
      status: event?.status || 'UNKNOWN',
      duplicate: event?.duplicate || false,
    });

  } catch (err) {
    if (err.code === 'INVALID_SIGNATURE' || err.message === 'INVALID_SIGNATURE') {
      console.warn('[Pay:WEBHOOK] invalid signature', { gateway });
      return res.status(400).json({
        error: 'Invalid signature',
        code: 'INVALID_SIGNATURE',
      });
    }

    if (err.code === 'UNSUPPORTED_EVENT') {
      return res.status(200).json({
        received: true,
        status: 'IGNORED',
      });
    }

    console.error('[Pay:WEBHOOK] processing failed', {
      gateway,
      message: err.message,
      code: err.code,
    });
    return res.status(500).json({
      error: 'Processing failed',
      code: err.code || 'PROCESSING_FAILED',
    });
  }
});

export default router;
