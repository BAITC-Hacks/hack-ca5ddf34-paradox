/** Amounts are integer minor currency units (tiyn for KZT). */
export interface CartProduct {
  productId: string;
  name: string;
  unitPriceMinor: number;
  availableQuantity: number;
}

export type ProductResolver = (productId: string) => Promise<CartProduct | null>;

export interface CartItem {
  productId: string;
  name: string;
  quantity: number;
  unitPriceMinor: number;
}

export interface CartSnapshot {
  items: CartItem[];
  totalMinor: number;
  /** The caller's session cookie, never a session ID in this URL, identifies the cart. */
  cartUrl: string;
}

export interface PreparedCartChange {
  proposalId: string;
  product: CartProduct;
  quantityToAdd: number;
  resultingQuantity: number;
  lineTotalMinor: number;
}

export interface ConfirmedCartChange {
  proposalId: string;
  alreadyConfirmed: boolean;
  cart: CartSnapshot;
}

export interface CartProvider {
  prepare(input: {
    sessionId: string;
    productId: string;
    quantity: number;
  }): Promise<PreparedCartChange>;

  confirm(input: {
    sessionId: string;
    proposalId: string;
    confirmed: true;
  }): Promise<ConfirmedCartChange>;

  getCart(sessionId: string): Promise<CartSnapshot>;
}

export type CartErrorCode =
  | 'INVALID_INPUT'
  | 'PRODUCT_NOT_FOUND'
  | 'INSUFFICIENT_STOCK'
  | 'CONFIRMATION_REQUIRED'
  | 'PROPOSAL_NOT_FOUND'
  | 'PRICE_CHANGED';

export class CartError extends Error {
  readonly code: CartErrorCode;

  constructor(code: CartErrorCode, message: string) {
    super(message);
    this.name = 'CartError';
    this.code = code;
  }
}
