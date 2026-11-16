// packages/@semantq/blinque/index.js
//
// @semantq/blinque — plug-and-play payment engine.
// Stripe-first. Shipping deferred.
// No monorepo-relative imports. Config is injected at init().

import { StripeProvider } from './providers/gateways/stripe.js';
import { CheckoutService } from './services/CheckoutService.js';

class Blinque {
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

    console.log('[Blinque] Initializing...');

    if (!config || typeof config !== 'object') {
      throw new Error('[Blinque] init(config) requires a config object');
    }

    const logistics = config.logistics;
    if (!logistics || typeof logistics !== 'object') {
      throw new Error('[Blinque] config.logistics is required');
    }

    this.config = logistics;
    this.paymentEventHandler = options.paymentEventHandler || null;

    if (logistics.shipping?.enabled === true) {
      console.warn('[Blinque] Shipping enabled in config but provider not registered. Deferred.');
    }

    const providers = logistics.gateways?.providers || {};

    if (providers.stripe?.enabled === true) {
      const cfg = providers.stripe.config || {};
      if (!cfg.secretKey) {
        throw new Error('[Blinque] Stripe enabled but config.secretKey is missing');
      }
      if (!cfg.webhookSecret) {
        throw new Error('[Blinque] Stripe enabled but config.webhookSecret is missing');
      }

      const stripeProvider = new StripeProvider(cfg);
      const stripeCheckout = new CheckoutService(stripeProvider);

      this.paymentGateways.set('stripe', stripeCheckout);
      this.paymentProviders.set('stripe', stripeProvider);

      console.log('[Blinque] Stripe gateway registered.');
    }

    for (const name of ['yoco', 'paystack', 'paypal']) {
      if (providers[name]?.enabled === true) {
        console.warn(`[Blinque] Provider '${name}' enabled in config but not implemented. Ignoring.`);
      }
    }

    const defaultName = String(
      logistics.gateways?.defaultProvider || 'stripe'
    ).toLowerCase();

    if (!this.paymentGateways.has(defaultName)) {
      throw new Error(
        `[Blinque] defaultProvider '${defaultName}' is not registered. ` +
        `Registered: ${Array.from(this.paymentGateways.keys()).join(', ') || 'none'}`
      );
    }

    this.defaultGateway = defaultName;

    if (this.paymentGateways.size === 0) {
      throw new Error('[Blinque] No payment gateways registered.');
    }

    this._initialized = true;

    console.log(
      `[Blinque] Ready. Default: ${this.defaultGateway}. ` +
      `Available: ${Array.from(this.paymentGateways.keys()).join(', ')}. ` +
      `Event handler: ${this.paymentEventHandler ? 'registered' : 'not registered'}.`
    );

    return this;
  }

  getPaymentGateway(gatewayName = null) {
    if (!this._initialized) {
      throw new Error('[Blinque] Not initialized. Call await blinque.init(config) first.');
    }

    const key = String(gatewayName || this.defaultGateway).toLowerCase();
    const gateway = this.paymentGateways.get(key);

    if (!gateway) {
      throw new Error(
        `[Blinque] Gateway '${key}' is not registered. ` +
        `Available: ${Array.from(this.paymentGateways.keys()).join(', ')}`
      );
    }

    return gateway;
  }

  getPaymentProvider(gatewayName) {
    if (!this._initialized) {
      throw new Error('[Blinque] Not initialized. Call await blinque.init(config) first.');
    }

    const key = String(gatewayName).toLowerCase();
    const provider = this.paymentProviders.get(key);

    if (!provider) {
      throw new Error(
        `[Blinque] Provider '${key}' is not registered. ` +
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

const blinque = new Blinque();

export { Blinque };
export default blinque;
