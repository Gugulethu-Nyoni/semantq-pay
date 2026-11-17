// packages/@semantq/pay/index.js
//
// @semantq/pay — plug-and-play payment engine.
// Stripe-first. Config injected at init(). No shipping, no logistics.

import { StripeProvider } from './providers/gateways/stripe.js';
import { CheckoutService } from './services/CheckoutService.js';

class Pay {
  constructor() {
    this.config = null;
    this.paymentGateways = new Map();
    this.paymentProviders = new Map();
    this.defaultGateway = null;
    this.paymentEventHandler = null;
    this._initialized = false;
  }

  async init(config, options = {}) {
    if (this._initialized) return this;

    console.log('[Pay] Initializing...');

    if (!config || typeof config !== 'object') {
      throw new Error('[Pay] init(config) requires a config object');
    }

    const payments = config.payments;
    if (!payments || typeof payments !== 'object') {
      throw new Error('[Pay] config.payments is required');
    }

    this.config = payments;
    this.paymentEventHandler = options.paymentEventHandler || null;

    const providers = payments.providers || {};

    if (providers.stripe?.enabled === true) {
      const cfg = providers.stripe.config || {};
      if (!cfg.secretKey) {
        throw new Error('[Pay] Stripe enabled but config.secretKey is missing');
      }
      if (!cfg.webhookSecret) {
        throw new Error('[Pay] Stripe enabled but config.webhookSecret is missing');
      }

      const stripeProvider = new StripeProvider(cfg);
      const stripeCheckout = new CheckoutService(stripeProvider);

      this.paymentGateways.set('stripe', stripeCheckout);
      this.paymentProviders.set('stripe', stripeProvider);

      console.log('[Pay] Stripe gateway registered.');
    }

    for (const name of ['yoco', 'paystack', 'paypal']) {
      if (providers[name]?.enabled === true) {
        console.warn(`[Pay] Provider '${name}' enabled in config but not implemented. Ignoring.`);
      }
    }

    const defaultName = String(
      payments.defaultProvider || 'stripe'
    ).toLowerCase();

    if (!this.paymentGateways.has(defaultName)) {
      throw new Error(
        `[Pay] defaultProvider '${defaultName}' is not registered. ` +
        `Registered: ${Array.from(this.paymentGateways.keys()).join(', ') || 'none'}`
      );
    }

    this.defaultGateway = defaultName;

    if (this.paymentGateways.size === 0) {
      throw new Error('[Pay] No payment gateways registered.');
    }

    this._initialized = true;

    console.log(
      `[Pay] Ready. Default: ${this.defaultGateway}. ` +
      `Available: ${Array.from(this.paymentGateways.keys()).join(', ')}. ` +
      `Event handler: ${this.paymentEventHandler ? 'registered' : 'not registered'}.`
    );

    return this;
  }

  getPaymentGateway(gatewayName = null) {
    if (!this._initialized) {
      throw new Error('[Pay] Not initialized. Call await pay.init(config) first.');
    }

    const key = String(gatewayName || this.defaultGateway).toLowerCase();
    const gateway = this.paymentGateways.get(key);

    if (!gateway) {
      throw new Error(
        `[Pay] Gateway '${key}' is not registered. ` +
        `Available: ${Array.from(this.paymentGateways.keys()).join(', ')}`
      );
    }

    return gateway;
  }

  getPaymentProvider(gatewayName) {
    if (!this._initialized) {
      throw new Error('[Pay] Not initialized. Call await pay.init(config) first.');
    }

    const key = String(gatewayName).toLowerCase();
    const provider = this.paymentProviders.get(key);

    if (!provider) {
      throw new Error(
        `[Pay] Provider '${key}' is not registered. ` +
        `Available: ${Array.from(this.paymentProviders.keys()).join(', ')}`
      );
    }

    return provider;
  }

  getPaymentEventHandler() {
    return this.paymentEventHandler;
  }

  isReady() {
    return this._initialized;
  }
}

const pay = new Pay();

export { Pay };
export default pay;
