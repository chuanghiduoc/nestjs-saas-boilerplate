export type CatalogueRow = {
  key: string;
  resource: string;
  action: string;
  ownerOnly: boolean;
  apiKeyEligible: boolean;
  supportEligible: boolean;
  deprecated: boolean;
  /** Key quyền yêu cầu trực tiếp, đã sắp xếp. */
  requires: string[];
};
export abstract class CatalogueReader {
  abstract readAll(): Promise<CatalogueRow[]>;
}
