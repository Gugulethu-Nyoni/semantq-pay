# @semantq/pay

> Plug-and-play payment engine for Semantq applications. Stripe-first. Provider-agnostic. Host-agnostic.

---

## What this is

`@semantq/pay` is a **payment execution layer**, not a CRM, order system, or billing engine.

It knows only two things:

1. **How to initiate a payment** for an opaque `paymentRecordId` with a specific amount and currency.
2. **How to receive webhook events** from payment providers, verify signatures, normalize the payload, and hand the canonical event back to the host.

It does **not** know about:
- Registrants, attendees, users
- Events, tickets, subscriptions
- Pricing packages, discounts, taxes
- Invoices, orders, fulfillment

The host application owns all of that. The host passes an opaque `paymentRecordId` — the engine never interprets it.

---

## The contract at a glance

```
Host Application                    @semantq/pay                    Provider
-----------------                   -------------                    --------

initiateCheckout(instruction) -->          |
                                           |--- creates checkout ---> |
                                           |<-- { redirectUrl } ----- |
<---- { redirectUrl, checkoutId } --------- |

[ user completes payment at provider ]

                                           |<------ webhook POST ---- |
                                           |  verify signature        |
                                           |  normalize event         |
                                           |  persist + dedupe        |
                         paymentEventHandler(event) ---> Host callback
                                           |<---- host returns ------ |
                                           |------ 200 OK ----------> |
```

**Two touchpoints.** That's the entire integration surface.

---

## Installation

```bash
# Inside your Semantq host application
npm install @semantq/pay
```

Or, for local development within the monorepo:

```js
import pay from './packages/@semantq/pay/index.js';
```

---

## Boot the engine

```js
import pay from '@semantq/pay';

await pay.init(
  {
    payments: {
      defaultProvider: 'stripe',
      providers: {
        stripe: {
          enabled: true,
          config: {
            secretKey: process.env.STRIPE_SECRET_KEY,
            webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
          },
        },
      },
    },
  },
  {
    paymentEventHandler: async (event) => {
      // Host handles fulfillment here (see "Webhook callback" below)
      console.log('[HOST] Payment event:', event.paymentRecordId, event.status);
      return { handled: true };
    },
  }
);

// Engine is now ready:
console.log(pay.isReady()); // -> true
```

**Throws if:**
- `config.payments` missing
- `stripe.enabled === true` but `secretKey` or `webhookSecret` missing
- `defaultProvider` not registered

---

## Initiate a checkout

### Request — what the host sends

```js
const gateway = pay.getPaymentGateway('stripe');

const result = await gateway.initiateCheckout({
  paymentRecordId: 'reg-payment-uuid-here',           // REQUIRED — opaque string, host-defined
  amountMinor: 19900,                                  // REQUIRED — positive integer, minor units
  currency: 'zar',                                     // REQUIRED — ISO 4217, lowercase
  successUrl: 'https://myapp.com/payment/success',     // REQUIRED — absolute URL
  cancelUrl:  'https://myapp.com/payment/cancel',      // REQUIRED — absolute URL
  description: 'CrowdKit ticket — VIP',                // OPTIONAL
  email: 'buyer@example.com',                          // OPTIONAL
  metadata: {                                          // OPTIONAL — host-correlated context
    orderId: '123',
    userId: 'abc',
  },
});
```

### Field reference

| Field | Type | Required | Notes |
|---|---|---|---|
| `paymentRecordId` | string | yes | Host-owned opaque identifier. Engine never interprets. |
| `amountMinor` | integer | yes | Minor units (cents for ZAR/USD). Must be positive. `19900` = R 199.00. |
| `currency` | string | yes | ISO 4217. `'zar'`, `'usd'`, etc. Lowercased internally. |
| `successUrl` | string | yes | Absolute URL. Where provider redirects on success. |
| `cancelUrl` | string | yes | Absolute URL. Where provider redirects on cancel. |
| `description` | string | no | Shown to payer. Defaults to `'Payment'`. |
| `email` | string | no | Buyer email if provider needs it. |
| `metadata` | object | no | Arbitrary key/value — engine passes to provider, echoes back in webhook event. |

### Response — what the engine sends back

