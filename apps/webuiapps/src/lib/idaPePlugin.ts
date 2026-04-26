import { createHash } from 'crypto';
import * as fs from 'fs';
import type { IncomingMessage, ServerResponse } from 'http';
import * as os from 'os';
import { dirname, join, resolve } from 'path';
import type { Plugin } from 'vite';
import { getOrCreateMcpHttpClient } from './idaMcpHttpClient';
import type {
  IdaPeAnalysisResponse,
  IdaPeHealth,
  IdaPeSampleResponse,
  PeBackendFunctionDetail,
  PeBackendFunctionInfo,
  PeBackendFunctionSummary,
  PeAnalysisRecord,
  PeDataDirectorySummary,
  PeExportSummary,
  PeFinding,
  PeImportModule,
  PeMetadata,
  PeSampleRecord,
  PeSectionSummary,
  PeStringHit,
  PeTriageSummary,
} from './idaPeTypes';

interface IdaPePluginOptions {
  configFile: string;
  cacheRoot?: string;
}

interface IdaPeStoredConfig {
  mode?: 'prescan-only' | 'mcp-http';
  backendUrl?: string;
}

interface ImportDescriptor {
  originalFirstThunk: number;
  timeDateStamp: number;
  forwarderChain: number;
  nameRva: number;
  firstThunk: number;
}

interface SectionEntry {
  name: string;
  virtualAddress: number;
  virtualSize: number;
  rawSize: number;
  rawOffset: number;
  characteristics: number;
}

interface ParsedPe {
  metadata: PeMetadata;
  sections: PeSectionSummary[];
  imports: PeImportModule[];
  exports: PeExportSummary;
  strings: PeStringHit[];
  dataDirectories: PeDataDirectorySummary[];
  triage: PeTriageSummary;
  findings: PeFinding[];
  summary: string;
  machineType: string;
  isDll: boolean;
}

const SAMPLE_CACHE_ROOT = resolve(os.homedir(), '.openroom', 'cache', 'pe-samples');
const ANALYSIS_CACHE_ROOT = resolve(os.homedir(), '.openroom', 'cache', 'ida-artifacts');
const SUSPICIOUS_SECTION_NAMES = [
  'upx0',
  'upx1',
  'upx2',
  '.packed',
  '.aspack',
  '.petite',
  '.vmp0',
  '.vmp1',
  '.themida',
];
const NETWORK_IMPORT_HINTS = [
  'internetopen',
  'internetconnect',
  'internetreadfile',
  'wsastartup',
  'socket',
  'connect',
  'send',
  'recv',
  'winhttpsendrequest',
  'winhttpconnect',
  'urlmon',
  'urldownloadtofile',
];
const INJECTION_IMPORT_HINTS = [
  'virtualalloc',
  'virtualallocex',
  'writeprocessmemory',
  'createremotethread',
  'queueuserapc',
  'ntunmapviewofsection',
  'rtlmovememory',
];
const ANTI_ANALYSIS_IMPORT_HINTS = [
  'isdebuggerpresent',
  'checkremotedebuggerpresent',
  'ntqueryinformationprocess',
  'outputdebugstring',
  'sleep',
];
const PERSISTENCE_IMPORT_HINTS = [
  'regsetvalue',
  'regcreatekey',
  'createservice',
  'openservice',
  'schtasks',
];
const SUSPICIOUS_STRING_PATTERNS = [
  /powershell/i,
  /cmd\.exe/i,
  /wscript/i,
  /cscript/i,
  /mshta/i,
  /hkey_(local_machine|current_user)/i,
  /software\\microsoft\\windows\\currentversion\\run/i,
  /https?:\/\//i,
  /\b\d{1,3}(?:\.\d{1,3}){3}\b/,
];
const REQUIRED_HEADLESS_TOOLS = [
  'open_binary',
  'run_auto_analysis',
  'save_database',
  'get_entry_point',
  'get_functions',
  'get_function_info',
  'get_function_disasm',
  'get_decompiled_func',
  'get_imports',
  'get_exports',
  'get_strings',
  'get_segments',
  'get_xrefs_to',
];
const REQUIRED_IDA_PRO_TOOLS = [
  'list_funcs',
  'lookup_funcs',
  'imports',
  'decompile',
  'disasm',
  'xrefs_to',
];

type McpBackendKind = 'ida-headless-mcp' | 'ida-pro-mcp';

interface CompatibleMcpBackend {
  kind: McpBackendKind;
  client: ReturnType<typeof getOrCreateMcpHttpClient>;
  backendUrl: string;
}

