import ts from 'typescript';

/**
 * Every use of TypeScript API surface that is not in the public typings lives here so it
 * can be audited when the pinned compiler changes (ADR-013). Each accessor fails loudly
 * if the pinned version stops providing the function.
 */
export interface FileSystemEntries {
  readonly files: readonly string[];
  readonly directories: readonly string[];
}

interface TsInternals {
  getEmitModuleResolutionKind(options: ts.CompilerOptions): ts.ModuleResolutionKind;
  matchFiles(
    path: string,
    extensions: readonly string[] | undefined,
    excludes: readonly string[] | undefined,
    includes: readonly string[] | undefined,
    useCaseSensitiveFileNames: boolean,
    currentDirectory: string,
    depth: number | undefined,
    getFileSystemEntries: (path: string) => FileSystemEntries,
    realpath: (path: string) => string,
  ): string[];
}

const internals = ts as unknown as Partial<TsInternals>;

function required<K extends keyof TsInternals>(name: K): TsInternals[K] {
  const fn = internals[name];
  if (typeof fn !== 'function') throw new Error(`Pinned TypeScript ${ts.version} no longer provides ${name}`);
  return fn as TsInternals[K];
}

export const getEmitModuleResolutionKind = required('getEmitModuleResolutionKind');
export const matchFiles = required('matchFiles');

/** Syntax diagnostics recorded by the parser on a SourceFile from createSourceFile. */
export function parseDiagnosticsOf(sf: ts.SourceFile): readonly ts.DiagnosticWithLocation[] {
  const value = (sf as unknown as { parseDiagnostics?: readonly ts.DiagnosticWithLocation[] }).parseDiagnostics;
  if (!Array.isArray(value)) throw new Error(`Pinned TypeScript ${ts.version} no longer exposes parseDiagnostics`);
  return value;
}

/** Path before symlink/realpath mapping, when the resolver recorded one. */
export function originalPathOf(resolved: ts.ResolvedModuleFull): string | undefined {
  return (resolved as ts.ResolvedModuleFull & { originalPath?: string }).originalPath;
}