```js
{
  redirectUrl: 'https://checkout.stripe.com/c/pay/cs_test_abc123...',  // REQUIRED — send user here
  checkoutId: 'cs_test_abc123...',                                      // Provider's session ID
  providerReference: 'cs_test_abc123...',                               // Same as checkoutId (Stripe-specific)
  providerPaymentIntent: 'pi_3XXX...'                                   // Present when Stripe has created the intent
}
```

**Host must:**
1. Redirect the user's browser to `redirectUrl`
2. Store `checkoutId` / `providerReference` in its own payment record (for reconciliation)

**Engine internally:**
- Validates the instruction shape (throws before touching the provider)
- Calls `provider.createCheckout(payload)` — for Stripe, creates a Checkout Session
- Returns `{ redirectUrl, ... }`

**Throws on:** invalid instruction, provider API error, missing response fields.

---

## Webhook callback — what the engine delivers to your handler

When the provider fires a webhook (e.g. `checkout.session.completed`), the engine:

1. Receives the raw HTTP body at `POST /@semantq/pay/webhook/:gateway`
2. Verifies the provider's signature using the raw body
3. Normalizes the payload to a canonical event
4. Persists a ledger row (dedupe via unique `providerEventId`)
5. Updates the engine's payment record (`pay_payments`) with monotonic state transition
6. Invokes your `paymentEventHandler` with the canonical event

### The event your handler receives

```js
{
  paymentRecordId:       'reg-payment-uuid-here',   // Same value host sent at checkout
  status:                'SUCCEEDED',                // Canonical status (see enum below)
  amountMinor:           19900,                      // Authoritative amount from provider
  currency:              'zar',                      // Lowercase
  providerGateway:       'stripe',                   // 'stripe'
  providerReference:     'cs_test_abc123...',        // Provider's session reference
  providerPaymentIntent: 'pi_3XXX...',               // May be null
  providerCreatedAt:     Date,                       // Provider's event timestamp
  providerEventId:       'evt_1ABC...',              // Unique provider event ID
  eventType:             'checkout.session.completed', // Raw provider event type
  raw:                   { /* full provider payload */ },
  webhookEventId:        'uuid-of-ledger-row'        // Engine's internal ledger row ID
}
```

### Your handler's job

```js
async function paymentEventHandler(event) {
  // 1. Look up the host's payment record by paymentRecordId
  const hostRecord = await db.payment.findUnique({
    where: { id: event.paymentRecordId },
  });

  if (!hostRecord) {
    return { handled: false, reason: 'PAYMENT_NOT_FOUND' };
  }

  // 2. Idempotency: if already fulfilled, no-op
  if (hostRecord.status !== 'PENDING') {
    return { handled: false, reason: 'ALREADY_FINAL' };
  }

  // 3. Verify amount and currency match your expectations
  if (Math.abs(event.amountMinor / 100 - Number(hostRecord.amount)) > 0.01) {
    return { handled: false, reason: 'AMOUNT_MISMATCH' };
  }

  // 4. Update host state atomically
  await db.$transaction(async (tx) => {
    await tx.payment.update({
      where: { id: hostRecord.id },
      data: {
        status: event.status === 'SUCCEEDED' ? 'PAID' : 'FAILED',
        providerReference: event.providerReference,
      },
    });

    if (event.status === 'SUCCEEDED') {
      await tx.registration.update({
        where: { id: hostRecord.registrationId },
        data: { paymentStatus: 'PAID', accessCode: generateAccessCode() },
      });
    }
  });

  // 5. Fire notifications — fire-and-forget, never block
  sendConfirmationEmail(hostRecord.registrationId).catch(console.error);

  return { handled: true };
}
```

### Handler contract

| Rule | Why |
|---|---|
| **Return any object** — engine logs, doesn't inspect | Engine treats non-throw as success |
| **Throw only on transient failure** — DB down, provider outage | Engine marks ledger `FAILED` and returns 500 → provider retries |
| **Never throw on business rejection** — return `{ handled: false, reason: ... }` | Avoids infinite retries on permanent failures |
| **Idempotent** — check `paymentRecordId` state first | Same event may retry due to provider retry policy |
| **Verify amount and currency** | Prevent tampered webhooks |
| **Fire-and-forget side effects** | Email failure must not block payment completion |

---

## Canonical status enum

The engine normalizes all provider-specific statuses into this closed set:

