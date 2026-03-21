/**
 * SillyTavern Card Extractor (TypeScript / Browser)
 *
 * Parses character card PNG or CharX ZIP files and extracts a structured
 * manifest containing apps, lore entries, and regex scripts.
 *
 * Input:  File (PNG or ZIP)
 * Output: ExtractResult — success with manifest, or error with message
 */

import JSZip from 'jszip';
import { logger } from './logger';

// ── Types ──────────────────────────────────────────────────────────

export interface AppIdMeta {
  id: string;
  name: string;
}

export interface TagSchema {
  name: string;
  type: 'text' | 'list' | 'wrapper' | 'pair' | 'image';
  description?: string;
  itemPattern?: string;
  children?: TagSchema[];
}

export interface RegexScript {
  name: string;
  file: string;
  findRegex: string;
  replaceString: string;
  type: string;
  disabled: boolean;
  placement: number[];
  runOnEdit: boolean;
  source: string;
}

export interface ImageTagPair {
  tag: string;
  imgStyle: string;
  openScript: string;
  closeScript: string;
}

export interface SkinVariant {
  findRegex: string;
  variants: { name: string; file: string; disabled: boolean }[];
}

export interface AppEntry {
  id: string;
  name: string;
  entryIndex: number;
  keywords: string[];
  format: string;
  tags: TagSchema[];
  resources: Record<string, string[]>;
  example: string;
  scripts: RegexScript[];
  imageTagPairs: ImageTagPair[];
  skinVariants: SkinVariant[];
}

export interface LoreEntry {
  index: number;
  name: string;
  keys: string[];
  secondaryKeys: string[];
  content: string;
  constant: boolean;
  selective: boolean;
  disabled: boolean;
  order: number;
  position: number;
}

export interface CharacterInfo {
  name: string;
  description: string;
  firstMessage: string;
  alternateGreetings: string[];
  personality: string;
  scenario: string;
}

export interface Manifest {
  version: string;
  generatedAt: string;
  source: string;
  sourceType: string;
  apps: AppEntry[];
  lore: LoreEntry[];
  character: CharacterInfo;
}

export type ExtractResult =
  | { status: 'success'; manifest: Manifest }
  | { status: 'error'; message: string };

// ── Internal types ─────────────────────────────────────────────────

interface InternalEntry {
  key: string[];
  keysecondary: string[];
  comment: string;
  content: string;
  constant: boolean;
  selective: boolean;
  disable: boolean;
  order: number;
  position: number;
}

interface InternalScript {
  name: string;
  file: string;
  scriptName: string;
  findRegex: string;
  replaceString: string;
  disabled: boolean;
  placement: number[];
  runOnEdit: boolean;
  _source: string;
  type: string;
  matchedApp: string | string[] | null;
  regexTags: string[];
}

// ── Constants ──────────────────────────────────────────────────────

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

/**
 * Derive a kebab-case ID from a comment string.
 * Handles ASCII (spaces/underscores → hyphens) and CJK (kept as-is).
 */
function commentToId(comment: string): string {
  return comment
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9\p{Unified_Ideograph}-]/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

const TAG_NAME_PATTERN = '[a-zA-Z\\p{Unified_Ideograph}]';
const RESOURCE_LIST_NAMES = ['scene_list', 'CG_list', 'fans', 'surveillance', 'live'];

// ── PNG parsing ────────────────────────────────────────────────────

