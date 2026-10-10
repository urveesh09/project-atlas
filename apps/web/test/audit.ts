import { AxeBuilder } from '@axe-core/playwright';
import type { Page } from 'playwright';
export async function audit(page: Page) {
  return (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()).violations;
}