function readPersistedConfig(configFile: string): Record<string, unknown> {
  try {
    if (!fs.existsSync(configFile)) return {};
    const raw = fs.readFileSync(configFile, 'utf-8');
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function getStoredConfig(configFile: string): IdaPeStoredConfig {
  const persisted = readPersistedConfig(configFile);
  return ((persisted.idaPe as IdaPeStoredConfig | undefined) ?? {}) as IdaPeStoredConfig;
}

async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return await new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolveBody(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const raw = await readRawBody(req);
  const text = raw.toString('utf-8') || '{}';
  return JSON.parse(text) as T;
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function sanitizeFileName(fileName: string): string {
  const decoded = decodeURIComponent(fileName || '').trim();
  const fallback = decoded || 'sample.bin';
  return fallback.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ');
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function ensureDirectory(path: string): void {
  fs.mkdirSync(path, { recursive: true });
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : typeof value === 'bigint'
      ? Number(value)
      : fallback;
}

function formatAddress(value: unknown): string {
  const numeric = asNumber(value, Number.NaN);
  if (Number.isFinite(numeric)) return toHex(numeric);
  return asString(value);
}

function parseAddressInput(raw: string): number {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('Missing address');
  if (/^0x/i.test(trimmed)) return Number.parseInt(trimmed.slice(2), 16);
  return Number.parseInt(trimmed, 10);
}

function buildMcpEndpointCandidates(rawUrl: string): string[] {
  const trimmed = rawUrl.trim().replace(/\/+$/, '');
  if (!trimmed) return [];
  const candidates = [trimmed];
  try {
    const parsed = new URL(trimmed);
    if (!parsed.pathname || parsed.pathname === '/') {
      candidates.push(`${trimmed}/mcp`);
    }
  } catch {
    // Keep the original candidate only.
  }
  return Array.from(new Set(candidates));
}

function normalizeFsPath(value: string): string {
  return value.replace(/\//g, '\\').toLowerCase();
}

function parseHexLikeNumber(value: string): number {
  const trimmed = value.trim();
  if (!trimmed) return 0;
  if (/^0x/i.test(trimmed)) {
    return Number.parseInt(trimmed.slice(2), 16) || 0;
  }
  return Number.parseInt(trimmed, 10) || 0;
}

function extractDecompiledCodeText(payload: unknown): string | null {
  if (typeof payload === 'string') {
    const trimmed = payload.trim();
    return trimmed || null;
  }
  const data = asRecord(payload);
  const code = asString(data.code).trim();
  if (code) return code;
  const decompiled = asString(data.decompiled).trim();
  return decompiled || null;
}

function extractFunctionParameterText(signatureSource: string | null | undefined): string | null {
  const source = (signatureSource || '').trim();
  if (!source) return null;

  const headerBoundary = source.indexOf('{');
  const header = (headerBoundary >= 0 ? source.slice(0, headerBoundary) : source).trim();
  if (!header) return null;

  let start = -1;
  let depth = 0;
  for (let index = 0; index < header.length; index += 1) {
    const char = header[index];
    if (char === '(') {
      if (start === -1) {
        start = index;
      }
      depth += 1;
      continue;
    }
    if (char === ')' && start !== -1) {
      depth = Math.max(0, depth - 1);
      if (depth === 0) {
        const params = header.slice(start + 1, index).trim();
        return params || '';
      }
    }
  }

  return null;
}

function splitTopLevelParameters(parameterText: string): string[] {
  const parts: string[] = [];
  let current = '';
  let parenDepth = 0;
  let squareDepth = 0;
  let angleDepth = 0;

  for (const char of parameterText) {
    if (char === ',' && parenDepth === 0 && squareDepth === 0 && angleDepth === 0) {
      const trimmed = current.trim();
      if (trimmed) {
        parts.push(trimmed);
      }
      current = '';
      continue;
    }

    current += char;

    if (char === '(') {
      parenDepth += 1;
    } else if (char === ')') {
      parenDepth = Math.max(0, parenDepth - 1);
    } else if (char === '[') {
      squareDepth += 1;
    } else if (char === ']') {
      squareDepth = Math.max(0, squareDepth - 1);
    } else if (char === '<') {
      angleDepth += 1;
    } else if (char === '>') {
      angleDepth = Math.max(0, angleDepth - 1);
    }
  }

  const tail = current.trim();
  if (tail) {
    parts.push(tail);
  }

  return parts;
}

function inferNumArgsFromSignature(signatureSource: string | null | undefined): number | null {
  const parameterText = extractFunctionParameterText(signatureSource);
  if (parameterText === null) return null;

  const normalized = parameterText.trim();
  if (!normalized || normalized === 'void') {
    return 0;
  }

  return splitTopLevelParameters(normalized).filter((part) => part !== 'void').length;
}

function resolveNumArgs(
  rawValue: unknown,
  ...signatureSources: Array<string | null | undefined>
): number {
  const explicit = asNumber(rawValue, Number.NaN);
  if (Number.isFinite(explicit) && explicit > 0) {
    return explicit;
  }

  for (const signatureSource of signatureSources) {
    const inferred = inferNumArgsFromSignature(signatureSource);
    if (inferred !== null) {
      return inferred;
    }
  }

  return Number.isFinite(explicit) ? explicit : 0;
}

function readUInt16LE(buffer: Buffer, offset: number): number {
  if (offset < 0 || offset + 2 > buffer.length) return 0;
  return buffer.readUInt16LE(offset);
}

function readUInt32LE(buffer: Buffer, offset: number): number {
  if (offset < 0 || offset + 4 > buffer.length) return 0;
  return buffer.readUInt32LE(offset);
}

function readBigUInt64LE(buffer: Buffer, offset: number): bigint {
  if (offset < 0 || offset + 8 > buffer.length) return 0n;
  return buffer.readBigUInt64LE(offset);
}

function toHex(value: number, width = 8): string {
  return `0x${value.toString(16).padStart(width, '0')}`;
}

function bigintToHex(value: bigint, width = 8): string {
  return `0x${value.toString(16).padStart(width, '0')}`;
}

function formatPermissions(characteristics: number): string {
  return [
    characteristics & 0x40000000 ? 'R' : '-',
    characteristics & 0x80000000 ? 'W' : '-',
    characteristics & 0x20000000 ? 'X' : '-',
  ].join('');
}

function machineName(machine: number): string {
  switch (machine) {
    case 0x014c:
      return 'x86';
    case 0x8664:
      return 'x64';
    case 0x01c0:
      return 'ARM';
    case 0xaa64:
      return 'ARM64';
    case 0x0200:
      return 'IA64';
    default:
      return `unknown (${toHex(machine, 4)})`;
  }
}

function subsystemName(subsystem: number): string {
  switch (subsystem) {
    case 1:
      return 'Native';
    case 2:
      return 'Windows GUI';
    case 3:
      return 'Windows CUI';
    case 9:
      return 'Windows CE GUI';
    case 10:
      return 'EFI Application';
    case 11:
      return 'EFI Boot Service Driver';
    case 12:
      return 'EFI Runtime Driver';
    case 14:
      return 'Xbox';
    case 16:
      return 'Windows Boot Application';
    default:
      return `Unknown (${subsystem})`;
  }
}

function characteristicsList(characteristics: number): string[] {
  const entries: Array<[number, string]> = [
    [0x0002, 'Executable image'],
    [0x0020, 'Large address aware'],
    [0x0100, '32-bit machine'],
    [0x0200, 'Debug stripped'],
    [0x2000, 'DLL'],
  ];
  return entries.filter(([mask]) => (characteristics & mask) !== 0).map(([, label]) => label);
}

function dllCharacteristicsList(characteristics: number): string[] {
  const entries: Array<[number, string]> = [
    [0x0040, 'Dynamic base'],
    [0x0080, 'Force integrity'],
    [0x0100, 'NX compatible'],
    [0x0200, 'No isolation'],
    [0x0400, 'No SEH'],
    [0x4000, 'Control flow guard'],
    [0x8000, 'Terminal server aware'],
  ];
  return entries.filter(([mask]) => (characteristics & mask) !== 0).map(([, label]) => label);
}

function shannonEntropy(buffer: Buffer): number {
  if (buffer.length === 0) return 0;
  const counts = new Array<number>(256).fill(0);
  for (const byte of buffer) counts[byte]++;
  let entropy = 0;
  for (const count of counts) {
    if (count === 0) continue;
    const p = count / buffer.length;
    entropy -= p * Math.log2(p);
  }
  return Number(entropy.toFixed(2));
}

function readAsciiZ(buffer: Buffer, offset: number, maxLength = 512): string {
  if (offset < 0 || offset >= buffer.length) return '';
  let end = offset;
  while (end < buffer.length && end - offset < maxLength && buffer[end] !== 0) {
    end++;
  }
  return buffer.toString('ascii', offset, end).trim();
}

function parseSectionEntries(
  buffer: Buffer,
  numberOfSections: number,
  sectionTableOffset: number,
): SectionEntry[] {
  const sections: SectionEntry[] = [];
  for (let index = 0; index < numberOfSections; index++) {
    const offset = sectionTableOffset + index * 40;
    if (offset + 40 > buffer.length) break;
    const rawName = buffer.subarray(offset, offset + 8);
    const zeroIndex = rawName.indexOf(0);
    const name =
      rawName.toString('ascii', 0, zeroIndex >= 0 ? zeroIndex : 8).trim() || `.sec${index}`;
    sections.push({
      name,
      virtualSize: readUInt32LE(buffer, offset + 8),
      virtualAddress: readUInt32LE(buffer, offset + 12),
      rawSize: readUInt32LE(buffer, offset + 16),
      rawOffset: readUInt32LE(buffer, offset + 20),
      characteristics: readUInt32LE(buffer, offset + 36),
    });
  }
  return sections;
}

function rvaToOffset(rva: number, sections: SectionEntry[], sizeOfHeaders: number): number | null {
  if (rva === 0) return null;
  if (rva < sizeOfHeaders) return rva;
  for (const section of sections) {
    const mappedSize = Math.max(section.virtualSize, section.rawSize);
    const start = section.virtualAddress;
    const end = start + mappedSize;
    if (rva >= start && rva < end) {
      return section.rawOffset + (rva - start);
    }
  }
  return null;
}

function parseDataDirectories(
  buffer: Buffer,
  optionalHeaderOffset: number,
  optionalHeaderMagic: number,
  numberOfDirectories: number,
): PeDataDirectorySummary[] {
  const names = [
    'Export Table',
    'Import Table',
    'Resource Table',
    'Exception Table',
    'Certificate Table',
    'Base Relocation Table',
    'Debug Directory',
    'Architecture',
    'Global Ptr',
    'TLS Table',
    'Load Config Table',
    'Bound Import',
    'Import Address Table',
    'Delay Import Descriptor',
    'CLR Runtime Header',
    'Reserved',
  ];
  const directoryOffset = optionalHeaderOffset + (optionalHeaderMagic === 0x20b ? 112 : 96);
  const summaries: PeDataDirectorySummary[] = [];
  const count = Math.min(numberOfDirectories, names.length);
  for (let index = 0; index < count; index++) {
    const offset = directoryOffset + index * 8;
    const rva = readUInt32LE(buffer, offset);
    const size = readUInt32LE(buffer, offset + 4);
    summaries.push({
      name: names[index],
      rva: toHex(rva),
      size,
      present: rva !== 0 && size !== 0,
    });
  }
  return summaries;
}

function parseImportModules(
  buffer: Buffer,
  sections: SectionEntry[],
  sizeOfHeaders: number,
  importDirectoryRva: number,
  isPe32Plus: boolean,
): PeImportModule[] {
  const importOffset = rvaToOffset(importDirectoryRva, sections, sizeOfHeaders);
  if (importOffset === null) return [];
  const modules: PeImportModule[] = [];

  for (let index = 0; index < 256; index++) {
    const descriptorOffset = importOffset + index * 20;
    if (descriptorOffset + 20 > buffer.length) break;
    const descriptor: ImportDescriptor = {
      originalFirstThunk: readUInt32LE(buffer, descriptorOffset),
      timeDateStamp: readUInt32LE(buffer, descriptorOffset + 4),
      forwarderChain: readUInt32LE(buffer, descriptorOffset + 8),
      nameRva: readUInt32LE(buffer, descriptorOffset + 12),
      firstThunk: readUInt32LE(buffer, descriptorOffset + 16),
    };
    if (
      descriptor.originalFirstThunk === 0 &&
      descriptor.timeDateStamp === 0 &&
      descriptor.forwarderChain === 0 &&
      descriptor.nameRva === 0 &&
      descriptor.firstThunk === 0
    ) {
      break;
    }

    const moduleNameOffset = rvaToOffset(descriptor.nameRva, sections, sizeOfHeaders);
    const module =
      moduleNameOffset === null ? `module_${index}` : readAsciiZ(buffer, moduleNameOffset);
    const thunkRva = descriptor.originalFirstThunk || descriptor.firstThunk;
    const thunkOffset = rvaToOffset(thunkRva, sections, sizeOfHeaders);
    const names: string[] = [];

    if (thunkOffset !== null) {
      for (let thunkIndex = 0; thunkIndex < 512; thunkIndex++) {
        const itemOffset = thunkOffset + thunkIndex * (isPe32Plus ? 8 : 4);
        if (itemOffset + (isPe32Plus ? 8 : 4) > buffer.length) break;

        if (isPe32Plus) {
          const thunkValue = readBigUInt64LE(buffer, itemOffset);
          if (thunkValue === 0n) break;
          if ((thunkValue & 0x8000000000000000n) !== 0n) {
            names.push(`ordinal_${Number(thunkValue & 0xffffn)}`);
            continue;
          }
          const nameRva = Number(thunkValue & 0x7fffffffffffffffn);
          const nameOffset = rvaToOffset(nameRva, sections, sizeOfHeaders);
          if (nameOffset === null) continue;
          const importedName = readAsciiZ(buffer, nameOffset + 2);
          if (importedName) names.push(importedName);
        } else {
          const thunkValue = readUInt32LE(buffer, itemOffset);
          if (thunkValue === 0) break;
          if ((thunkValue & 0x80000000) !== 0) {
            names.push(`ordinal_${thunkValue & 0xffff}`);
            continue;
          }
          const nameOffset = rvaToOffset(thunkValue, sections, sizeOfHeaders);
          if (nameOffset === null) continue;
          const importedName = readAsciiZ(buffer, nameOffset + 2);
          if (importedName) names.push(importedName);
        }
      }
    }

    const suspiciousCount = names.filter((name) => isSuspiciousImport(name)).length;
    modules.push({
      module,
      count: names.length,
      suspiciousCount,
      names: names.slice(0, 120),
    });
  }

  return modules;
}

function parseExports(
  buffer: Buffer,
  sections: SectionEntry[],
  sizeOfHeaders: number,
  exportDirectoryRva: number,
): PeExportSummary {
  const exportOffset = rvaToOffset(exportDirectoryRva, sections, sizeOfHeaders);
  if (exportOffset === null) return { count: 0, names: [] };

  const numberOfNames = readUInt32LE(buffer, exportOffset + 24);
  const addressOfNames = readUInt32LE(buffer, exportOffset + 32);
  const namesOffset = rvaToOffset(addressOfNames, sections, sizeOfHeaders);
  if (namesOffset === null) return { count: numberOfNames, names: [] };

  const names: string[] = [];
  for (let index = 0; index < Math.min(numberOfNames, 64); index++) {
    const namePointerRva = readUInt32LE(buffer, namesOffset + index * 4);
    const nameOffset = rvaToOffset(namePointerRva, sections, sizeOfHeaders);
    if (nameOffset === null) continue;
    const name = readAsciiZ(buffer, nameOffset);
    if (name) names.push(name);
  }

  return { count: numberOfNames, names };
}

function collectStrings(buffer: Buffer): PeStringHit[] {
  const results: PeStringHit[] = [];

  let asciiStart = -1;
  for (let index = 0; index <= buffer.length; index++) {
    const byte = index < buffer.length ? buffer[index] : 0;
    const isPrintable = byte >= 0x20 && byte <= 0x7e;
    if (isPrintable) {
      if (asciiStart < 0) asciiStart = index;
      continue;
    }
    if (asciiStart >= 0 && index - asciiStart >= 6) {
      const value = buffer.toString('ascii', asciiStart, index);
      results.push({
        value,
        kind: 'ascii',
        offset: toHex(asciiStart),
        suspicious: isSuspiciousString(value),
      });
    }
    asciiStart = -1;
  }

  let utf16Start = -1;
  let utf16Count = 0;
  for (let index = 0; index <= buffer.length - 2; index += 2) {
    const codeUnit = readUInt16LE(buffer, index);
    const isPrintable = codeUnit >= 0x20 && codeUnit <= 0x7e;
    if (isPrintable) {
      if (utf16Start < 0) utf16Start = index;
      utf16Count++;
      continue;
    }
    if (utf16Start >= 0 && utf16Count >= 6) {
      const value = buffer.toString('utf16le', utf16Start, index);
      results.push({
        value,
        kind: 'utf16',
        offset: toHex(utf16Start),
        suspicious: isSuspiciousString(value),
      });
    }
    utf16Start = -1;
    utf16Count = 0;
  }

  const deduped = new Map<string, PeStringHit>();
  for (const item of results) {
    const key = `${item.kind}:${item.value}`;
    if (!deduped.has(key)) deduped.set(key, item);
  }

  return Array.from(deduped.values())
    .sort((left, right) => {
      if (left.suspicious !== right.suspicious) return left.suspicious ? -1 : 1;
      return left.value.localeCompare(right.value);
    })
    .slice(0, 160);
}

function isSuspiciousImport(importName: string): boolean {
  const lowered = importName.toLowerCase();
  return (
    NETWORK_IMPORT_HINTS.some((hint) => lowered.includes(hint)) ||
    INJECTION_IMPORT_HINTS.some((hint) => lowered.includes(hint)) ||
    ANTI_ANALYSIS_IMPORT_HINTS.some((hint) => lowered.includes(hint)) ||
    PERSISTENCE_IMPORT_HINTS.some((hint) => lowered.includes(hint))
  );
}

function isSuspiciousString(value: string): boolean {
  return SUSPICIOUS_STRING_PATTERNS.some((pattern) => pattern.test(value));
}

function buildFindings(
  metadata: PeMetadata,
  sections: PeSectionSummary[],
  imports: PeImportModule[],
  strings: PeStringHit[],
): PeFinding[] {
  const findings: PeFinding[] = [];
  const suspiciousImportNames = imports.flatMap((entry) =>
    entry.names.filter((name) => isSuspiciousImport(name)),
  );
  const suspiciousStrings = strings.filter((item) => item.suspicious).map((item) => item.value);
  const packedSections = sections.filter((section) =>
    SUSPICIOUS_SECTION_NAMES.includes(section.name.toLowerCase()),
  );
  const highEntropySections = sections.filter((section) => section.entropy >= 7.2);
  const entrySection = sections.find((section) => {
    const start = Number.parseInt(section.virtualAddress, 16);
    const end = start + Math.max(section.virtualSize, section.rawSize);
    const entry = Number.parseInt(metadata.entryPointRva, 16);
    return entry >= start && entry < end;
  });

  if (packedSections.length > 0 || highEntropySections.length >= 2) {
    findings.push({
      id: 'packed-sections',
      title: 'Packing or compression indicators detected',
      severity: packedSections.length > 0 ? 'high' : 'medium',
      category: 'packer',
      description:
        'Section names and entropy suggest the sample may be packed, compressed, or intentionally obfuscated.',
      evidence: [
        ...packedSections.map((section) => `Section ${section.name} matches known packer naming`),
        ...highEntropySections.map(
          (section) => `Section ${section.name} has high entropy (${section.entropy.toFixed(2)})`,
        ),
      ].slice(0, 6),
    });
  }

  if (
    suspiciousImportNames.some((name) =>
      INJECTION_IMPORT_HINTS.some((hint) => name.toLowerCase().includes(hint)),
    )
  ) {
    findings.push({
      id: 'process-injection',
      title: 'Potential process injection capability',
      severity: 'high',
      category: 'imports',
      description:
        'The import set includes APIs commonly used for remote allocation, memory writing, or remote thread creation.',
      evidence: suspiciousImportNames.slice(0, 6),
    });
  }

  if (
    suspiciousImportNames.some((name) =>
      NETWORK_IMPORT_HINTS.some((hint) => name.toLowerCase().includes(hint)),
    ) ||
    suspiciousStrings.some(
      (value) => /^https?:\/\//i.test(value) || /\b\d{1,3}(?:\.\d{1,3}){3}\b/.test(value),
    )
  ) {
    findings.push({
      id: 'networking',
      title: 'Network or download behavior likely',
      severity: 'medium',
      category: 'network',
      description:
        'Import names and embedded strings suggest external communication, download logic, or URL handling.',
      evidence: [
        ...suspiciousImportNames.filter((name) =>
          NETWORK_IMPORT_HINTS.some((hint) => name.toLowerCase().includes(hint)),
        ),
        ...suspiciousStrings.filter((value) => /^https?:\/\//i.test(value)).slice(0, 3),
      ].slice(0, 6),
    });
  }

  if (
    suspiciousImportNames.some((name) =>
      ANTI_ANALYSIS_IMPORT_HINTS.some((hint) => name.toLowerCase().includes(hint)),
    )
  ) {
    findings.push({
      id: 'anti-analysis',
      title: 'Anti-analysis indicators detected',
      severity: 'medium',
      category: 'anti-analysis',
      description:
        'The sample references APIs often used for debugger checks, timing evasion, or environment probing.',
      evidence: suspiciousImportNames
        .filter((name) =>
          ANTI_ANALYSIS_IMPORT_HINTS.some((hint) => name.toLowerCase().includes(hint)),
        )
        .slice(0, 6),
    });
  }

  if (metadata.tlsDirectoryPresent) {
    findings.push({
      id: 'tls-callbacks',
      title: 'TLS directory present',
      severity: 'medium',
      category: 'tls',
      description:
        'TLS callbacks can execute before the regular entry point and are worth reviewing during manual reversing.',
      evidence: ['TLS data directory is present in the optional header'],
    });
  }

  if (entrySection && entrySection.permissions.includes('W')) {
    findings.push({
      id: 'entrypoint-writable',
      title: 'Entry point located in writable section',
      severity: 'high',
      category: 'entrypoint',
      description:
        'The entry point resolves inside a writable section, which is unusual for normal compiler output and can indicate unpacking or self-modifying behavior.',
      evidence: [
        `Entry point RVA ${metadata.entryPointRva} falls inside ${entrySection.name} (${entrySection.permissions})`,
      ],
    });
  }

  if (suspiciousStrings.length > 0) {
    findings.push({
      id: 'suspicious-strings',
      title: 'Suspicious execution or persistence strings found',
      severity: 'medium',
      category: 'strings',
      description:
        'Embedded strings reference shell execution, registry run keys, or external destinations that deserve review.',
      evidence: suspiciousStrings.slice(0, 6),
    });
  }

  return findings.slice(0, 8);
}

function buildSummary(
  metadata: PeMetadata,
  triage: PeTriageSummary,
  findings: PeFinding[],
): string {
  if (findings.length === 0) {
    return `${metadata.machine} ${metadata.fileType} sample with ${triage.importFunctionCount} imported functions across ${triage.importModuleCount} modules. No strong static indicators were detected during the quick triage pass.`;
  }
  const topFinding = findings[0];
  const packedClause = triage.suspectedPacked
    ? ` Packing indicators were observed in ${triage.packedSectionCount} section(s).`
    : '';
  return `${metadata.machine} ${metadata.fileType} sample with ${triage.importFunctionCount} imported functions across ${triage.importModuleCount} modules. Top concern: ${topFinding.title.toLowerCase()}.${packedClause}`;
}

function parsePe(buffer: Buffer): ParsedPe {
  if (buffer.length < 0x100) {
    throw new Error('File is too small to be a valid PE image.');
  }
  if (buffer.toString('ascii', 0, 2) !== 'MZ') {
    throw new Error('Missing MZ header.');
  }

  const peOffset = readUInt32LE(buffer, 0x3c);
  if (peOffset <= 0 || peOffset + 4 > buffer.length) {
    throw new Error('Invalid PE header offset.');
  }
  if (buffer.toString('ascii', peOffset, peOffset + 4) !== 'PE\u0000\u0000') {
    throw new Error('Missing PE signature.');
  }

  const fileHeaderOffset = peOffset + 4;
  const machine = readUInt16LE(buffer, fileHeaderOffset);
  const numberOfSections = readUInt16LE(buffer, fileHeaderOffset + 2);
  const timestamp = readUInt32LE(buffer, fileHeaderOffset + 4);
  const sizeOfOptionalHeader = readUInt16LE(buffer, fileHeaderOffset + 16);
  const characteristics = readUInt16LE(buffer, fileHeaderOffset + 18);
  const optionalHeaderOffset = fileHeaderOffset + 20;
  const optionalHeaderMagic = readUInt16LE(buffer, optionalHeaderOffset);
  const isPe32Plus = optionalHeaderMagic === 0x20b;
  const fileType = optionalHeaderMagic === 0x10b ? 'PE32' : isPe32Plus ? 'PE32+' : 'unknown';

  const addressOfEntryPoint = readUInt32LE(buffer, optionalHeaderOffset + 16);
  const imageBase = isPe32Plus
    ? bigintToHex(readBigUInt64LE(buffer, optionalHeaderOffset + 24), 16)
    : toHex(readUInt32LE(buffer, optionalHeaderOffset + 28), 8);
  const sectionAlignment = readUInt32LE(buffer, optionalHeaderOffset + (isPe32Plus ? 32 : 32));
  const fileAlignment = readUInt32LE(buffer, optionalHeaderOffset + (isPe32Plus ? 36 : 36));
  const sizeOfImage = readUInt32LE(buffer, optionalHeaderOffset + (isPe32Plus ? 56 : 56));
  const sizeOfHeaders = readUInt32LE(buffer, optionalHeaderOffset + (isPe32Plus ? 60 : 60));
  const subsystem = readUInt16LE(buffer, optionalHeaderOffset + (isPe32Plus ? 68 : 68));
  const dllCharacteristics = readUInt16LE(buffer, optionalHeaderOffset + (isPe32Plus ? 70 : 70));
  const numberOfDirectories = readUInt32LE(buffer, optionalHeaderOffset + (isPe32Plus ? 108 : 92));

  const sectionTableOffset = optionalHeaderOffset + sizeOfOptionalHeader;
  const sectionEntries = parseSectionEntries(buffer, numberOfSections, sectionTableOffset);
  const sections: PeSectionSummary[] = sectionEntries.map((section) => {
    const rawBytes =
      section.rawOffset + section.rawSize <= buffer.length
        ? buffer.subarray(section.rawOffset, section.rawOffset + section.rawSize)
        : Buffer.alloc(0);
    return {
      name: section.name,
      virtualAddress: toHex(section.virtualAddress),
      virtualSize: section.virtualSize,
      rawSize: section.rawSize,
      rawOffset: section.rawOffset,
      entropy: shannonEntropy(rawBytes),
      permissions: formatPermissions(section.characteristics),
      characteristicsHex: toHex(section.characteristics),
    };
  });

  const dataDirectories = parseDataDirectories(
    buffer,
    optionalHeaderOffset,
    optionalHeaderMagic,
    numberOfDirectories,
  );
  const exportDirectoryRva = readUInt32LE(buffer, optionalHeaderOffset + (isPe32Plus ? 112 : 96));
  const importDirectoryRva = readUInt32LE(buffer, optionalHeaderOffset + (isPe32Plus ? 120 : 104));
  const tlsDirectoryRva = readUInt32LE(buffer, optionalHeaderOffset + (isPe32Plus ? 184 : 168));

  const imports = parseImportModules(
    buffer,
    sectionEntries,
    sizeOfHeaders,
    importDirectoryRva,
    isPe32Plus,
  );
  const exports = parseExports(buffer, sectionEntries, sizeOfHeaders, exportDirectoryRva);
  const strings = collectStrings(buffer);
  const metadata: PeMetadata = {
    fileType,
    machine: machineName(machine),
    subsystem: subsystemName(subsystem),
    imageBase,
    entryPointRva: toHex(addressOfEntryPoint),
    imageSize: sizeOfImage,
    headersSize: sizeOfHeaders,
    sectionAlignment,
    fileAlignment,
    numberOfSections,
    numberOfDirectories,
    timestamp,
    timestampIso: timestamp ? new Date(timestamp * 1000).toISOString() : null,
    characteristics: characteristicsList(characteristics),
    dllCharacteristics: dllCharacteristicsList(dllCharacteristics),
    importDirectoryPresent: importDirectoryRva !== 0,
    exportDirectoryPresent: exportDirectoryRva !== 0,
    tlsDirectoryPresent: tlsDirectoryRva !== 0,
  };

  const triage: PeTriageSummary = {
    importModuleCount: imports.length,
    importFunctionCount: imports.reduce((sum, entry) => sum + entry.count, 0),
    suspiciousImportCount: imports.reduce((sum, entry) => sum + entry.suspiciousCount, 0),
    suspiciousStringCount: strings.filter((item) => item.suspicious).length,
    highEntropySectionCount: sections.filter((section) => section.entropy >= 7.2).length,
    packedSectionCount: sections.filter((section) =>
      SUSPICIOUS_SECTION_NAMES.includes(section.name.toLowerCase()),
    ).length,
    suspectedPacked:
      sections.filter((section) => section.entropy >= 7.2).length >= 2 ||
      sections.some((section) => SUSPICIOUS_SECTION_NAMES.includes(section.name.toLowerCase())),
  };
  const findings = buildFindings(metadata, sections, imports, strings);

  return {
    metadata,
    sections,
    imports,
    exports,
    strings,
    dataDirectories,
    triage,
    findings,
    summary: buildSummary(metadata, triage, findings),
    machineType: machineName(machine),
    isDll: (characteristics & 0x2000) !== 0,
  };
}

function buildSampleRecord(
  fileName: string,
  diskPath: string,
  buffer: Buffer,
  parsed: ParsedPe,
): PeSampleRecord {
  const uploadedAt = Date.now();
  return {
    id: `sample_${sha256(buffer).slice(0, 12)}`,
    fileName,
    sha256: sha256(buffer),
    size: buffer.length,
    diskPath,
    uploadedAt,
    machineType: parsed.machineType,
    isDll: parsed.isDll,
    lastAnalysisId: null,
    lastScannedAt: null,
  };
}

function buildAnalysisRecord(sampleId: string, parsed: ParsedPe): PeAnalysisRecord {
  const now = Date.now();
  return {
    id: `analysis_${sampleId.replace(/^sample_/, '')}_${now}`,
    sampleId,
    profile: 'quick-triage',
    backendMode: 'prescan-only',
    status: 'completed',
    startedAt: now,
    finishedAt: now,
    hasDecompiler: false,
    artifactDir: '',
    backendSessionId: null,
    summary: parsed.summary,
    metadata: parsed.metadata,
    triage: parsed.triage,
    sections: parsed.sections,
    imports: parsed.imports,
    exports: parsed.exports,
    strings: parsed.strings,
    dataDirectories: parsed.dataDirectories,
    findings: parsed.findings,
  };
}

function buildCachePath(cacheRoot: string, sha: string, fileName: string): string {
  return join(cacheRoot, sha, fileName);
}

async function getCompatibleMcpBackend(configFile: string): Promise<CompatibleMcpBackend | null> {
  const stored = getStoredConfig(configFile);
  if (stored.mode !== 'mcp-http' || !stored.backendUrl?.trim()) {
    return null;
  }

  let lastError: unknown = null;
  for (const candidate of buildMcpEndpointCandidates(stored.backendUrl.trim())) {
    try {
      const client = getOrCreateMcpHttpClient(candidate);
      const tools = await client.listTools();
      const available = new Set(tools.map((tool) => tool.name));
      const headlessMissing = REQUIRED_HEADLESS_TOOLS.filter((tool) => !available.has(tool));
      if (headlessMissing.length === 0) {
        return { kind: 'ida-headless-mcp', client, backendUrl: candidate };
      }
      const idaProMissing = REQUIRED_IDA_PRO_TOOLS.filter((tool) => !available.has(tool));
      if (idaProMissing.length === 0) {
        return { kind: 'ida-pro-mcp', client, backendUrl: candidate };
      }

      throw new Error(
        `Configured MCP backend at ${candidate} is reachable but not recognized as ida-headless-mcp or ida-pro-mcp. Missing headless tools: ${headlessMissing.join(', ')}. Missing ida-pro tools: ${idaProMissing.join(', ')}`,
      );
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(lastError instanceof Error ? lastError.message : String(lastError));
}

async function ensureHeadlessSession(configFile: string, samplePath: string) {
  const compatible = await getCompatibleMcpBackend(configFile);
  if (!compatible || compatible.kind !== 'ida-headless-mcp') {
    throw new Error('IDA MCP backend is not configured.');
  }

  const opened = asRecord(await compatible.client.callTool('open_binary', { path: samplePath }));
  const sessionId = asString(opened.session_id);
  if (!sessionId) {
    throw new Error('open_binary did not return a session_id.');
  }

  return {
    client: compatible.client,
    sessionId,
    hasDecompiler: Boolean(opened.has_decompiler),
    backendUrl: compatible.backendUrl,
  };
}

async function ensureIdaProBackend(configFile: string) {
  const compatible = await getCompatibleMcpBackend(configFile);
  if (!compatible || compatible.kind !== 'ida-pro-mcp') {
    throw new Error('IDA Pro MCP backend is not configured.');
  }
  return compatible;
}

function normalizeHeadlessFunctions(payload: unknown): {
  functions: PeBackendFunctionSummary[];
  total: number;
  offset: number;
  count: number;
  limit: number;
} {
  const data = asRecord(payload);
  const functions = asArray(data.functions).map((item) => {
    const record = asRecord(item);
    return {
      address: formatAddress(record.address),
      name: asString(record.name, formatAddress(record.address)),
    };
  });

  return {
    functions,
    total: asNumber(data.total, functions.length),
    offset: asNumber(data.offset, 0),
    count: asNumber(data.count, functions.length),
    limit: asNumber(data.limit, functions.length),
  };
}

function normalizeHeadlessFunctionInfo(
  payload: unknown,
  decompiledText: string | null = null,
): PeBackendFunctionInfo | null {
  const data = asRecord(payload);
  if (Object.keys(data).length === 0) return null;

  const flags = asRecord(data.flags);
  return {
    address: formatAddress(data.address),
    name: asString(data.name),
    start: formatAddress(data.start),
    end: formatAddress(data.end),
    size: asNumber(data.size, 0),
    frameSize: asNumber(data.frame_size, 0),
    callingConvention: asString(data.calling_convention),
    returnType: asString(data.return_type),
    numArgs: resolveNumArgs(
      data.num_args,
      asString(data.prototype),
      asString(data.signature),
      decompiledText,
    ),
    flags: {
      isLibrary: Boolean(flags.is_library),
      isThunk: Boolean(flags.is_thunk),
      noReturn: Boolean(flags.no_return),
      hasFarseg: Boolean(flags.has_farseg),
      isStatic: Boolean(flags.is_static),
    },
  };
}

function normalizeHeadlessFunctionDetail(
  sessionId: string,
  address: number,
  infoPayload: unknown,
  decompiledPayload: unknown,
  disassemblyPayload: unknown,
  xrefsPayload: unknown,
): PeBackendFunctionDetail {
  const xrefData = asRecord(xrefsPayload);
  const xrefsTo = asArray(xrefData.xrefs).map((item) => {
    const record = asRecord(item);
    return {
      from: formatAddress(record.from),
      to: formatAddress(record.to),
      type: asNumber(record.type, 0),
    };
  });
  const decompiled = extractDecompiledCodeText(decompiledPayload);
  const disassembly =
    typeof disassemblyPayload === 'string'
      ? disassemblyPayload
      : asString(asRecord(disassemblyPayload).disassembly) || null;

  return {
    sessionId,
    address: toHex(address),
    info: normalizeHeadlessFunctionInfo(infoPayload, decompiled),
    decompiled,
    disassembly,
    xrefsTo,
  };
}

async function runHeadlessQuickTriage(
  configFile: string,
  samplePath: string,
): Promise<{ backendSessionId: string; hasDecompiler: boolean }> {
  const session = await ensureHeadlessSession(configFile, samplePath);
  await session.client.callTool('run_auto_analysis', { session_id: session.sessionId });
  try {
    await session.client.callTool('save_database', { session_id: session.sessionId });
  } catch {
    // Saving the database is helpful but not required for the quick triage response.
  }
  return {
    backendSessionId: session.sessionId,
    hasDecompiler: session.hasDecompiler,
  };
}

async function getHeadlessFunctions(
  configFile: string,
  samplePath: string,
  params: { offset?: number; limit?: number; regex?: string } = {},
) {
  const session = await ensureHeadlessSession(configFile, samplePath);
  const payload = await session.client.callTool('get_functions', {
    session_id: session.sessionId,
    ...(typeof params.offset === 'number' ? { offset: params.offset } : {}),
    ...(typeof params.limit === 'number' ? { limit: params.limit } : {}),
    ...(params.regex ? { regex: params.regex } : {}),
  });
  return {
    sessionId: session.sessionId,
    ...normalizeHeadlessFunctions(payload),
  };
}

async function getHeadlessFunctionDetail(
  configFile: string,
  samplePath: string,
  address: number,
): Promise<PeBackendFunctionDetail> {
  const session = await ensureHeadlessSession(configFile, samplePath);
  const [infoPayload, disassemblyPayload, xrefsPayload, decompiledPayload] = await Promise.all([
    session.client.callTool('get_function_info', {
      session_id: session.sessionId,
      address,
    }),
    session.client.callTool('get_function_disasm', {
      session_id: session.sessionId,
      address,
    }),
    session.client.callTool('get_xrefs_to', {
      session_id: session.sessionId,
      address,
    }),
    session.hasDecompiler
      ? session.client.callTool('get_decompiled_func', {
          session_id: session.sessionId,
          address,
        })
      : Promise.resolve(null),
  ]);

  return normalizeHeadlessFunctionDetail(
    session.sessionId,
    address,
    infoPayload,
    decompiledPayload,
    disassemblyPayload,
    xrefsPayload,
  );
}

async function getIdaProMetadata(configFile: string) {
  const backend = await ensureIdaProBackend(configFile);
  const metadata = asRecord(await backend.client.readResource('ida://idb/metadata'));
  return {
    backend,
    metadata,
  };
}

function deriveInputBinaryPathFromIdbMetadata(metadata: Record<string, unknown>): string | null {
  const idbPath = asString(metadata.path).trim();
  const module = asString(metadata.module).trim();
  if (!idbPath) return null;

  const candidates = new Set<string>();
  const parsedIdbPath = resolve(idbPath);
  const dir = dirname(parsedIdbPath);
  if (module) {
    candidates.add(join(dir, module));
  }
  if (/\.(i64|idb)$/i.test(parsedIdbPath)) {
    candidates.add(parsedIdbPath.replace(/\.(i64|idb)$/i, ''));
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

function doesIdaProMetadataMatchSample(
  metadata: Record<string, unknown>,
  samplePath: string,
  sampleBuffer: Buffer | null,
): boolean {
  if (normalizeFsPath(asString(metadata.path)) === normalizeFsPath(samplePath)) {
    return true;
  }
  if (!sampleBuffer) return false;
  const sampleSha = sha256(sampleBuffer).toLowerCase();
  const backendSha = asString(metadata.sha256).toLowerCase();
  return Boolean(sampleSha && backendSha && sampleSha === backendSha);
}

function normalizeIdaProFunctions(payload: unknown): {
  functions: PeBackendFunctionSummary[];
  total: number;
  offset: number;
  count: number;
  limit: number;
} {
  const wrapped = asRecord(payload);
  const pages = asArray(wrapped.result ?? payload);
  const page = asRecord(pages[0]);
  const data = asArray(page.data).map((item) => {
    const record = asRecord(item);
    return {
      address: asString(record.addr),
      name: asString(record.name, asString(record.addr)),
    };
  });

  return {
    functions: data,
    total: asNumber(page.total, data.length),
    offset: asNumber(page.offset, 0),
    count: asNumber(page.count, data.length),
    limit: data.length,
  };
}

function normalizeIdaProFunctionInfo(
  payload: unknown,
  address: number,
  decompiledText: string | null = null,
): PeBackendFunctionInfo | null {
  const wrapped = asRecord(payload);
  const list = asArray(wrapped.result ?? payload);
  const first = asRecord(list[0]);
  const fn = asRecord(first.fn);
  if (Object.keys(fn).length === 0) return null;

  const sizeHex = asString(fn.size);
  return {
    address: asString(fn.addr, toHex(address)),
    name: asString(fn.name, toHex(address)),
    start: asString(fn.addr, toHex(address)),
    end: '-',
    size: sizeHex ? Number.parseInt(sizeHex.replace(/^0x/i, ''), 16) || 0 : 0,
    frameSize: 0,
    callingConvention: '',
    returnType: '',
    numArgs: resolveNumArgs(
      fn.num_args,
      asString(fn.prototype),
      asString(fn.signature),
      asString(fn.type),
      decompiledText,
    ),
    flags: {
      isLibrary: false,
      isThunk: false,
      noReturn: false,
      hasFarseg: false,
      isStatic: false,
    },
  };
}

function extractIdaProDisassembly(payload: unknown): string | null {
  const data = asRecord(payload);
  const asm = asRecord(data.asm);
  return asString(asm.lines) || null;
}

function normalizeIdaProXrefs(payload: unknown): Array<{ from: string; to: string; type: number }> {
  const wrapped = asRecord(payload);
  const data = asArray(wrapped.result ?? payload);
  const first = asRecord(data[0]);
  const xrefs = asArray(first.xrefs);
  return xrefs.map((item) => {
    const record = asRecord(item);
    return {
      from: asString(record.addr),
      to: '',
      type: asString(record.type).toLowerCase() === 'code' ? 1 : 0,
    };
  });
}

async function runIdaProQuickTriage(
  configFile: string,
  samplePath: string,
): Promise<{ backendSessionId: string; hasDecompiler: boolean; matchedSample: boolean }> {
  const buffer = fs.readFileSync(samplePath);
  const { metadata } = await getIdaProMetadata(configFile);
  return {
    backendSessionId: 'ida-pro-current',
    hasDecompiler: true,
    matchedSample: doesIdaProMetadataMatchSample(metadata, samplePath, buffer),
  };
}

async function getIdaProFunctions(
  configFile: string,
  samplePath: string,
  params: { offset?: number; limit?: number; regex?: string } = {},
) {
  const buffer = fs.readFileSync(samplePath);
  const { backend, metadata } = await getIdaProMetadata(configFile);
  if (!doesIdaProMetadataMatchSample(metadata, samplePath, buffer)) {
    throw new Error(
      'The currently opened IDA database does not match the selected PE sample. Start the MCP plugin on the matching IDB first.',
    );
  }

  const payload = await backend.client.callTool('list_funcs', {
    queries: {
      offset: params.offset ?? 0,
      count: params.limit ?? 150,
      filter: params.regex ?? '*',
    },
  });
  return {
    sessionId: 'ida-pro-current',
    ...normalizeIdaProFunctions(payload),
  };
}

async function getIdaProFunctionDetail(
  configFile: string,
  samplePath: string,
  address: number,
): Promise<PeBackendFunctionDetail> {
  const buffer = fs.readFileSync(samplePath);
  const { backend, metadata } = await getIdaProMetadata(configFile);
  if (!doesIdaProMetadataMatchSample(metadata, samplePath, buffer)) {
    throw new Error(
      'The currently opened IDA database does not match the selected PE sample. Start the MCP plugin on the matching IDB first.',
    );
  }

  const addressHex = toHex(address);
  const [infoPayload, decompiledPayload, disassemblyPayload, xrefsPayload] = await Promise.all([
    backend.client.callTool('lookup_funcs', { queries: addressHex }),
    backend.client.callTool('decompile', { addr: addressHex }),
    backend.client.callTool('disasm', { addr: addressHex, max_instructions: 250 }),
    backend.client.callTool('xrefs_to', { addrs: addressHex }),
  ]);
  const decompiled = extractDecompiledCodeText(decompiledPayload);

  return {
    sessionId: 'ida-pro-current',
    address: addressHex,
    info: normalizeIdaProFunctionInfo(infoPayload, address, decompiled),
    decompiled,
    disassembly: extractIdaProDisassembly(disassemblyPayload),
    xrefsTo: normalizeIdaProXrefs(xrefsPayload),
  };
}

function groupImportsFromIdaPro(payload: unknown): PeImportModule[] {
  const page = asRecord(payload);
  const rows = asArray(page.data);
  const grouped = new Map<string, Set<string>>();
  for (const item of rows) {
    const record = asRecord(item);
    const moduleName = asString(record.module, 'unknown');
    const importedName = asString(record.imported_name, asString(record.name));
    if (!grouped.has(moduleName)) {
      grouped.set(moduleName, new Set<string>());
    }
    if (importedName) {
      grouped.get(moduleName)!.add(importedName);
    }
  }

  return Array.from(grouped.entries())
    .map(([module, namesSet]) => {
      const names = Array.from(namesSet.values());
      return {
        module,
        count: names.length,
        suspiciousCount: names.filter((name) => isSuspiciousImport(name)).length,
        names: names.slice(0, 120),
      };
    })
    .sort((left, right) => right.count - left.count);
}

function mapSegmentsToSections(payload: unknown): PeSectionSummary[] {
  return asArray(payload).map((item, index) => {
    const record = asRecord(item);
    const start = parseHexLikeNumber(asString(record.start));
    const end = parseHexLikeNumber(asString(record.end));
    const size = Math.max(end - start, parseHexLikeNumber(asString(record.size)));
    return {
      name: asString(record.name, `.seg${index}`),
      virtualAddress: asString(record.start, toHex(start)),
      virtualSize: size,
      rawSize: size,
      rawOffset: 0,
      entropy: 0,
      permissions: asString(record.permissions, '---'),
      characteristicsHex: '',
    };
  });
}

async function collectIdaProSuspiciousStrings(
  backend: CompatibleMcpBackend,
): Promise<PeStringHit[]> {
  const regexes = [
    'powershell|cmd\\\\.exe|wscript|cscript|mshta',
    'hkey_(local_machine|current_user)|software\\\\\\\\microsoft\\\\\\\\windows\\\\\\\\currentversion\\\\\\\\run',
    'https?://|\\\\b\\\\d{1,3}(?:\\\\.\\\\d{1,3}){3}\\\\b',
  ];

  const results = await Promise.all(
    regexes.map((pattern) =>
      backend.client.callTool('find_regex', {
        pattern,
        limit: 40,
        offset: 0,
      }),
    ),
  );

  const deduped = new Map<string, PeStringHit>();
  for (const payload of results) {
    const data = asRecord(payload);
    for (const item of asArray(data.matches)) {
      const record = asRecord(item);
      const value = asString(record.string);
      const address = asString(record.addr);
      if (!value || deduped.has(`${address}:${value}`)) continue;
      deduped.set(`${address}:${value}`, {
        value,
        kind: 'ascii',
        offset: address,
        suspicious: true,
      });
    }
  }

  return Array.from(deduped.values()).slice(0, 120);
}

async function analyzeCurrentIdaProIdb(configFile: string): Promise<IdaPeAnalysisResponse> {
  const { backend, metadata } = await getIdaProMetadata(configFile);
  const binaryPath = deriveInputBinaryPathFromIdbMetadata(metadata);
  const now = Date.now();

  if (binaryPath && fs.existsSync(binaryPath) && fs.statSync(binaryPath).isFile()) {
    const buffer = fs.readFileSync(binaryPath);
    const parsed = parsePe(buffer);
    const sample: PeSampleRecord = {
      ...buildSampleRecord(
        asString(metadata.module, asString(metadata.path)),
        binaryPath,
        buffer,
        parsed,
      ),
      id: `current_${sha256(buffer).slice(0, 12)}`,
      uploadedAt: now,
      sourceMode: 'current-idb',
    };
    const analysis: PeAnalysisRecord = {
      ...buildAnalysisRecord(sample.id, parsed),
      backendMode: 'mcp-http',
      backendSessionId: 'ida-pro-current',
      hasDecompiler: true,
      summary: `${parsed.summary} Source: current IDB in IDA Pro.`,
    };
    sample.lastAnalysisId = analysis.id;
    sample.lastScannedAt = analysis.finishedAt;
    return { sample, analysis };
  }

  const [segmentsPayload, entrypointsPayload, importsPayload, strings] = await Promise.all([
    backend.client.readResource('ida://idb/segments'),
    backend.client.readResource('ida://idb/entrypoints'),
    backend.client.callTool('imports', { offset: 0, count: 0 }),
    collectIdaProSuspiciousStrings(backend),
  ]);

  const sections = mapSegmentsToSections(segmentsPayload);
  const imports = groupImportsFromIdaPro(importsPayload);
  const entrypoints = asArray(entrypointsPayload);
  const firstEntrypoint = asRecord(entrypoints[0]);
  const metadataRecord: PeMetadata = {
    fileType: 'unknown',
    machine: 'IDA current IDB',
    subsystem: 'Unknown',
    imageBase: asString(metadata.base, '0x0'),
    entryPointRva: asString(firstEntrypoint.addr, '0x0'),
    imageSize: parseHexLikeNumber(asString(metadata.size)),
    headersSize: 0,
    sectionAlignment: 0,
    fileAlignment: 0,
    numberOfSections: sections.length,
    numberOfDirectories: 0,
    timestamp: 0,
    timestampIso: null,
    characteristics: [],
    dllCharacteristics: [],
    importDirectoryPresent: imports.length > 0,
    exportDirectoryPresent: false,
    tlsDirectoryPresent: false,
  };
  const triage: PeTriageSummary = {
    importModuleCount: imports.length,
    importFunctionCount: imports.reduce((sum, entry) => sum + entry.count, 0),
    suspiciousImportCount: imports.reduce((sum, entry) => sum + entry.suspiciousCount, 0),
    suspiciousStringCount: strings.length,
    highEntropySectionCount: 0,
    packedSectionCount: 0,
    suspectedPacked: false,
  };
  const findings = buildFindings(metadataRecord, sections, imports, strings);
  const sampleId = `current_${asString(metadata.sha256, `${now}`).slice(0, 12)}`;
  const sample: PeSampleRecord = {
    id: sampleId,
    fileName: asString(metadata.module, 'Current IDB'),
    sha256: asString(metadata.sha256),
    size: parseHexLikeNumber(asString(metadata.filesize)),
    diskPath: asString(metadata.path),
    uploadedAt: now,
    machineType: 'IDA current IDB',
    isDll: /\.dll$/i.test(asString(metadata.module)),
    sourceMode: 'current-idb',
    lastAnalysisId: null,
    lastScannedAt: null,
  };
  const analysis: PeAnalysisRecord = {
    id: `analysis_${sampleId}_${now}`,
    sampleId,
    profile: 'quick-triage',
    backendMode: 'mcp-http',
    status: 'completed',
    startedAt: now,
    finishedAt: now,
    hasDecompiler: true,
    artifactDir: '',
    backendSessionId: 'ida-pro-current',
    summary: buildSummary(metadataRecord, triage, findings) + ' Source: current IDB in IDA Pro.',
    metadata: metadataRecord,
    triage,
    sections,
    imports,
    exports: { count: 0, names: [] },
    strings,
    dataDirectories: [],
    findings,
  };
  sample.lastAnalysisId = analysis.id;
  sample.lastScannedAt = analysis.finishedAt;
  return { sample, analysis };
}

async function computeHealth(configFile: string): Promise<IdaPeHealth> {
  const stored = getStoredConfig(configFile);
  const backendMode = stored.mode === 'mcp-http' ? 'mcp-http' : 'prescan-only';
  const backendUrl = stored.backendUrl?.trim() || null;
  let backendFlavor: 'ida-headless-mcp' | 'ida-pro-mcp' | null = null;
  let backendReachable = false;
  let message =
    'Quick PE pre-scan is available. Configure idaPe.backendUrl in config.json to prepare for MCP-backed analysis later.';

  if (backendMode === 'mcp-http' && backendUrl) {
    try {
      const backend = await getCompatibleMcpBackend(configFile);
      backendFlavor = backend?.kind ?? null;
      backendReachable = true;
      message =
        backend?.kind === 'ida-pro-mcp'
          ? 'Configured ida-pro-mcp backend is reachable. Make sure the matching IDB is open and the IDA MCP plugin is started.'
          : 'Configured ida-headless-mcp backend is reachable and tool-compatible.';
    } catch (error) {
      backendReachable = false;
      message = error instanceof Error ? error.message : String(error);
    }
  }

  const backendConfigured = backendMode === 'mcp-http' && Boolean(backendUrl);
  return {
    status: backendConfigured && !backendReachable ? 'degraded' : 'ok',
    backendMode,
    backendFlavor,
    backendConfigured,
    backendReachable,
    backendUrl,
    message,
    capabilities: {
      upload: true,
      quickTriage: true,
      idaMcp: backendConfigured && backendReachable,
      currentIdb: backendFlavor === 'ida-pro-mcp' && backendReachable,
    },
  };
}

export function idaPePlugin(options: IdaPePluginOptions): Plugin {
  const sampleRoot = options.cacheRoot
    ? resolve(options.cacheRoot, 'pe-samples')
    : SAMPLE_CACHE_ROOT;
  const artifactRoot = options.cacheRoot
    ? resolve(options.cacheRoot, 'ida-artifacts')
    : ANALYSIS_CACHE_ROOT;

  return {
    name: 'ida-pe-plugin',
    configureServer(server) {
      server.middlewares.use('/api/ida-pe/health', async (_req, res) => {
        try {
          const health = await computeHealth(options.configFile);
          sendJson(res, 200, health);
        } catch (error) {
          sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
        }
      });

      server.middlewares.use('/api/ida-pe/samples', async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'Method not allowed' });
          return;
        }

        try {
          const fileName = sanitizeFileName(String(req.headers['x-file-name'] || 'sample.bin'));
          const buffer = await readRawBody(req);
          if (buffer.length === 0) {
            sendJson(res, 400, { error: 'Empty upload body' });
            return;
          }

          const parsed = parsePe(buffer);
          const fileSha = sha256(buffer);
          const diskPath = buildCachePath(sampleRoot, fileSha, fileName);
          ensureDirectory(dirname(diskPath));
          if (!fs.existsSync(diskPath)) {
            fs.writeFileSync(diskPath, buffer);
          }

          const sample = buildSampleRecord(fileName, diskPath, buffer, parsed);
          const analysis = buildAnalysisRecord(sample.id, parsed);
          sample.lastAnalysisId = analysis.id;
          sample.lastScannedAt = analysis.finishedAt;

          const response: IdaPeSampleResponse = { sample, analysis };
          sendJson(res, 200, response);
        } catch (error) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
        }
      });

      server.middlewares.use('/api/ida-pe/analyses', async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'Method not allowed' });
          return;
        }

        try {
          const body = await readJsonBody<{ samplePath?: string; sampleId?: string }>(req);
          const samplePath = body.samplePath?.trim();
          const sampleId = body.sampleId?.trim();
          if (!samplePath || !sampleId) {
            sendJson(res, 400, { error: 'Missing samplePath or sampleId' });
            return;
          }
          if (!fs.existsSync(samplePath) || !fs.statSync(samplePath).isFile()) {
            sendJson(res, 404, { error: 'Sample file not found on disk' });
            return;
          }

          const buffer = fs.readFileSync(samplePath);
          const parsed = parsePe(buffer);
          const analysis = buildAnalysisRecord(sampleId, parsed);
          analysis.artifactDir = join(artifactRoot, analysis.id);
          ensureDirectory(analysis.artifactDir);

          const health = await computeHealth(options.configFile);
          if (health.backendMode === 'mcp-http' && health.backendReachable) {
            const backend = await getCompatibleMcpBackend(options.configFile);
            if (backend?.kind === 'ida-headless-mcp') {
              const result = await runHeadlessQuickTriage(options.configFile, samplePath);
              analysis.backendMode = 'mcp-http';
              analysis.backendSessionId = result.backendSessionId;
              analysis.hasDecompiler = result.hasDecompiler;
            } else if (backend?.kind === 'ida-pro-mcp') {
              const result = await runIdaProQuickTriage(options.configFile, samplePath);
              if (result.matchedSample) {
                analysis.backendMode = 'mcp-http';
                analysis.backendSessionId = result.backendSessionId;
                analysis.hasDecompiler = result.hasDecompiler;
              } else {
                analysis.summary +=
                  ' IDA Pro MCP is reachable, but the currently opened IDB does not match this uploaded sample yet.';
              }
            }
          }

          fs.writeFileSync(
            join(analysis.artifactDir, 'analysis.json'),
            JSON.stringify(analysis, null, 2),
            'utf-8',
          );
          const sample: PeSampleRecord = {
            id: sampleId,
            fileName: samplePath.split(/[\\/]/).pop() || 'sample.bin',
            sha256: sha256(buffer),
            size: buffer.length,
            diskPath: samplePath,
            uploadedAt: fs.statSync(samplePath).birthtimeMs || fs.statSync(samplePath).mtimeMs,
            machineType: parsed.machineType,
            isDll: parsed.isDll,
            lastAnalysisId: analysis.id,
            lastScannedAt: analysis.finishedAt,
          };

          const response: IdaPeAnalysisResponse = { sample, analysis };
          sendJson(res, 200, response);
        } catch (error) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
        }
      });

      server.middlewares.use('/api/ida-pe/current-idb', async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'Method not allowed' });
          return;
        }

        try {
          const health = await computeHealth(options.configFile);
          if (health.backendFlavor !== 'ida-pro-mcp' || !health.backendReachable) {
            sendJson(res, 400, {
              error:
                'Current IDB mode requires a reachable ida_pro_mcp backend. Start the IDA MCP plugin and point idaPe.backendUrl at its /mcp endpoint.',
            });
            return;
          }

          const response = await analyzeCurrentIdaProIdb(options.configFile);
          response.analysis.artifactDir = join(artifactRoot, response.analysis.id);
          ensureDirectory(response.analysis.artifactDir);
          fs.writeFileSync(
            join(response.analysis.artifactDir, 'analysis.json'),
            JSON.stringify(response.analysis, null, 2),
            'utf-8',
          );
          sendJson(res, 200, response);
        } catch (error) {
          sendJson(res, 502, { error: error instanceof Error ? error.message : String(error) });
        }
      });

      server.middlewares.use('/api/ida-pe/artifacts', (_req, res) => {
        ensureDirectory(artifactRoot);
        sendJson(res, 200, { ok: true, artifactRoot });
      });

      server.middlewares.use('/api/ida-pe/functions', async (req, res) => {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'Method not allowed' });
          return;
        }

        try {
          const url = new URL(req.url || '', 'http://localhost');
          const samplePath = url.searchParams.get('samplePath')?.trim();
          if (!samplePath) {
            sendJson(res, 400, { error: 'Missing samplePath parameter' });
            return;
          }

          const offset = Number.parseInt(url.searchParams.get('offset') || '0', 10);
          const limit = Number.parseInt(url.searchParams.get('limit') || '100', 10);
          const regex = (url.searchParams.get('regex') || '').trim();
          const backend = await getCompatibleMcpBackend(options.configFile);
          const result =
            backend?.kind === 'ida-pro-mcp'
              ? await getIdaProFunctions(options.configFile, samplePath, {
                  offset: Number.isFinite(offset) ? offset : 0,
                  limit: Number.isFinite(limit) ? limit : 100,
                  ...(regex ? { regex } : {}),
                })
              : await getHeadlessFunctions(options.configFile, samplePath, {
                  offset: Number.isFinite(offset) ? offset : 0,
                  limit: Number.isFinite(limit) ? limit : 100,
                  ...(regex ? { regex } : {}),
                });
          sendJson(res, 200, result);
        } catch (error) {
          sendJson(res, 502, { error: error instanceof Error ? error.message : String(error) });
        }
      });

      server.middlewares.use('/api/ida-pe/function-detail', async (req, res) => {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'Method not allowed' });
          return;
        }

        try {
          const url = new URL(req.url || '', 'http://localhost');
          const samplePath = url.searchParams.get('samplePath')?.trim();
          const addressRaw = url.searchParams.get('address')?.trim();
          if (!samplePath || !addressRaw) {
            sendJson(res, 400, { error: 'Missing samplePath or address parameter' });
            return;
          }

          const backend = await getCompatibleMcpBackend(options.configFile);
          const detail =
            backend?.kind === 'ida-pro-mcp'
              ? await getIdaProFunctionDetail(
                  options.configFile,
                  samplePath,
                  parseAddressInput(addressRaw),
                )
              : await getHeadlessFunctionDetail(
                  options.configFile,
                  samplePath,
                  parseAddressInput(addressRaw),
                );
          sendJson(res, 200, detail);
        } catch (error) {
          sendJson(res, 502, { error: error instanceof Error ? error.message : String(error) });
        }
      });
    },
  };
}