function parsePngCardBytes(buffer: ArrayBuffer): Record<string, unknown> {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  // Verify PNG signature
  if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) {
    throw new Error('Not a valid PNG file');
  }

  const chunks: Record<string, string> = {};
  let offset = 8; // Skip PNG signature

  while (offset < buffer.byteLength) {
    if (offset + 8 > buffer.byteLength) break;

    const length = view.getUint32(offset);
    const chunkType = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7],
    );
    offset += 8;

    if (offset + length + 4 > buffer.byteLength) break;

    if (chunkType === 'tEXt') {
      const data = bytes.slice(offset, offset + length);
      const nullIdx = data.indexOf(0);
      if (nullIdx !== -1) {
        const keyword = new TextDecoder('latin1').decode(data.slice(0, nullIdx));
        const text = new TextDecoder('latin1').decode(data.slice(nullIdx + 1));
        chunks[keyword] = text;
      }
    }

    offset += length + 4; // data + CRC

    if (chunkType === 'IEND') break;
  }

  // Prefer ccv3 over chara
  const raw = chunks['ccv3'] || chunks['chara'];
  if (!raw) {
    throw new Error('No character data found in PNG');
  }

  // Decode base64 → binary string → UTF-8
  const binaryStr = atob(raw);
  const decoded = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    decoded[i] = binaryStr.charCodeAt(i);
  }
  const jsonStr = new TextDecoder('utf-8').decode(decoded);
  return JSON.parse(jsonStr);
}

// ── CharX (ZIP) parsing ────────────────────────────────────────────

async function parseCharx(buffer: ArrayBuffer): Promise<Record<string, unknown>> {
  // Find ZIP signature (handle self-extracting archives)
  const bytes = new Uint8Array(buffer);
  let zipOffset = -1;
  for (let i = 0; i < bytes.length - 4; i++) {
    if (
      bytes[i] === 0x50 &&
      bytes[i + 1] === 0x4b &&
      bytes[i + 2] === 0x03 &&
      bytes[i + 3] === 0x04
    ) {
      zipOffset = i;
      break;
    }
  }
  if (zipOffset < 0) {
    throw new Error('No ZIP data found in file');
  }

  const zip = await JSZip.loadAsync(buffer.slice(zipOffset));
  const cardFile = zip.file('card.json');
  if (!cardFile) {
    throw new Error('No card.json found in CharX archive');
  }

  const text = await cardFile.async('text');
  return JSON.parse(text);
}

// ── Input detection ────────────────────────────────────────────────

function detectInputType(fileName: string, buffer: ArrayBuffer): 'png' | 'charx' {
  const ext = fileName.split('.').pop()?.toLowerCase();
  if (ext === 'png') return 'png';
  if (ext === 'charx' || ext === 'zip') return 'charx';

  // Fallback: magic bytes
  const bytes = new Uint8Array(buffer.slice(0, 8));
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'png';
  }
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    return 'charx';
  }

  throw new Error(`Cannot detect input type for: ${fileName}`);
}

// ── Card entry conversion ──────────────────────────────────────────

function loadEntriesFromCard(
  card: Record<string, unknown>,
): { entry: InternalEntry; index: number }[] {
  const data = (card['data'] || {}) as Record<string, unknown>;
  const charBook = (data['character_book'] || null) as Record<string, unknown> | null;
  if (!charBook) return [];

  let rawEntries = charBook['entries'] as unknown[] | Record<string, unknown>;
  if (rawEntries && !Array.isArray(rawEntries)) {
    rawEntries = Object.values(rawEntries);
  }
  if (!rawEntries) return [];

  return (rawEntries as Record<string, unknown>[]).map((entry, i) => ({
    index: (entry['id'] as number) ?? i,
    entry: {
      key: (entry['keys'] as string[]) || [],
      keysecondary: (entry['secondary_keys'] as string[]) || [],
      comment: (entry['comment'] as string) || (entry['name'] as string) || '',
      content: (entry['content'] as string) || '',
      constant: (entry['constant'] as boolean) || false,
      selective: entry['selective'] !== undefined ? (entry['selective'] as boolean) : true,
      disable: !(entry['enabled'] !== undefined ? (entry['enabled'] as boolean) : true),
      order: (entry['insertion_order'] as number) || 100,
      position: ((entry['extensions'] as Record<string, unknown>)?.['position'] as number) || 0,
    },
  }));
}

