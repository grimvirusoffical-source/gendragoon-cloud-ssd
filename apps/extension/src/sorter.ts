import { categorize, type SortCategory } from "../../../packages/core/src/sorting";

/** Which type folder GenDragoon files a name under. Same canonical sort-map as every other app. */
export function sortCategoryFor(name: string): SortCategory | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  return categorize({ name: trimmed });
}
