/** Shared provider types used by MCP tools (create-product, list-products). */

export interface AppleListOpts {
  keyId: string;
  issuerId: string;
  privateKey: string;
  appId: string;
}

export interface AppleProduct {
  productId: string;
  name?: string;
  status?: string;
  type?: string;
  price?: number;
  currency?: string;
}

export interface GoogleListOpts {
  packageName: string;
  serviceAccountKey: string;
}

export interface GoogleProduct {
  productId: string;
  name?: string;
  status?: string;
  type?: string;
  price?: number;
  currency?: string;
}