function loadRegexScriptsFromCard(card: Record<string, unknown>): InternalScript[] {
  const data = (card['data'] || {}) as Record<string, unknown>;
  const extensions = (data['extensions'] || {}) as Record<string, unknown>;
  const scripts = (extensions['regex_scripts'] || []) as Record<string, unknown>[];

  return scripts.map((s, i) => ({
    name: (s['scriptName'] as string) || '',
    scriptName: (s['scriptName'] as string) || '',
    file: `embedded_${String(i).padStart(2, '0')}_${(s['scriptName'] as string) || ''}`,
    findRegex: (s['findRegex'] as string) || '',
    replaceString: (s['replaceString'] as string) || '',
    disabled: (s['disabled'] as boolean) || false,
    placement: (s['placement'] as number[]) || [],
    runOnEdit: (s['runOnEdit'] as boolean) || false,
    _source: 'embedded',
    type: '',
    matchedApp: null,
    regexTags: [],
  }));
}

// ── Tag extraction ─────────────────────────────────────────────────

function extractTags(content: string): TagSchema[] {
  const tags: TagSchema[] = [];
  const seen = new Set<string>();

  const lines = content.split('\n');
  const formatLines: string[] = [];
  let inFormat = false;

  const tagLineRe = new RegExp(`^<${TAG_NAME_PATTERN}+>.*</${TAG_NAME_PATTERN}+>$`, 'u');

  for (const line of lines) {
    const trimmed = line.trim();
    if (tagLineRe.test(trimmed)) {
      inFormat = true;
      formatLines.push(trimmed);
    } else if (inFormat && trimmed === '') {
      continue;
    } else if (inFormat) {
      break;
    }
  }

  const tagMatchRe = new RegExp(`^<(${TAG_NAME_PATTERN}+)>(.*)</\\1>$`, 'u');
  const nestedRe = new RegExp(`^<(${TAG_NAME_PATTERN}+)>.*</\\1>$`, 'u');

  for (const line of formatLines) {
    const m = tagMatchRe.exec(line);
    if (!m) continue;
    const tagName = m[1];
    const inner = m[2];
    if (seen.has(tagName)) continue;
    seen.add(tagName);

    const nested = nestedRe.exec(inner);
    if (nested) {
      tags.push({
        name: tagName,
        type: 'wrapper',
        children: [{ name: nested[1], type: 'image' }],
      });
    } else if (/\{.*?[：:].+?\}/.test(inner)) {
      const itemM = /\{(.*?)\}/.exec(inner);
      tags.push({
        name: tagName,
        type: 'list',
        itemPattern: itemM ? itemM[0] : inner,
      });
    } else {
      const desc = inner.replace(/\{\{(.*?)\}\}/g, '$1');
      tags.push({ name: tagName, type: 'text', description: desc });
    }
  }

  // Inline tags
  const inlineRe = new RegExp(
    `<(${TAG_NAME_PATTERN}+\\d*)>\\{\\{(.*?)\\}\\}</${TAG_NAME_PATTERN}+\\d*>`,
    'gu',
  );
  let inlineM;
  while ((inlineM = inlineRe.exec(content)) !== null) {
    const tagName = inlineM[1];
    const desc = inlineM[2];
    if (!seen.has(tagName)) {
      seen.add(tagName);
      tags.push({ name: tagName, type: 'text', description: desc });
    }
  }

  // Paired message tags
  const pairRe = /<([a-zA-Z]+)1>\{\{(.*?)\}\}/g;
  let pairM;
  while ((pairM = pairRe.exec(content)) !== null) {
    const prefix = pairM[1];
    const desc1 = pairM[2];
    const key = `${prefix}1`;
    if (seen.has(key)) continue;
    const m2Re = new RegExp(`<${prefix}2>\\{\\{(.*?)\\}\\}`);
    const m2 = m2Re.exec(content);
    if (m2) {
      seen.add(key);
      seen.add(`${prefix}2`);
      tags.push({
        name: `${prefix}1/${prefix}2`,
        type: 'pair',
        description: `${desc1} / ${m2[1]}`,
      });
    }
  }

  return tags;
}

// ── Resource extraction ────────────────────────────────────────────

