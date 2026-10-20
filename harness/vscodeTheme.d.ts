// Types for vscodeTheme.js, which the harness page loads as is (no build step).
export type ThemeKind = 'dark' | 'light' | 'hcDark' | 'hcLight';
type Default = string | null | [string, number];
export const KINDS: ThemeKind[];
export const BODY_CLASS: Record<ThemeKind, string>;
export const DEFAULTS: Record<string, Default | [Default, Default, Default, Default]>;
export function kindOf(uiTheme: string | undefined): ThemeKind;
export function parseHex(hex: string): [number, number, number, number] | null;
export function parseJsonc(text: string): any;
export function resolveColors(themeColors: Record<string, unknown> | undefined, kind: ThemeKind): Record<string, string>;
export function cssVariable(id: string): string;
export function loadThemeColors(url: string, read?: (url: string) => Promise<string>): Promise<{ colors: Record<string, string>; type?: string; name?: string }>;
export function applyTheme(doc: Document, colors: Record<string, string>, kind: ThemeKind): void;
export function loadTheme(file: string, doc?: Document): Promise<{ label: string; kind: ThemeKind }>;
