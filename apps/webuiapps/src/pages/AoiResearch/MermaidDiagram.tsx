import React, { useEffect, useRef, useState } from 'react';
import { Maximize2, X } from 'lucide-react';
import styles from './index.module.scss';

// Mermaid is heavy, so it is loaded on demand the first time a report actually
// contains a diagram. The module is initialized once with a dark, strict-security
// profile (strict blocks any script/HTML injected through diagram text).
let mermaidLoader: Promise<typeof import('mermaid').default> | null = null;

function loadMermaid(): Promise<typeof import('mermaid').default> {
  if (!mermaidLoader) {
    mermaidLoader = import('mermaid').then((module) => {
      const mermaid = module.default;
      mermaid.initialize({
        startOnLoad: false,
        theme: 'dark',
        securityLevel: 'strict',
        fontFamily: 'inherit',
      });
      return mermaid;
    });
  }
  return mermaidLoader;
}

// Module-scoped counter for the unique element id mermaid.render requires.
let diagramSequence = 0;

interface MermaidDiagramProps {
  code: string;
  className?: string;
}

// Renders a ```mermaid code block to an inline SVG. Click (or Enter/Space) opens
// an enlarged overlay. On any parse/render failure it falls back to the raw
// diagram source so the report is never blank.
const MermaidDiagram: React.FC<MermaidDiagramProps> = ({ code, className }) => {
  const [svg, setSvg] = useState('');
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const idRef = useRef('');
  if (!idRef.current) {
    diagramSequence += 1;
    idRef.current = `aoi-mermaid-${diagramSequence}`;
  }

  useEffect(() => {
    let cancelled = false;
    setSvg('');
    setFailed(false);
    const trimmed = code.trim();
    if (!trimmed) {
      return undefined;
    }
    void (async () => {
      try {
        const mermaid = await loadMermaid();
        const { svg: rendered } = await mermaid.render(idRef.current, trimmed);
        if (!cancelled) {
          setSvg(rendered);
        }
      } catch {
        if (!cancelled) {
          setFailed(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code]);

  // Close the expanded overlay on Escape.
  useEffect(() => {
    if (!expanded) {
      return undefined;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setExpanded(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [expanded]);

  if (failed) {
    return (
      <pre className={className} data-testid="aoi-mermaid-error">
        {code}
      </pre>
    );
  }
  if (!svg) {
    return (
      <div className={className} data-testid="aoi-mermaid-pending">
        Rendering diagram...
      </div>
    );
  }
  return (
    <>
      <div
        className={className}
        data-testid="aoi-mermaid-diagram"
        role="button"
        tabIndex={0}
        title="Click to enlarge"
        onClick={() => setExpanded(true)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setExpanded(true);
          }
        }}
      >
        <span className={styles.mermaidExpandHint} aria-hidden="true">
          <Maximize2 size={13} />
        </span>
        <div dangerouslySetInnerHTML={{ __html: svg }} />
      </div>
      {expanded ? (
        <div
          className={styles.mermaidOverlay}
          role="dialog"
          aria-modal="true"
          data-testid="aoi-mermaid-overlay"
          onClick={() => setExpanded(false)}
        >
          <button
            type="button"
            className={styles.mermaidOverlayClose}
            onClick={() => setExpanded(false)}
            title="Close (Esc)"
          >
            <X size={18} />
          </button>
          <div
            className={styles.mermaidOverlayInner}
            onClick={(event) => event.stopPropagation()}
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        </div>
      ) : null}
    </>
  );
};

export default MermaidDiagram;