function extractResources(content: string): Record<string, string[]> {
  const resources: Record<string, string[]> = {};

  const pattern = new RegExp(
    `<(${RESOURCE_LIST_NAMES.join('|')})>\\s*\\n([\\s\\S]*?)\\n\\s*</\\1>`,
    'g',
  );
  let m;
  while ((m = pattern.exec(content)) !== null) {
    const listName = m[1];
    const body = m[2];
    const files = body
      .split('\n')
      .map((l) => l.trim().replace(/^(\u200b|\u200c|\u200d|\uFEFF)+/, ''))
      .filter((l) => l && /\.\w{2,4}$/.test(l));
    resources[listName] = files;
  }

  const jsonM = /```json\s*\n\{\s*\n\[\s*\n([\s\S]*?)\]\s*\n\}\s*\n```/.exec(content);
  if (jsonM) {
    const stickers = jsonM[1]
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && /\.\w{2,5}$/.test(l));
    resources['stickers'] = stickers;
  }

  return resources;
}

// ── Format & example ──────────────────────────────────────────────

function detectFormatType(content: string): string {
  if (/\[(语音中|视频中|通话结束)\|/.test(content)) return 'bracket';
  const tagRe = new RegExp(`<${TAG_NAME_PATTERN}+>.*</${TAG_NAME_PATTERN}+>`, 'u');
  if (tagRe.test(content)) return 'xml';
  return 'prose';
}

function extractExample(content: string): string {
  const markers = ['生成示例：\n', '生成示例:\n', '总格式示例：\n', '总格式示例:\n'];
  for (const marker of markers) {
    const idx = content.indexOf(marker);
    if (idx === -1) continue;
    const rest = content.slice(idx + marker.length);
    const endM = /\n(?:请|注意|在|不要|保持|生成的|禁止|<CG>|如果)/.exec(rest);
    const end = endM ? endM.index : rest.length;
    const example = rest.slice(0, end).trim();
    if (example) return example;
  }
  return '';
}

// ── App extraction ─────────────────────────────────────────────────

function extractAppsFromEntries(entries: Record<string, InternalEntry>): AppEntry[] {
  const apps: AppEntry[] = [];

  for (const [index, entry] of Object.entries(entries)) {
    const content = entry.content || '';
    const comment = entry.comment || '';

    if (!content.includes('<rule S>')) continue;

    const id = commentToId(comment);
    if (!id) {
      logger.warn(
        'extractApps',
        `Empty app ID from comment "${comment}" at index ${index}, skipping.`,
      );
      continue;
    }

    apps.push({
      id,
      name: comment,
      entryIndex: parseInt(index, 10),
      keywords: [...entry.key],
      format: detectFormatType(content),
      tags: extractTags(content),
      resources: extractResources(content),
      example: extractExample(content),
      scripts: [],
      imageTagPairs: [],
      skinVariants: [],
    });
  }

  return apps;
}

function extractLoreEntries(entries: Record<string, InternalEntry>): LoreEntry[] {
  const lore: LoreEntry[] = [];

  for (const [index, entry] of Object.entries(entries)) {
    if ((entry.content || '').includes('<rule S>')) continue;

    const keys = entry.key;
    const keysecondary = entry.keysecondary;

    lore.push({
      index: parseInt(index, 10),
      name: entry.comment || '',
      keys: Array.isArray(keys) ? [...keys] : [keys],
      secondaryKeys: Array.isArray(keysecondary) ? [...keysecondary] : [keysecondary],
      content: entry.content || '',
      constant: entry.constant || false,
      selective: entry.selective !== undefined ? entry.selective : true,
      disabled: entry.disable || false,
      order: entry.order || 100,
      position: entry.position || 0,
    });
  }

  lore.sort((a, b) => a.order - b.order);
  return lore;
}

// ── Regex script analysis ──────────────────────────────────────────

function extractTagsFromRegex(findRegex: string): string[] {
  const tags = new Set<string>();

  for (const m of findRegex.matchAll(/<([a-zA-Z\p{Unified_Ideograph}]+\d*)>/gu)) {
    tags.add(m[1]);
  }
  for (const m of findRegex.matchAll(/<\\?\/?\\?\/([a-zA-Z\p{Unified_Ideograph}]+\d*)>/gu)) {
    tags.add(m[1]);
  }
  for (const m of findRegex.matchAll(/\\?\[(转账|语音中|视频中|通话结束)\\?\|/g)) {
    tags.add(m[1]);
  }
  if (findRegex.includes('\\{') && findRegex.includes('\\}')) {
    tags.add('弹幕格式');
  }

  return [...tags];
}

/**
 * Build a dynamic tag → app ID mapping from extracted apps.
 * Each tag found in an app's content is mapped to that app's ID.
 */
function buildTagAppMap(apps: AppEntry[]): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const app of apps) {
    for (const tag of app.tags) {
      const name = tag.name.includes('/') ? tag.name.split('/') : [tag.name];
      for (const n of name) {
        if (!map[n]) map[n] = [];
        if (!map[n].includes(app.id)) map[n].push(app.id);
      }
    }
  }
  return map;
}