| Status | Meaning | Typical provider event |
|---|---|---|
| `PENDING` | Initiated, awaiting provider confirmation | — |
| `PROCESSING` | Provider received but not yet settled | `checkout.session.completed` (unpaid) |
| `SUCCEEDED` | Payment captured | `checkout.session.completed` (paid), `payment_intent.succeeded` |
| `FAILED` | Payment declined / failed | `checkout.session.async_payment_failed`, `payment_intent.payment_failed` |
| `CANCELLED` | User cancelled | — |
| `EXPIRED` | Checkout session timed out | `checkout.session.expired` |
| `REFUNDED` | Full refund | `charge.refunded` (full) |
| `PARTIALLY_REFUNDED` | Partial refund | `charge.refunded` (partial) |

**Monotonic transitions only.** The engine refuses backward transitions (e.g. `SUCCEEDED → PENDING`). See `services/WebhookService.js` for the full transition table.

---

## Host setup — required

### 1. Preserve raw webhook body

The engine needs the **original raw bytes** to verify provider signatures. Most body parsers consume the stream. Use the `verify` hook:

```js
import bodyParser from 'body-parser';

app.use(bodyParser.json({
  limit: '10mb',
  verify: (req, res, buf) => {
    if (req.originalUrl?.startsWith('/@semantq/pay/webhook/')) {
      req.rawBody = Buffer.from(buf);
    }
  },
}));
```

**Without this, every webhook returns `400 NO_RAW_BODY`.**

### 2. Mount the webhook route

```js
import payRoutes from '@semantq/pay/routes/webhooks.js';

app.use('/@semantq/pay', payRoutes);
```

Result: `POST /@semantq/pay/webhook/stripe` accepts Stripe events.

### 3. Register the endpoint with the provider

**Test mode (local dev):**
```bash
stripe listen --forward-to localhost:3003/@semantq/pay/webhook/stripe
```
Copy the printed `whsec_...` → `STRIPE_WEBHOOK_SECRET`.

**Production:**
- Stripe Dashboard → Developers → Webhooks → Add endpoint
- URL: `https://yourdomain.com/@semantq/pay/webhook/stripe`
- Events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `payment_intent.succeeded`, `payment_intent.payment_failed`
- Copy the signing secret → `STRIPE_WEBHOOK_SECRET`

### 4. Set environment variables

```bash
STRIPE_SECRET_KEY=sk_test_...        # or sk_live_... in production
STRIPE_WEBHOOK_SECRET=whsec_...      # from step 3
```

---

## Public API reference

### `pay.init(config, options)`

| Param | Type | Notes |
|---|---|---|
| `config.payments.defaultProvider` | string | Default provider name (e.g. `'stripe'`) |
| `config.payments.providers` | object | Per-provider config (see Boot section) |
| `options.paymentEventHandler` | async function | Webhook callback |

Returns: `Promise<Pay>` (the singleton itself). Idempotent — second call is a no-op.

### `pay.getPaymentGateway(name?)`

Returns the `CheckoutService` for a provider. `name` defaults to the default provider.

Throws if not initialized or if provider not registered.

### `pay.getPaymentProvider(name)`

Returns the raw provider adapter (advanced use — usually not needed). Provides access to `createCheckout()`, `verifyWebhook()`, `normalizeEvent()` directly.

### `pay.getPaymentEventHandler()`

Returns the function registered at `init()`, or `null`.

### `pay.isReady()`

Returns `true` if `init()` has completed successfully.

---

## What this module owns

### Tables

| Table | Purpose |
|---|---|
| `pay_payments` | One row per `paymentRecordId` — lifecycle state, provider references |
| `pay_webhook_events` | Dedupe ledger — one row per `providerEventId`, unique constraint prevents replays |

**No foreign keys cross between engine and host.** The host references the engine only via the opaque `paymentRecordId` string it supplies.

### When the host needs engine data

The host can query the engine's tables directly (same DB) — the model names are stable. **Prefer keeping a reference column on the host side** (e.g. `hostPayment.providerReference`) so queries stay within the host's domain.

---

## What this module does NOT do

