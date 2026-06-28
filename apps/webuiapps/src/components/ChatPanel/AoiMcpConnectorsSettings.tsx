import React, { useMemo, useRef, useState } from 'react';

import {
  summarizeAoiMcpConnectorsConfig,
  type AoiMcpConnectorEntry,
  type AoiMcpConnectorsConfig,
} from '@/lib/aoiMcpConnectorRegistry';
import { loadAoiMcpPluginAdmin, type AoiMcpPluginEntry } from '@/lib/aoiMcpPluginAdmin';
import {
  connectorEntriesToConfig,
  connectorHostStatus,
  createEmptyAoiMcpConnectorEntry,
  eligiblePluginAdminConnectorEntries,
  mergePluginAdminConnectors,
} from '@/lib/aoiMcpConnectorsSettingsModel';

import styles from './index.module.scss';

interface ConnectorDraft {
  key: string;
  entry: AoiMcpConnectorEntry;
}

export interface AoiMcpConnectorsSettingsProps {
  config: AoiMcpConnectorsConfig | null;
  onSave: (config: AoiMcpConnectorsConfig) => void;
  // Injectable so tests / non-browser callers can supply the plugin-admin list;
  // defaults to the localStorage source.
  loadPluginAdmin?: () => AoiMcpPluginEntry[];
}