function matchScriptToApp(
  regexTags: string[],
  tagAppMap: Record<string, string[]>,
): string | string[] | null {
  const scores: Record<string, number> = {};

  for (const tag of regexTags) {
    const appIds = tagAppMap[tag];
    if (!appIds) continue;
    for (const appId of appIds) {
      scores[appId] = (scores[appId] || 0) + 1;
    }
  }

  const entries = Object.entries(scores);
  if (entries.length === 0) return null;

  entries.sort((a, b) => b[1] - a[1]);
  const topScore = entries[0][1];
  const topApps = entries.filter(([, s]) => s === topScore).map(([id]) => id);
  return topApps.length === 1 ? topApps[0] : topApps;
}

function classifyScript(script: InternalScript, regexTags: string[]): string {
  const replaceStr = script.replaceString || '';
  const findRegex = script.findRegex || '';

  if (replaceStr.length > 500 && (replaceStr.includes('<div') || replaceStr.includes('<style'))) {
    return 'layout';
  }
  if (/< \w+>.*\[\^.*\]/.test(findRegex) && replaceStr.includes('<img src=')) {
    return 'image-open';
  }
  if (/<\/\w+>/.test(findRegex) && replaceStr.includes('style=')) {
    return 'image-close';
  }
  if (
    regexTags.some((t) => ['ch1', 'ch2', 'um1', 'um2', 'pl1', 'pl2'].includes(t)) &&
    replaceStr.includes('border-radius')
  ) {
    return 'chat-bubble';
  }
  if (replaceStr.includes('<span') || replaceStr.includes('<br>')) {
    return 'formatting';
  }
  return 'transform';
}

function normalizeScripts(
  rawScripts: InternalScript[],
  tagAppMap: Record<string, string[]>,
): InternalScript[] {
  return rawScripts.map((s) => {
    const regexTags = extractTagsFromRegex(s.findRegex || '');
    const matchedApp = matchScriptToApp(regexTags, tagAppMap);
    return {
      ...s,
      name: s.name || s.scriptName || '',
      type: classifyScript(s, regexTags),
      matchedApp,
      regexTags,
    };
  });
}

function detectImageTagPairs(scripts: InternalScript[]): ImageTagPair[] {
  const openScripts: Record<string, InternalScript> = {};
  const closeScripts: Record<string, InternalScript> = {};

  for (const s of scripts) {
    const findRegex = s.findRegex;
    const replaceStr = s.replaceString;

    const openM = /<(\w+)>\.\*/.exec(findRegex);
    if (openM && replaceStr.includes('files.catbox.moe')) {
      openScripts[openM[1]] = s;
    }

    const closeM = /<\\?\/?\\?\/(\w+)>/.exec(findRegex);
    if (closeM && replaceStr.includes('style=') && !replaceStr.includes('<div')) {
      const body = findRegex.replace(/^\/|\/[a-z]*$/g, '');
      if (/^<\\?\/?\\?\/\w+>$/.test(body)) {
        closeScripts[closeM[1]] = s;
      }
    }
  }

  const pairs: ImageTagPair[] = [];
  for (const [tag, openS] of Object.entries(openScripts)) {
    const closeS = closeScripts[tag];
    if (!closeS) continue;
    const styleM = /style="([^"]+)"/.exec(closeS.replaceString);
    pairs.push({
      tag,
      imgStyle: styleM ? styleM[1] : '',
      openScript: openS.file || openS.name || '',
      closeScript: closeS.file || closeS.name || '',
    });
  }
  return pairs;
}

