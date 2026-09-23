/** Amounts are integer minor currency units (tiyn for KZT). */
export interface CartProduct {
  productId: string;
  name: string;
  /** City whose customer-accessible stock was resolved. */
  city: string;
  unitPriceMinor: number;
  /** Customer-accessible quantity in city, not the total across warehouses. */
  availableQuantity: number;
}

export type ProductResolver = (input: { productId: string; city: string }) => Promise<CartProduct | null>;

export interface CartItem {
  productId: string;
  name: string;
  city: string;
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
  city: string;
  product: CartProduct;
  quantityToAdd: number;
  resultingQuantity: number;
  lineTotalMinor: number;
  expiresAt: string;
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
    city: string;
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
  | 'PROPOSAL_EXPIRED'
  | 'PRICE_CHANGED';

export class CartError extends Error {
  readonly code: CartErrorCode;

  constructor(code: CartErrorCode, message: string) {
    super(message);
    this.name = 'CartError';
    this.code = code;
  }
}
