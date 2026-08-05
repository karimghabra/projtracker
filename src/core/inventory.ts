/**
 * Quantities, and how they read.
 *
 * A type says how it is counted: acidified collagen in mL, thread in metres,
 * closed loops as a plain number of things. The unit belongs to the substance
 * rather than to a particular jar of it — two lots of the same type in different
 * units could not be added together, and the alternative to that rule is a
 * dimensional-algebra feature nobody asked for.
 *
 * Pure, like everything here: no I/O, no clock.
 */

import type { ScaffoldType } from './model.ts';

/**
 * Six decimal places.
 *
 * Quantities get subtracted from each other, and binary floating point turns
 * 0.1 + 0.2 into 0.30000000000000004. Round-tripping such a number is exact, so
 * canonical serialization survives either way — but the vault is meant to be
 * read by a person, and a file full of noise is a file nobody trusts. Applied
 * in the command layer when a quantity is written, never in the serializer,
 * which must write what is in memory and nothing else.
 */
export function roundQuantity(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** True when this type is measured rather than counted. */
export function isMeasured(type: Pick<ScaffoldType, 'unit'> | undefined): boolean {
  return Boolean(type?.unit);
}

/**
 * Whether a quantity is sayable for this type.
 *
 * Half a millilitre is ordinary; half a scaffold is not. So fractions are
 * allowed exactly when the type carries a unit, and the message for the
 * countable case is the one that was always there.
 */
export function quantityProblem(
  quantity: number,
  type: Pick<ScaffoldType, 'unit'> | undefined,
): string | null {
  if (!isMeasured(type)) {
    if (!Number.isInteger(quantity) || quantity < 1) {
      return 'How many did you make? Enter a whole number of 1 or more.';
    }
    return null;
  }
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return 'How much did you make? Enter an amount greater than zero.';
  }
  return null;
}

/** '40 mL', or just '12' for something counted — the noun belongs to the row. */
export function formatQuantity(quantity: number, unit?: string): string {
  return unit ? `${quantity} ${unit}` : String(quantity);
}

/** '40 mL of Acidified collagen', for a row that has room for the name. */
export function describeQuantity(quantity: number, typeName: string, unit?: string): string {
  return unit ? `${quantity} ${unit} ${typeName}` : `${quantity} × ${typeName}`;
}

/**
 * A selection of lots in one line.
 *
 * Totals are grouped by unit, because adding millilitres to metres is not a
 * smaller number, it is a wrong one. A mixture of more than two units stops
 * pretending and counts the lots instead.
 */
export function summariseLots(
  lots: { quantity: number; unit?: string }[],
): string {
  if (lots.length === 0) return 'nothing selected';

  const byUnit = new Map<string, number>();
  for (const lot of lots) {
    const key = lot.unit ?? '';
    byUnit.set(key, (byUnit.get(key) ?? 0) + lot.quantity);
  }
  if (byUnit.size > 2) return `${lots.length} lots`;

  return [...byUnit.entries()]
    .map(([unit, total]) =>
      // Unitless needs a noun here, where there is no column heading to supply
      // one: "36" alone beside a batch count reads as a second count.
      unit ? formatQuantity(roundQuantity(total), unit) : `${roundQuantity(total)} items`,
    )
    .join(', ');
}