function detectSkinVariants(scripts: InternalScript[]): SkinVariant[] {
  const groups: Record<string, InternalScript[]> = {};
  for (const s of scripts) {
    const key = s.findRegex;
    if (!groups[key]) groups[key] = [];
    groups[key].push(s);
  }

  return Object.entries(groups)
    .filter(([, group]) => group.length >= 2)
    .map(([regex, group]) => ({
      findRegex: regex,
      variants: group.map((s) => ({
        name: s.name,
        file: s.file || s.name || '',
        disabled: s.disabled,
      })),
    }));
}

function attachScriptsToApps(
  allScripts: InternalScript[],
  apps: AppEntry[],
  tagAppMap: Record<string, string[]>,
): void {
  const appScriptsMap: Record<string, InternalScript[]> = {};

  for (const s of allScripts) {
    if (!s.matchedApp) continue;
    const appIds = Array.isArray(s.matchedApp) ? s.matchedApp : [s.matchedApp];
    for (const appId of appIds) {
      if (!appScriptsMap[appId]) appScriptsMap[appId] = [];
      appScriptsMap[appId].push(s);
    }
  }

  const imageTagPairs = detectImageTagPairs(allScripts);
  const skinVariants = detectSkinVariants(allScripts);

  for (const app of apps) {
    const scripts = appScriptsMap[app.id] || [];
    app.scripts = scripts.map((s) => ({
      name: s.name,
      file: s.file || s.name || '',
      findRegex: s.findRegex,
      replaceString: s.replaceString,
      type: s.type,
      disabled: s.disabled,
      placement: s.placement,
      runOnEdit: s.runOnEdit,
      source: s._source || 'unknown',
    }));

    app.imageTagPairs = imageTagPairs.filter((p) => {
      const appIds = tagAppMap[p.tag];
      return appIds ? appIds.includes(app.id) : false;
    });

    app.skinVariants = skinVariants.filter((v) =>
      v.variants.some((va) => scripts.some((s) => (s.file || s.name || '') === va.file)),
    );
  }
}

// ── App Consolidation via LLM ─────────────────────────────────────

interface ConsolidationGroup {
  name: string;
  memberIds: string[];
  keywords: string[];
  tags: { name: string; description?: string }[];
}

function mergeAppEntriesWithLLMData(members: AppEntry[], group: ConsolidationGroup): AppEntry {
  const first = members[0];
  const allScripts: RegexScript[] = [];
  const allImagePairs: ImageTagPair[] = [];
  const allSkinVariants: SkinVariant[] = [];
  const mergedResources: Record<string, string[]> = {};
  const examples: string[] = [];

  for (const m of members) {
    allScripts.push(...m.scripts);
    allImagePairs.push(...m.imageTagPairs);
    allSkinVariants.push(...m.skinVariants);
    if (m.example) examples.push(m.example);
    for (const [k, v] of Object.entries(m.resources)) {
      if (!mergedResources[k]) mergedResources[k] = [];
      for (const item of v) {
        if (!mergedResources[k].includes(item)) mergedResources[k].push(item);
      }
    }
  }

  // Use LLM-curated keywords; resolve tags back to full TagSchema from members
  const memberTagMap = new Map<string, TagSchema>();
  for (const m of members) {
    for (const t of m.tags) {
      memberTagMap.set(t.name, t);
    }
  }
  const resolvedTags: TagSchema[] = group.tags.map((gt) => {
    const full = memberTagMap.get(gt.name);
    if (full) {
      // Keep structural fields from original, but prefer LLM-curated description
      return { ...full, description: gt.description ?? full.description };
    }
    return { name: gt.name, type: 'text' as const, description: gt.description };
  });

  return {
    id: group.name,
    name: group.name,
    entryIndex: first.entryIndex,
    keywords: group.keywords,
    format: first.format,
    tags: resolvedTags,
    resources: mergedResources,
    example: examples.join('\n---\n'),
    scripts: allScripts,
    imageTagPairs: allImagePairs,
    skinVariants: allSkinVariants,
  };
}

