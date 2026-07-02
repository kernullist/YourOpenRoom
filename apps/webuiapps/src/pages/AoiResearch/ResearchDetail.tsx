import React, { useEffect, useRef } from 'react';
import { ArrowUpRight, ExternalLink } from 'lucide-react';
import type { AoiResearchSource } from '@/lib/aoiResearchTypes';
import {
  parseResearchEvidence,
  researchConfidencePercent,
  researchSourceDomain,
} from './researchArtifacts';
import styles from './index.module.scss';

// Fallback when the artifact cannot be parsed into structured cards: show the raw
// text so nothing is ever hidden, or an empty-state hint when there is nothing.
const RawFallback: React.FC<{ raw: string; emptyLabel: string }> = ({ raw, emptyLabel }) => {
  if (raw.trim()) {
    return <pre className={styles.artifactRaw}>{raw}</pre>;
  }
  return <div className={styles.artifactHint}>{emptyLabel}</div>;
};

export const ResearchSourcesList: React.FC<{
  sources: AoiResearchSource[];
  raw: string;
  highlightId?: string | null;
}> = ({ sources, raw, highlightId }) => {
  const highlightRef = useRef<HTMLLIElement | null>(null);

  // Scroll the highlighted source into view when arriving from an evidence card.
  useEffect(() => {
    if (highlightId && highlightRef.current) {
      highlightRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [highlightId]);

  if (sources.length === 0) {
    return <RawFallback raw={raw} emptyLabel="No sources." />;
  }
  return (
    <ol className={styles.sourceList} data-testid="aoi-research-sources">
      {sources.map((source, index) => {
        const highlighted = highlightId === source.id;
        return (
          <li
            key={source.id}
            ref={highlighted ? highlightRef : undefined}
            id={`aoi-source-${source.id}`}
            className={styles.sourceCard}
            data-highlight={highlighted || undefined}
          >
            <div className={styles.sourceTop}>
              <span className={styles.sourceIndex}>{source.citationId || index + 1}</span>
              <span className={styles.sourceStatus} data-status={source.status}>
                {source.status}
              </span>
              <span className={styles.sourceDomain}>{researchSourceDomain(source)}</span>
            </div>
            <a
              className={styles.sourceTitle}
              href={source.finalUrl || source.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              <span>{source.title || source.url}</span>
              <ExternalLink size={12} />
            </a>
            {source.excerpt ? <p className={styles.sourceExcerpt}>{source.excerpt}</p> : null}
          </li>
        );
      })}
    </ol>
  );
};

export const ResearchEvidenceList: React.FC<{
  raw: string;
  sources: AoiResearchSource[];
  onNavigateToSource: (sourceId: string) => void;
}> = ({ raw, sources, onNavigateToSource }) => {
  const claims = parseResearchEvidence(raw);
  if (claims.length === 0) {
    return <RawFallback raw={raw} emptyLabel="No evidence." />;
  }
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  return (
    <ul className={styles.evidenceList} data-testid="aoi-research-evidence">
      {claims.map((claim) => {
        const percent = researchConfidencePercent(claim.confidence);
        const source = sourceById.get(claim.sourceId);
        const sourceLabel = source
          ? [source.citationId, researchSourceDomain(source)].filter(Boolean).join(' · ')
          : claim.sourceId;
        return (
          <li key={claim.id} className={styles.evidenceCard}>
            <p className={styles.evidenceClaim}>{claim.claim}</p>
            <div className={styles.confidenceRow}>
              <div className={styles.confidenceTrack}>
                <div className={styles.confidenceFill} style={{ width: `${percent}%` }} />
              </div>
              <span className={styles.confidenceValue}>{percent}%</span>
            </div>
            {claim.supportText ? (
              <blockquote className={styles.evidenceSupport}>{claim.supportText}</blockquote>
            ) : null}
            {claim.topicTags.length > 0 ? (
              <div className={styles.tagRow}>
                {claim.topicTags.map((tag) => (
                  <span key={tag} className={styles.tag}>
                    {tag}
                  </span>
                ))}
              </div>
            ) : null}
            {claim.caveats.length > 0 ? (
              <ul className={styles.caveatList}>
                {claim.caveats.map((caveat, caveatIndex) => (
                  <li key={caveatIndex}>{caveat}</li>
                ))}
              </ul>
            ) : null}
            {claim.sourceId ? (
              <button
                type="button"
                className={styles.evidenceSource}
                onClick={() => onNavigateToSource(claim.sourceId)}
                title="Jump to this source"
              >
                <ArrowUpRight size={11} />
                <span>{sourceLabel}</span>
              </button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
};
