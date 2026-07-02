// Pure helpers for turning the raw sources.json / evidence.json artifacts into
// structured, render-ready data for the Aoi Research detail pane. Kept out of the
// component so the parsing/formatting is unit-testable. Never throws: malformed
// input yields an empty list, and the UI falls back to the raw text.

import type { AoiResearchEvidenceClaim, AoiResearchSource } from '@/lib/aoiResearchTypes';

// The artifact content may arrive as a JSON string (stringified for the text
// state) or as an already-parsed value; normalize both to a value.
function coerceToValue(raw: unknown): unknown {
  if (typeof raw !== 'string') {
    return raw;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function toArray(raw: unknown): unknown[] {
  const value = coerceToValue(raw);
  if (Array.isArray(value)) {
    return value;
  }
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function sourceStatusRank(status: AoiResearchSource['status'] | undefined): number {
  if (status === 'accepted') {
    return 0;
  }
  if (status === 'pending') {
    return 1;
  }
  return 2; // failed or unknown
}

function confidenceFraction(claim: AoiResearchEvidenceClaim): number {
  const value = typeof claim.confidence === 'number' ? claim.confidence : 0;
  if (!Number.isFinite(value)) {
    return 0;
  }
  return value;
}

// Parse sources.json into accepted-first, valid AoiResearchSource entries.
export function parseResearchSources(raw: unknown): AoiResearchSource[] {
  const sources = toArray(raw).filter(
    (item): item is AoiResearchSource =>
      isRecord(item) && typeof item.id === 'string' && typeof item.url === 'string',
  );
  // Surface accepted sources first, then by descending search score.
  return [...sources].sort((a, b) => {
    const statusRank = sourceStatusRank(a.status) - sourceStatusRank(b.status);
    if (statusRank !== 0) {
      return statusRank;
    }
    return (b.searchScore ?? 0) - (a.searchScore ?? 0);
  });
}

// Parse evidence.json into valid claims, highest confidence first.
export function parseResearchEvidence(raw: unknown): AoiResearchEvidenceClaim[] {
  const claims = toArray(raw).filter(
    (item): item is AoiResearchEvidenceClaim =>
      isRecord(item) && typeof item.id === 'string' && typeof item.claim === 'string',
  );
  return [...claims].sort((a, b) => confidenceFraction(b) - confidenceFraction(a));
}

// A short, human-friendly source label: explicit site name, else the URL host.
export function researchSourceDomain(source: Pick<AoiResearchSource, 'siteName' | 'url'>): string {
  if (source.siteName && source.siteName.trim()) {
    return source.siteName.trim();
  }
  try {
    return new URL(source.url).hostname.replace(/^www\./, '');
  } catch {
    return source.url;
  }
}

// Normalize a confidence value (stored as 0..1 or already 0..100) to a 0-100
// integer percentage for the confidence bar.
export function researchConfidencePercent(confidence: number | undefined): number {
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) {
    return 0;
  }
  const scaled = confidence <= 1 ? confidence * 100 : confidence;
  return Math.max(0, Math.min(100, Math.round(scaled)));
}
