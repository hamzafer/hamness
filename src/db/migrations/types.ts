export interface Migration {
  /** Ascending; gaps are allowed (each ticket claims its number). */
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}
