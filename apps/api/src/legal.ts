import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ConfigError, type Env } from '@atlas/control';
import { LEGAL_DOCUMENTS, LegalNoticesSchema, type LegalDocument, type LegalNotices } from '@atlas/schema';

/** The shipped example texts carry this; a production service refuses them (ADR-077). */
export const LEGAL_PLACEHOLDER_MARKER = 'ATLAS-PLACEHOLDER';
export const LEGAL_TEXT_LIMIT = 65_536;

const FILE_VARIABLES: Readonly<Record<LegalDocument, string>> = {
  privacy: 'ATLAS_PRIVACY_FILE',
  terms: 'ATLAS_TERMS_FILE',
  takedown: 'ATLAS_TAKEDOWN_FILE',
};

/** A development service shows clearly marked placeholders instead. */
export const UNCONFIGURED_LEGAL_NOTICES: LegalNotices = Object.freeze({
  configured: false,
  contact: null,
  documents: Object.freeze({ privacy: null, terms: null, takedown: null }),
});

/**
 * The operator's privacy, terms and takedown texts (plain UTF-8 files) and contact
 * (M4.6). The texts are the owner's; ATLAS never supplies legal wording. Outside
 * development every item is required and the service refuses to start without it.
 * Errors name the variable, never the file's contents.
 */
export function legalNoticesFromEnv(env: Env, development: boolean): LegalNotices {
  const documents = Object.fromEntries(LEGAL_DOCUMENTS.map((name) => [name, legalText(env, FILE_VARIABLES[name], development)])) as Record<LegalDocument, string | null>;
  const contact = contactFrom(env, development);
  const configured = contact !== null && LEGAL_DOCUMENTS.every((name) => documents[name] !== null);
  return LegalNoticesSchema.parse({ configured, contact, documents });
}

function legalText(env: Env, variable: string, development: boolean): string | null {
  const file = env[variable];
  if (!file) {
    if (development) return null;
    throw new ConfigError(`${variable} is required outside development: the owner's text for this public page`);
  }
  if (!path.isAbsolute(file)) throw new ConfigError(`${variable} must be an absolute path`);
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch {
    throw new ConfigError(`${variable} could not be read`);
  }
  if (bytes.length > LEGAL_TEXT_LIMIT) throw new ConfigError(`${variable} exceeds ${LEGAL_TEXT_LIMIT} bytes`);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ConfigError(`${variable} is not UTF-8 text`);
  }
  text = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim();
  if (!text) throw new ConfigError(`${variable} is empty`);
  // Shown as text, never markup; control characters other than tab and newline are refused.
  if (/[\u0000-\u0008\u000B-\u001F\u007F]/.test(text)) throw new ConfigError(`${variable} contains control characters`);
  if (!development && text.includes(LEGAL_PLACEHOLDER_MARKER)) throw new ConfigError(`${variable} still holds the shipped placeholder; supply the owner's text`);
  return text;
}

function contactFrom(env: Env, development: boolean): string | null {
  const value = env['ATLAS_CONTACT']?.trim();
  if (!value) {
    if (development) return null;
    throw new ConfigError('ATLAS_CONTACT is required outside development: a mailto: address or an https: page');
  }
  if (/^mailto:[^\s@?#/:]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(value) && value.length <= 512) return value;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password && url.href === value && value.length <= 512) return value;
  } catch {
    // reported below
  }
  throw new ConfigError('ATLAS_CONTACT must be a mailto: address or an https: URL');
}
