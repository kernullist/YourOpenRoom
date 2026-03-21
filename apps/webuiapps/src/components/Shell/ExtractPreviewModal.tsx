import React, { useState, useCallback, useEffect, useRef } from 'react';
import { X, Zap } from 'lucide-react';
import type { Manifest, AppEntry } from '@/lib';
import styles from './ExtractPreviewModal.module.scss';

interface ExtractPreviewModalProps {
  manifest: Manifest;
  generating: boolean;
  modGenerating: boolean;
  genProgress: Record<string, { status: string; name: string; message?: string }>;
  onGenerateApp: (app: AppEntry) => void;
  onConfirm: (selectedApps: AppEntry[]) => void;
  onCancel: () => void;
}

const ExtractPreviewModal: React.FC<ExtractPreviewModalProps> = ({
  manifest,
  generating,
  modGenerating,
  genProgress,
  onGenerateApp,
  onConfirm,
  onCancel,
}) => {
  const { apps, character } = manifest;
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set(apps.map((a) => a.id)));

  // Keep selectedIds in sync when app IDs change (e.g. after summarize renames them)
  const prevAppIdsRef = useRef<string[]>(apps.map((a) => a.id));
  useEffect(() => {
    const prevIds = prevAppIdsRef.current;
    const currIds = apps.map((a) => a.id);
    if (prevIds.length === currIds.length) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (let i = 0; i < prevIds.length; i++) {
          if (prevIds[i] !== currIds[i] && next.has(prevIds[i])) {
            next.delete(prevIds[i]);
            next.add(currIds[i]);
          }
        }
        return next;
      });
    }
    prevAppIdsRef.current = currIds;
  }, [apps]);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const selectedApps = apps.filter((a) => selectedIds.has(a.id));

  return (
    <div className={styles.overlay} onClick={onCancel}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className={styles.header}>
          <span>Card Analysis Result</span>
          <button className={styles.closeBtn} onClick={onCancel}>
            <X size={16} />
          </button>
        </div>

        <div className={styles.body}>
          {/* Apps section */}
          {apps.length > 0 && (
            <div className={styles.section}>
              <h3 className={styles.sectionTitle}>
                Apps ({selectedApps.length}/{apps.length})
              </h3>
              <div className={styles.appList}>
                {apps.map((app) => {
                  const progress = genProgress[app.id];
                  const appStatus = progress?.status;
                  return (
                    <div
                      key={app.id}
                      className={`${styles.appCard} ${selectedIds.has(app.id) ? styles.selected : styles.unselected}`}
                      onClick={() => !generating && toggleSelect(app.id)}
                    >
                      <div className={styles.appHeader}>
                        <div className={styles.appInfo}>
                          <span
                            className={`${styles.checkbox} ${selectedIds.has(app.id) ? styles.checked : ''}`}
                          />
                          <span className={styles.appName}>{app.name}</span>
                          <span className={styles.appId}>{app.id}</span>
                        </div>
                        <button
                          className={`${styles.genBtn} ${appStatus === 'completed' ? styles.done : ''} ${appStatus === 'generating' || appStatus === 'summarizing' ? styles.busy : ''}`}
                          disabled={generating || appStatus === 'completed'}
                          onClick={(e) => {
                            e.stopPropagation();
                            onGenerateApp(app);
                          }}
                        >
                          {appStatus === 'generating' || appStatus === 'summarizing' ? (
                            'Generating...'
                          ) : appStatus === 'completed' ? (
                            'Done'
                          ) : appStatus === 'error' ? (
                            'Retry'
                          ) : (
                            <>
                              <Zap size={12} /> Generate
                            </>
                          )}
                        </button>
                      </div>

                      {app.format && app.format.length > 20 && (
                        <p className={styles.appScenario}>{app.format}</p>
                      )}

                      {app.keywords.length > 0 && (
                        <div className={styles.appMeta}>
                          <span className={styles.metaLabel}>Keywords</span>
                          <div className={styles.tagList}>
                            {app.keywords.map((kw, i) => (
                              <span key={i} className={styles.tag}>
                                {kw}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}

                      {app.tags.length > 0 && (
                        <div className={styles.appMeta}>
                          <span className={styles.metaLabel}>Features</span>
                          <div className={styles.featureList}>
                            {app.tags
                              .filter((t) => t.description)
                              .map((t, i) => (
                                <span key={i} className={styles.feature}>
                                  {t.name}: {t.description}
                                </span>
                              ))}
                          </div>
                        </div>
                      )}

                      {progress?.status === 'error' && progress.message && (
                        <p className={styles.errorMsg}>{progress.message}</p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Character section */}
          <div className={styles.section}>
            <h3 className={styles.sectionTitle}>Character</h3>
            <div className={styles.charCard}>
              {character.name && (
                <div className={styles.charField}>
                  <span className={styles.charLabel}>Name</span>
                  <span className={styles.charValue}>{character.name}</span>
                </div>
              )}
              {character.description && (
                <div className={styles.charField}>
                  <span className={styles.charLabel}>Description</span>
                  <p className={styles.charText}>{character.description}</p>
                </div>
              )}
              {character.firstMessage && (
                <div className={styles.charField}>
                  <span className={styles.charLabel}>First Message</span>
                  <p className={styles.charText}>{character.firstMessage}</p>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className={styles.footer}>
          <button
            className={styles.cancelBtn}
            onClick={onCancel}
            disabled={generating || modGenerating}
          >
            Cancel
          </button>
          <button
            className={styles.confirmBtn}
            onClick={() => onConfirm(selectedApps)}
            disabled={generating || modGenerating}
          >
            {modGenerating
              ? 'Generating Mod...'
              : generating
                ? 'Generating...'
                : selectedApps.length === 0
                  ? 'Generate Mod Only'
                  : `Generate${selectedApps.length < apps.length ? ` (${selectedApps.length})` : ' All'}`}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ExtractPreviewModal;
