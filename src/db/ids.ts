/** A stable, time-ordered row id (UUIDv7). Use for every table's `id`. */
export function newId(): string {
  return Bun.randomUUIDv7();
}
