export interface Migration {
  /** 1, 2, 3, ... with no gaps. */
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}
