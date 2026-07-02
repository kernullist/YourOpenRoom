import React, { useEffect, useRef, useState } from 'react';

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

// Renders a ```mermaid code block to an inline SVG. On any parse/render failure
// it falls back to the raw diagram source so the report is never blank.
const MermaidDiagram: React.FC<MermaidDiagramProps> = ({ code, className }) => {
  const [svg, setSvg] = useState('');
  const [failed, setFailed] = useState(false);
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
    <div
      className={className}
      data-testid="aoi-mermaid-diagram"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
};

export default MermaidDiagram;