export async function consolidateApps(
  apps: AppEntry[],
  character: CharacterInfo,
): Promise<AppEntry[]> {
  logger.info(
    'consolidateApps',
    'Starting with',
    apps.length,
    'apps:',
    apps.map((a) => a.id),
  );
  const { loadConfig, chat } = await import('./llmClient');
  const config = await loadConfig();
  if (!config) {
    logger.warn('consolidateApps', 'No LLM config found, skipping consolidation');
    return apps;
  }
  logger.info('consolidateApps', 'Using LLM provider:', config.provider, 'model:', config.model);

  const appSummaries = apps.map((a) => ({
    id: a.id,
    name: a.name,
    keywords: a.keywords,
    tags: a.tags.map((t) => ({ name: t.name, description: t.description })),
  }));

  const prompt = `You are analyzing a list of apps extracted from a character card.

  Some of these apps are too small or fragmented to function as standalone apps. They need to be merged with related apps to form complete, functional applications.

  ## NPC Information (for filtering only — do NOT include in output)

  Character Name: ${character.name}
  Description: ${character.description.slice(0, 500)}

  Any reference to this character (name, nicknames, account names, traits, etc.) must be stripped from all output fields.

  ## Extracted Apps

  ${JSON.stringify(appSummaries, null, 2)}

  ## Task

  Analyze each app and decide:
  1. Which apps can stand alone as complete, functional apps — keep them as-is
  2. Which apps are too small/fragmented and should be merged with other related apps
  3. How to group the fragmented apps with related apps

  Return a JSON array of consolidated apps. Each entry has:
  - "name": the display name for the consolidated app (use the most representative name from the group, or create a new descriptive name)
  - "memberIds": array of original app ids that should be merged into this group
  - "keywords": the curated, deduplicated list of keywords for the consolidated app (merge from members, remove redundant/overlapping ones)
  - "tags": the curated list of tags for the consolidated app. Each tag is { "name": string, "description": string }. Merge tags from all members, deduplicate by name, and keep the most descriptive description.

  ## Rules

  - Every original app id must appear in exactly one group
  - A standalone app is a group with a single memberIds entry — still include its full keywords and tags
  - Merge apps that represent sub-features of the same functional area
  - Apps with distinct, complete functionality should remain separate
  - For merged apps, combine and deduplicate keywords and tags from all members
  - Remove keywords that are redundant after merging

  ## Content Boundaries

  The output must NOT contain any character-specific information. Specifically:

  1. **No character names** — do not use any of the character's names (real name, stage name, screen name, account name, nickname) in app names, tag descriptions, or keywords. Use generic functional designations only.
  2. **No character card specific data** — do not reference specific platform data or account settings (follower counts, account types, number of accounts, specific job titles). Use functional tier descriptions instead.
  3. **No indirect data leakage** — do not indirectly convey character card platform data through interaction volume depictions or activity level differences.
  4. **No personality or emotional texture** — app names and descriptions must not contain adjectives describing the character's personality, tone, or behavioral manner. Use neutral functional names only.
  5. **No behavioral motivation metaphors** — do not use metaphors implying the character's internal processes. Each app name should only state what functional area it covers.

  Respond with ONLY a valid JSON array, no markdown, no explanation.`;

  try {
    logger.info(
      'consolidateApps',
      'Sending prompt to LLM, app summaries:',
      JSON.stringify(appSummaries.map((a) => a.id)),
    );
    const result = await chat(
      [
        {
          role: 'system',
          content:
            'You are a helpful assistant that analyzes app structures. Respond only with valid JSON.',
        },
        { role: 'user', content: prompt },
      ],
      [],
      config,
    );

    const content = result.content.trim();
    logger.info('consolidateApps', 'LLM response:', content.slice(0, 500));
    // Strip markdown fences if present
    const jsonStr = content.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    const groups: ConsolidationGroup[] = JSON.parse(jsonStr);

    if (!Array.isArray(groups)) {
      logger.warn('consolidateApps', 'LLM response is not an array, skipping');
      return apps;
    }
    logger.info(
      'consolidateApps',
      'Parsed',
      groups.length,
      'groups:',
      groups.map((g) => `${g.name} (${g.memberIds.length})`),
    );

    const appMap = new Map(apps.map((a) => [a.id, a]));
    const consolidated: AppEntry[] = [];

    for (const group of groups) {
      const members = group.memberIds.map((id) => appMap.get(id)).filter((a): a is AppEntry => !!a);
      if (members.length === 0) continue;
      if (members.length === 1) {
        // Apply LLM-curated keywords/tags even for standalone apps
        const app = members[0];
        if (group.keywords) app.keywords = group.keywords;
        if (group.tags) {
          const tagMap = new Map(app.tags.map((t) => [t.name, t]));
          app.tags = group.tags.map((gt) => {
            const full = tagMap.get(gt.name);
            if (full) return { ...full, description: gt.description ?? full.description };
            return { name: gt.name, type: 'text' as const, description: gt.description };
          });
        }
        consolidated.push(app);
      } else {
        consolidated.push(mergeAppEntriesWithLLMData(members, group));
      }
    }

    logger.info(
      'consolidateApps',
      'Result:',
      apps.length,
      '→',
      consolidated.length,
      'apps:',
      consolidated.map((a) => a.id),
    );
    return consolidated.length > 0 ? consolidated : apps;
  } catch (e) {
    logger.error('consolidateApps', 'LLM analysis failed, using original apps:', e);
    return apps;
  }
}

