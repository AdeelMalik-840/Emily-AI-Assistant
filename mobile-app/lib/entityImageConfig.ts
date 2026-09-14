/**
 * Generic per-entity image limits (catalog items / products / vehicles, etc.).
 * Tune without changing UI code per business category.
 */
export const ENTITY_IMAGE_LIMITS = {
  /**
   * Photos are optional -- 0 means no minimum-photo validation blocks save.
   * Emily can still share whatever photos an owner chooses to add later.
   */
  minPerItem: 0,
  maxPerItem: 5,
} as const;

export type EntityImageLimitsForm = {
  items: Array<{ name: string; images?: string[] }>;
};

/**
 * Validates image counts for every item that has a name (saved rows only).
 * Photos are optional (ENTITY_IMAGE_LIMITS.minPerItem is 0) -- this only
 * ever rejects too MANY photos, never a missing minimum.
 * @returns Error message or null if OK.
 */
export function validateEntityImagesForSave(
  form: EntityImageLimitsForm
): string | null {
  const { maxPerItem } = ENTITY_IMAGE_LIMITS;
  for (const it of form.items) {
    const name = it.name.trim();
    if (!name) continue;
    const imgs = it.images ?? [];
    if (imgs.length > maxPerItem) {
      return `“${name}” has too many photos (maximum ${maxPerItem}). Remove some to continue.`;
    }
  }
  return null;
}