- Track users, customers, or accounts
- Manage orders, invoices, receipts, refund workflows
- Handle subscriptions, recurring charges, proration, dunning
- Emit emails, send SMS, notify anyone (host's job)
- Sum, aggregate, or reconcile amounts across payments (host's job)
- Decide when to fulfil — host decides, engine just delivers events

**The engine is stateless from the host's perspective.** Host owns domain logic. Engine bridges to provider.

---

## Provider support

| Provider | Status | Notes |
|---|---|---|
| **Stripe** | Active | Full: checkout, webhook, signature verification, refunds |
| Yoco | Stub | Adapter skeleton exists; not wired into config flow |
| Paystack | Stub | Same |
| PayPal | Stub | Same |

Enabling a stub provider in `config.providers` triggers a warning — engine ignores it until implemented.

### Adding a new provider

Implement three methods on a provider class extending `BaseProvider`:

```js
class MyProvider extends BaseProvider {
  constructor(config) { /* ... */ }
  get name() { return 'myprovider'; }

  async createCheckout(payload) {
    // payload: { paymentRecordId, amountMinor, currency, description, email, successUrl, cancelUrl, metadata }
    // returns: { redirectUrl, checkoutId, providerReference, providerPaymentIntent? }
  }

  verifyWebhook(rawBody, headers) {
    // return parsed+verified raw event, or throw INVALID_SIGNATURE
  }

  normalizeEvent(rawEvent) {
    // return canonical event shape (see "Webhook callback" section)
    // throw UNSUPPORTED_EVENT for event types you don't handle
  }
}
```

Register it in `index.js` `init()` alongside the Stripe block.

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `STRIPE_SECRET_KEY` | yes if Stripe enabled | `sk_test_...` or `sk_live_...` |
| `STRIPE_WEBHOOK_SECRET` | yes if Stripe enabled | `whsec_...` — must match the endpoint secret |

**Engine never reads env directly** — all config comes through `init()`.

---

## Minimal working example

A complete host integration in ~60 lines:

```js
import express from 'express';
import bodyParser from 'body-parser';
import pay from '@semantq/pay';
import payRoutes from '@semantq/pay/routes/webhooks.js';
import { PrismaClient } from '@prisma/client';

const app = express();
const prisma = new PrismaClient();

// Body parser with raw body preservation
app.use(bodyParser.json({
  verify: (req, res, buf) => {
    if (req.originalUrl?.startsWith('/@semantq/pay/webhook/')) {
      req.rawBody = Buffer.from(buf);
    }
  },
}));

// Boot the engine
await pay.init(
  {
    payments: {
      defaultProvider: 'stripe',
      providers: {
        stripe: {
          enabled: true,
          config: {
            secretKey: process.env.STRIPE_SECRET_KEY,
            webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
          },
        },
      },
    },
  },
  {
    paymentEventHandler: async (event) => {
      const payment = await prisma.payment.findUnique({
        where: { id: event.paymentRecordId },
      });
      if (!payment || payment.status !== 'PENDING') {
        return { handled: false, reason: 'NOT_PENDING' };
      }

      await prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: event.status === 'SUCCEEDED' ? 'PAID' : 'FAILED',
          providerRef: event.providerReference,
        },
      });

      return { handled: true };
    },
  }
);

// Mount webhook route
app.use('/@semantq/pay', payRoutes);

// Your checkout endpoint
app.post('/api/checkout', async (req, res) => {
  // 1. Create your application-level payment record
  const payment = await prisma.payment.create({
    data: { userId: req.body.userId, amount: 199.00, status: 'PENDING' },
  });

  // 2. Ask the engine to create a provider session
  const gateway = pay.getPaymentGateway('stripe');
  const session = await gateway.initiateCheckout({
    paymentRecordId: payment.id,
    amountMinor: 19900,
    currency: 'zar',
    successUrl: 'https://myapp.com/success',
    cancelUrl: 'https://myapp.com/cancel',
    email: req.body.email,
  });

  // 3. Return the redirect URL to the browser
  res.json({ redirectUrl: session.redirectUrl });
});

app.listen(3003);
```

---

## Known limitations

- **No refund API yet** — refund flows are handled by the host manually for now
- **No subscription / recurring support** — one-time charges only
- **No multi-currency per provider** — each provider has one currency at the session level
- **Dormant providers** — Yoco, Paystack, PayPal adapters are skeleton-only

---

## Version

Current: **1.0.0**

**API stability:** the contract in "Initiate a checkout" and "Webhook callback" is stable. Internal services (`CheckoutService`, `WebhookService`, `BaseProvider`) may evolve. Direct host calls to those are not recommended.

---

## License

ISC
