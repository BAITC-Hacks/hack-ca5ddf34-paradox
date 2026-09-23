import type { GetPurchaseTermsInput, PurchaseTerm } from "../agent/schemas.js";

export interface PurchaseTermsReader {
  find(input: GetPurchaseTermsInput): Promise<PurchaseTerm[]>;
}

/**
 * No merchant policy is bundled without a checked source. Supply verified entries
 * during integration; an empty result tells the assistant to ask for confirmation.
 */
export function createPurchaseTermsReader(entries: readonly PurchaseTerm[] = []): PurchaseTermsReader {
  for (const entry of entries) {
    const url = new URL(entry.source.url);
    if (!["http:", "https:"].includes(url.protocol) || !entry.statement.trim()) {
      throw new Error("A purchase term needs text and an HTTP(S) source URL");
    }
  }

  return {
    async find({ topic, city }) {
      return entries.filter(
        (entry) =>
          entry.topic === topic &&
          (!entry.city || (city !== null && entry.city.toLocaleLowerCase() === city.toLocaleLowerCase())),
      );
    },
  };
}
