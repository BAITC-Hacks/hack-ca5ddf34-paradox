import { CartError, type CartProduct } from './provider.js';

export function requireNonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new CartError('INVALID_INPUT', `${field} must be a non-empty string`);
  }
}

export function requireQuantity(quantity: unknown): asserts quantity is number {
  if (typeof quantity !== 'number' || !Number.isSafeInteger(quantity) || quantity <= 0) {
    throw new CartError('INVALID_INPUT', 'quantity must be a positive safe integer');
  }
}

export function requireConfirmation(confirmed: unknown): asserts confirmed is true {
  if (confirmed !== true) {
    throw new CartError('CONFIRMATION_REQUIRED', 'Explicit confirmation is required');
  }
}

export function requireValidProduct(product: CartProduct, requestedId: string): void {
  if (
    product.productId !== requestedId ||
    typeof product.name !== 'string' ||
    product.name.trim() === '' ||
    !Number.isSafeInteger(product.unitPriceMinor) ||
    product.unitPriceMinor < 0 ||
    !Number.isSafeInteger(product.availableQuantity) ||
    product.availableQuantity < 0
  ) {
    throw new CartError('INVALID_INPUT', 'Product resolver returned invalid data');
  }
}

export function requireStock(available: number, alreadyInCart: number, toAdd: number): void {
  if (alreadyInCart + toAdd > available) {
    throw new CartError('INSUFFICIENT_STOCK', 'Requested quantity exceeds available stock');
  }
}
