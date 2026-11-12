/** Escape input that could introduce Markdown structure, HTML or automatic links. */
export const escapeMarkdownText = (text: string) =>
  [...text].map((char) => /[A-Za-z0-9 /-]/.test(char) ? char : `&#${char.codePointAt(0)};`).join('');