// ── Main entry point ───────────────────────────────────────────────

export async function extractCard(file: File): Promise<ExtractResult> {
  if (file.size > MAX_FILE_SIZE) {
    return {
      status: 'error',
      message: `File too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Maximum allowed size is 50 MB.`,
    };
  }

  try {
    const buffer = await file.arrayBuffer();

    let inputType: 'png' | 'charx';
    try {
      inputType = detectInputType(file.name, buffer);
    } catch {
      return {
        status: 'error',
        message: `Unsupported file type: ${file.name}. Expected PNG or ZIP/CharX.`,
      };
    }

    // Parse card
    let card: Record<string, unknown>;
    try {
      if (inputType === 'png') {
        card = parsePngCardBytes(buffer);
      } else {
        card = await parseCharx(buffer);
      }
    } catch (e) {
      return {
        status: 'error',
        message: `Failed to parse ${inputType} file: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    // Convert entries
    const converted = loadEntriesFromCard(card);
    const entries: Record<string, InternalEntry> = {};
    for (const { entry, index } of converted) {
      entries[String(index)] = entry;
    }

    // Extract apps and lore
    const apps = extractAppsFromEntries(entries);
    const lore = extractLoreEntries(entries);

    // Extract and attach regex scripts
    const tagAppMap = buildTagAppMap(apps);
    const embeddedScripts = loadRegexScriptsFromCard(card);
    const allScripts = normalizeScripts(embeddedScripts, tagAppMap);
    attachScriptsToApps(allScripts, apps, tagAppMap);

    // Extract character info from card
    const cardData = (card['data'] || {}) as Record<string, unknown>;
    const character: CharacterInfo = {
      name: (cardData['name'] as string) || '',
      description: (cardData['description'] as string) || '',
      firstMessage: (cardData['first_mes'] as string) || '',
      alternateGreetings: (cardData['alternate_greetings'] as string[]) || [],
      personality: (cardData['personality'] as string) || '',
      scenario: (cardData['scenario'] as string) || '',
    };

    const manifest: Manifest = {
      version: '1.0',
      generatedAt: new Date().toISOString(),
      source: file.name,
      sourceType: inputType,
      apps,
      lore,
      character,
    };

    return { status: 'success', manifest };
  } catch (e) {
    return {
      status: 'error',
      message: `Unexpected error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
