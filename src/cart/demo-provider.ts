import { randomUUID } from 'node:crypto';
import {
  CartError,
  type CartItem,
  type CartProduct,
  type CartProvider,
  type CartSnapshot,
  type ConfirmedCartChange,
  type PreparedCartChange,
  type ProductResolver,
} from './provider.js';
import {
  requireConfirmation,
  requireNonEmpty,
  requireQuantity,
  requireStock,
  requireValidProduct,
} from './confirmation.js';

interface Proposal {
  product: CartProduct;
  quantityToAdd: number;
  confirmed: boolean;
}

interface SessionCart {
  items: Map<string, CartItem>;
  proposals: Map<string, Proposal>;
}

export interface DemoCartOptions {
  resolveProduct: ProductResolver;
  /** Absolute origin of the demo app, e.g. https://demo.example. */
  baseUrl: string;
  /** Same-origin path; the app must resolve the cart from its session cookie. */
  cartPath?: string;
}

/** Process-local demo implementation. State is lost on restart or on another server instance. */
export class DemoCartProvider implements CartProvider {
  private readonly options: DemoCartOptions;
  private readonly sessions = new Map<string, SessionCart>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly cartUrl: string;

  constructor(options: DemoCartOptions) {
    this.options = options;
    if (typeof options.resolveProduct !== 'function') {
      throw new CartError('INVALID_INPUT', 'resolveProduct must be a function');
    }
    let base: URL;
    try {
      base = new URL(options.baseUrl);
    } catch {
      throw new CartError('INVALID_INPUT', 'baseUrl must be an absolute URL');
    }
    if (!['http:', 'https:'].includes(base.protocol) || !base.host) {
      throw new CartError('INVALID_INPUT', 'baseUrl must be an HTTP(S) URL');
    }
    const path = options.cartPath ?? '/cart';
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('?') || path.includes('#')) {
      throw new CartError('INVALID_INPUT', 'cartPath must be an absolute same-origin path');
    }
    const cartUrl = new URL(path, base);
    if (cartUrl.origin !== base.origin) {
      throw new CartError('INVALID_INPUT', 'cartPath must stay on the demo app origin');
    }
    this.cartUrl = cartUrl.toString();
  }

  async prepare(input: {
    sessionId: string;
    productId: string;
    quantity: number;
  }): Promise<PreparedCartChange> {
    requireNonEmpty(input.sessionId, 'sessionId');
    requireNonEmpty(input.productId, 'productId');
    requireQuantity(input.quantity);

    const product = await this.loadProduct(input.productId);
    const existing = this.sessions.get(input.sessionId)?.items.get(input.productId)?.quantity ?? 0;
    requireStock(product.availableQuantity, existing, input.quantity);
    const lineTotalMinor = product.unitPriceMinor * input.quantity;
    if (!Number.isSafeInteger(lineTotalMinor)) {
      throw new CartError('INVALID_INPUT', 'line total exceeds safe integer range');
    }

    const proposalId = randomUUID();
    this.session(input.sessionId).proposals.set(proposalId, {
      product: { ...product },
      quantityToAdd: input.quantity,
      confirmed: false,
    });
    return {
      proposalId,
      product: { ...product },
      quantityToAdd: input.quantity,
      resultingQuantity: existing + input.quantity,
      lineTotalMinor,
    };
  }

  async confirm(input: {
    sessionId: string;
    proposalId: string;
    confirmed: true;
  }): Promise<ConfirmedCartChange> {
    requireNonEmpty(input.sessionId, 'sessionId');
    requireNonEmpty(input.proposalId, 'proposalId');
    requireConfirmation(input.confirmed);

    return this.withSessionLock(input.sessionId, async () => {
      const session = this.sessions.get(input.sessionId);
      const proposal = session?.proposals.get(input.proposalId);
      if (!session || !proposal) {
        throw new CartError('PROPOSAL_NOT_FOUND', 'Proposal not found in this session');
      }
      if (proposal.confirmed) {
        return { proposalId: input.proposalId, alreadyConfirmed: true, cart: this.snapshot(session) };
      }

      const current = await this.loadProduct(proposal.product.productId);
      if (current.unitPriceMinor !== proposal.product.unitPriceMinor) {
        throw new CartError('PRICE_CHANGED', 'Price changed; prepare a new confirmation');
      }
      const existing = session.items.get(current.productId)?.quantity ?? 0;
      requireStock(current.availableQuantity, existing, proposal.quantityToAdd);
      const resultingQuantity = existing + proposal.quantityToAdd;
      if (!Number.isSafeInteger(resultingQuantity)) {
        throw new CartError('INVALID_INPUT', 'quantity exceeds safe integer range');
      }

      const updatedItem: CartItem = {
        productId: current.productId,
        name: current.name,
        unitPriceMinor: current.unitPriceMinor,
        quantity: resultingQuantity,
      };
      const candidateItems = new Map(session.items);
      candidateItems.set(current.productId, updatedItem);
      this.snapshot({ ...session, items: candidateItems });
      session.items.set(current.productId, updatedItem);
      proposal.confirmed = true;
      return { proposalId: input.proposalId, alreadyConfirmed: false, cart: this.snapshot(session) };
    });
  }

  async getCart(sessionId: string): Promise<CartSnapshot> {
    requireNonEmpty(sessionId, 'sessionId');
    return this.snapshot(this.sessions.get(sessionId));
  }

  private async loadProduct(productId: string): Promise<CartProduct> {
    const product = await this.options.resolveProduct(productId);
    if (!product) {
      throw new CartError('PRODUCT_NOT_FOUND', 'Product not found');
    }
    requireValidProduct(product, productId);
    return product;
  }

  private session(sessionId: string): SessionCart {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = { items: new Map(), proposals: new Map() };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  private snapshot(session?: SessionCart): CartSnapshot {
    const items = [...(session?.items.values() ?? [])].map(item => ({ ...item }));
    const totalMinor = items.reduce((sum, item) => sum + item.unitPriceMinor * item.quantity, 0);
    if (!Number.isSafeInteger(totalMinor)) {
      throw new CartError('INVALID_INPUT', 'cart total exceeds safe integer range');
    }
    return { items, totalMinor, cartUrl: this.cartUrl };
  }

  private async withSessionLock<T>(sessionId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    this.locks.set(sessionId, current);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.locks.get(sessionId) === current) this.locks.delete(sessionId);
    }
  }
}