// Trusted MCP Connectors editor for the chat settings tab. Manages the
// server-readable allow-list (PersistedConfig.aoiMcpConnectors) that authorizes a
// live read-only connector RPC, so the operator no longer hand-edits config.json.
// The endpoint is resolved server-side by id from this list; only allow-listed
// read-only tools (and gated resources/read) run live.
export const AoiMcpConnectorsSettings: React.FC<AoiMcpConnectorsSettingsProps> = ({
  config,
  onSave,
  loadPluginAdmin = loadAoiMcpPluginAdmin,
}) => {
  const keyRef = useRef(0);
  const makeKey = () => {
    keyRef.current += 1;
    return `connector-${keyRef.current}`;
  };
  const [drafts, setDrafts] = useState<ConnectorDraft[]>(() =>
    (config?.connectors ?? []).map((entry) => ({ key: makeKey(), entry })),
  );
  const [importNotice, setImportNotice] = useState('');

  const persist = (next: ConnectorDraft[]) => {
    onSave(connectorEntriesToConfig(next.map((draft) => draft.entry)));
  };
  const commit = (next: ConnectorDraft[]) => {
    setDrafts(next);
    persist(next);
  };

  const updateEntry = (key: string, patch: Partial<AoiMcpConnectorEntry>, persistNow: boolean) => {
    const next = drafts.map((draft) =>
      draft.key === key ? { ...draft, entry: { ...draft.entry, ...patch } } : draft,
    );
    if (persistNow) {
      commit(next);
    } else {
      setDrafts(next);
    }
  };

  const currentTools = (key: string): AoiMcpConnectorEntry['allowedTools'] =>
    drafts.find((draft) => draft.key === key)?.entry.allowedTools ?? [];
  const updateTools = (
    key: string,
    producer: (tools: AoiMcpConnectorEntry['allowedTools']) => AoiMcpConnectorEntry['allowedTools'],
    persistNow: boolean,
  ) => {
    updateEntry(key, { allowedTools: producer(currentTools(key)) }, persistNow);
  };

  const pluginAdmin = useMemo(() => loadPluginAdmin(), [loadPluginAdmin]);
  const eligibleImportCount = useMemo(() => {
    const present = new Set(
      drafts.map((draft) => connectorEntriesToConfig([draft.entry]).connectors[0]?.id),
    );
    return eligiblePluginAdminConnectorEntries(pluginAdmin).filter(
      (entry) => !present.has(entry.id),
    ).length;
  }, [drafts, pluginAdmin]);

  const summary = useMemo(
    () =>
      summarizeAoiMcpConnectorsConfig(connectorEntriesToConfig(drafts.map((draft) => draft.entry))),
    [drafts],
  );

  const handleAddConnector = () => {
    setImportNotice('');
    setDrafts((prev) => [...prev, { key: makeKey(), entry: createEmptyAoiMcpConnectorEntry() }]);
  };

  const handleRemoveConnector = (key: string) => {
    setImportNotice('');
    commit(drafts.filter((draft) => draft.key !== key));
  };

  const handleImport = () => {
    const existing = drafts.map((draft) => draft.entry);
    const { entries, importedCount } = mergePluginAdminConnectors(existing, pluginAdmin);
    if (importedCount === 0) {
      setImportNotice('No new trusted http(s) connectors to import.');
      return;
    }
    const imported = entries.slice(existing.length).map((entry) => ({ key: makeKey(), entry }));
    commit([...drafts, ...imported]);
    setImportNotice(`Imported ${importedCount} connector(s) from plugin admin.`);
  };

  return (
    <div className={styles.settingsSectionCard}>
      <div className={styles.settingsSectionTitle}>Trusted MCP Connectors</div>
      <span className={styles.modelHint}>
        Server-readable allow-list for Aoi live connector calls (MCP RPC). The endpoint is resolved
        by id from this list -- never from a proposal -- and only allow-listed read-only tools (plus
        gated resources/read) run live. {summary.total} connector(s), {summary.serverCallable}{' '}
        server-callable, {summary.readOnlyTools} read-only tool(s).
      </span>

      <div className={styles.connectorList}>
        {drafts.map((draft) => {
          const { key, entry } = draft;
          const host = connectorHostStatus(entry.endpointUrl, entry.allowPrivateHost);
          return (
            <div key={key} className={styles.connectorRow}>
              <div className={styles.connectorRowHeader}>
                <input
                  className={styles.fieldInput}
                  value={entry.name}
                  onChange={(event) => updateEntry(key, { name: event.target.value }, false)}
                  onBlur={() => persist(drafts)}
                  placeholder="Display name (e.g. Jira)"
                  aria-label="Connector name"
                />
                <button
                  type="button"
                  className={styles.connectorRemoveBtn}
                  onClick={() => handleRemoveConnector(key)}
                  title="Remove connector"
                >
                  Remove
                </button>
              </div>

              <div className={styles.field}>
                <label className={styles.label}>Endpoint URL</label>
                <input
                  className={styles.fieldInput}
                  value={entry.endpointUrl}
                  onChange={(event) => updateEntry(key, { endpointUrl: event.target.value }, false)}
                  onBlur={() => persist(drafts)}
                  placeholder="https://mcp.example.com/jira"
                  aria-label="Connector endpoint URL"
                />
                {host.state === 'ok' ? (
                  <span className={styles.connectorHostOk}>Resolves to host: {host.hostname}</span>
                ) : null}
                {host.state === 'error' ? (
                  <span className={styles.connectorHostError}>{host.message}</span>
                ) : null}
              </div>

              <div className={styles.connectorToggleRow}>
                <button
                  type="button"
                  className={`${styles.connectorToggle} ${entry.enabled ? styles.connectorToggleOn : ''}`}
                  onClick={() => updateEntry(key, { enabled: !entry.enabled }, true)}
                >
                  {entry.enabled ? 'Enabled' : 'Disabled'}
                </button>
                <button
                  type="button"
                  className={`${styles.connectorToggle} ${entry.trusted ? styles.connectorToggleOn : ''}`}
                  onClick={() => updateEntry(key, { trusted: !entry.trusted }, true)}
                  title="A connector must be trusted (and enabled) to be server-callable."
                >
                  {entry.trusted ? 'Trusted' : 'Untrusted'}
                </button>
                <button
                  type="button"
                  className={`${styles.connectorToggle} ${entry.allowReadResource ? styles.connectorToggleOn : ''}`}
                  onClick={() =>
                    updateEntry(key, { allowReadResource: !entry.allowReadResource }, true)
                  }
                  title="Permit the read-only resources/read RPC on this connector."
                >
                  {entry.allowReadResource ? 'resources/read: on' : 'resources/read: off'}
                </button>
                <button
                  type="button"
                  className={`${styles.connectorToggle} ${entry.allowPrivateHost ? styles.connectorToggleWarn : ''}`}
                  onClick={() =>
                    updateEntry(key, { allowPrivateHost: !entry.allowPrivateHost }, true)
                  }
                  title="Allow a private/loopback endpoint host (e.g. a local dev MCP). Off by default to prevent SSRF."
                >
                  {entry.allowPrivateHost ? 'Private host: allowed' : 'Private host: blocked'}
                </button>
              </div>

              <div className={styles.field}>
                <label className={styles.label}>
                  Allowed tools (only tools marked read-only run live)
                </label>
                <div className={styles.connectorToolList}>
                  {entry.allowedTools.map((tool, index) => (
                    <div key={`${key}-tool-${index}`} className={styles.connectorToolRow}>
                      <input
                        className={styles.fieldInput}
                        value={tool.name}
                        onChange={(event) =>
                          updateTools(
                            key,
                            (tools) =>
                              tools.map((item, itemIndex) =>
                                itemIndex === index ? { ...item, name: event.target.value } : item,
                              ),
                            false,
                          )
                        }
                        onBlur={() => persist(drafts)}
                        placeholder="tool_name (e.g. search_issues)"
                        aria-label="Tool name"
                      />
                      <button
                        type="button"
                        className={`${styles.connectorToggle} ${tool.readOnly ? styles.connectorToggleOn : styles.connectorToggleWarn}`}
                        onClick={() =>
                          updateTools(
                            key,
                            (tools) =>
                              tools.map((item, itemIndex) =>
                                itemIndex === index ? { ...item, readOnly: !item.readOnly } : item,
                              ),
                            true,
                          )
                        }
                        title="Read-only tools run live. Side-effecting tools are recognized but blocked from live RPC."
                      >
                        {tool.readOnly ? 'Read-only' : 'Side-effecting'}
                      </button>
                      <button
                        type="button"
                        className={styles.connectorRemoveBtn}
                        onClick={() =>
                          updateTools(
                            key,
                            (tools) => tools.filter((_, itemIndex) => itemIndex !== index),
                            true,
                          )
                        }
                        title="Remove tool"
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    className={styles.connectorInlineBtn}
                    onClick={() =>
                      updateTools(key, (tools) => [...tools, { name: '', readOnly: false }], false)
                    }
                  >
                    + Add tool
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className={styles.connectorActionRow}>
        <button type="button" className={styles.connectorInlineBtn} onClick={handleAddConnector}>
          + Add connector
        </button>
        <button
          type="button"
          className={styles.connectorInlineBtn}
          onClick={handleImport}
          disabled={eligibleImportCount === 0}
          title="Import trusted, enabled http(s) entries from the MCP/Plugin admin (tools start empty)."
        >
          Import from plugin admin ({eligibleImportCount})
        </button>
      </div>
      {importNotice ? <span className={styles.modelHint}>{importNotice}</span> : null}
    </div>
  );
};
