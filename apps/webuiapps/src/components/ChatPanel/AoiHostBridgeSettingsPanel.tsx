import React, { useCallback, useEffect, useState } from 'react';
import { RotateCcw, Trash2, Check } from 'lucide-react';

import {
  fetchAoiHostBridgeStatus,
  setAoiHostBridgeKillSwitch,
  fetchAoiHostSpawnAllowlist,
  addAoiHostSpawnAllowlistEntry,
  removeAoiHostSpawnAllowlistEntry,
  fetchAoiHostRoots,
  addAoiHostRoot,
  removeAoiHostRoot,
  fetchAoiHostApprovals,
  approveAoiHostApproval,
  type AoiHostBridgeStatus,
  type AoiHostSpawnAllowlistEntryView,
  type AoiHostRootView,
  type AoiHostBridgeApprovalView,
  type AoiHostRootKind,
} from '@/lib/aoiHostBridgeClient';
import { listAoiHostReadRootPresets, listAoiHostSpawnPresets } from '@/lib/aoiHostBridgePresets';

import styles from './index.module.scss';

// The kill-switch capability keys the daemon recognizes, with operator-facing
// labels. Kept in sync with the *_CAPABILITY constants (server-only, so not
// imported here). Enabling one is the MACHINE-level master switch; a capability
// still needs its per-session consent + (for irreversible ops) an approval.
const CAPABILITIES: { key: string; label: string; hint: string }[] = [
  {
    key: 'process_activity',
    label: 'Process list',
    hint: 'Read running-process metadata (no command line)',
  },
  {
    key: 'desktop_activity',
    label: 'Desktop activity',
    hint: 'Learn interests from foreground app usage',
  },
  { key: 'os_process_spawn', label: 'Start process', hint: 'Launch an allowlisted executable' },
  { key: 'os_file_read', label: 'Read files', hint: 'Read within registered read-roots' },
  { key: 'os_file_write', label: 'Write files', hint: 'Write within registered write-roots' },
  {
    key: 'os_process_kill',
    label: 'Kill process',
    hint: 'Terminate a process (protected list enforced)',
  },
  { key: 'os_file_delete', label: 'Delete files', hint: 'Send a file to the Recycle Bin' },
];

interface RootDraft {
  id: string;
  path: string;
  label: string;
}

interface SpawnDraft {
  id: string;
  path: string;
  label: string;
  match: 'file' | 'directory';
}

const EMPTY_DRAFT: RootDraft = { id: '', path: '', label: '' };
const EMPTY_SPAWN_DRAFT: SpawnDraft = { id: '', path: '', label: '', match: 'file' };

// Operator-only settings surface for the host-bridge (Aoi's real-PC access). It
// is the machine-level control panel: the kill-switch master toggles + panic,
// the spawn allowlist, the read/write roots, and the pending-approval queue.
// Everything here is fail-closed on the daemon; this panel just drives it.
export const AoiHostBridgeSettingsPanel: React.FC = () => {
  const [status, setStatus] = useState<AoiHostBridgeStatus | null>(null);
  const [spawnEntries, setSpawnEntries] = useState<AoiHostSpawnAllowlistEntryView[]>([]);
  const [readRoots, setReadRoots] = useState<AoiHostRootView[]>([]);
  const [writeRoots, setWriteRoots] = useState<AoiHostRootView[]>([]);
  const [approvals, setApprovals] = useState<AoiHostBridgeApprovalView[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  const [spawnDraft, setSpawnDraft] = useState<SpawnDraft>(EMPTY_SPAWN_DRAFT);
  const [readDraft, setReadDraft] = useState<RootDraft>(EMPTY_DRAFT);
  const [writeDraft, setWriteDraft] = useState<RootDraft>(EMPTY_DRAFT);
  const readPresets = listAoiHostReadRootPresets();
  const spawnPresets = listAoiHostSpawnPresets();

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [nextStatus, spawn, read, write, pending] = await Promise.all([
        fetchAoiHostBridgeStatus(),
        fetchAoiHostSpawnAllowlist(),
        fetchAoiHostRoots('read'),
        fetchAoiHostRoots('write'),
        fetchAoiHostApprovals(),
      ]);
      setStatus(nextStatus);
      setSpawnEntries(spawn);
      setReadRoots(read);
      setWriteRoots(write);
      setApprovals(pending);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const runAction = useCallback(async (actionId: string, fn: () => Promise<void>) => {
    setBusy(actionId);
    setError('');
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  }, []);

  const panic = status?.killSwitch.globalPanic ?? false;
  const enabled = new Set(status?.killSwitch.enabledCapabilities ?? []);

  const toggleCapability = (key: string, next: boolean) =>
    void runAction(`cap:${key}`, async () => {
      const killSwitch = await setAoiHostBridgeKillSwitch('set', {
        capability: key,
        enabled: next,
      });
      setStatus((prev) => (prev ? { ...prev, killSwitch } : prev));
    });

  const setPanic = (engage: boolean) =>
    void runAction('panic', async () => {
      const killSwitch = await setAoiHostBridgeKillSwitch(engage ? 'panic' : 'clear_panic');
      setStatus((prev) => (prev ? { ...prev, killSwitch } : prev));
    });

  const addSpawn = () =>
    void runAction('spawn:add', async () => {
      const entries = await addAoiHostSpawnAllowlistEntry({
        ...(spawnDraft.id.trim() ? { id: spawnDraft.id.trim() } : {}),
        path: spawnDraft.path.trim(),
        match: spawnDraft.match,
        ...(spawnDraft.label.trim() ? { label: spawnDraft.label.trim() } : {}),
      });
      setSpawnEntries(entries);
      setSpawnDraft(EMPTY_SPAWN_DRAFT);
    });

  const addSpawnPreset = (preset: { id: string; path: string; label: string; kind: string }) =>
    void runAction(`spawn:preset:${preset.id}`, async () => {
      const entries = await addAoiHostSpawnAllowlistEntry({
        id: preset.id,
        path: preset.path,
        label: preset.label,
        match: preset.kind === 'directory' ? 'directory' : 'file',
      });
      setSpawnEntries(entries);
    });

  const removeSpawn = (id: string) =>
    void runAction(`spawn:del:${id}`, async () => {
      setSpawnEntries(await removeAoiHostSpawnAllowlistEntry(id));
    });

  const addRoot = (kind: AoiHostRootKind, draft: RootDraft, reset: () => void) =>
    void runAction(`root:add:${kind}`, async () => {
      const roots = await addAoiHostRoot(kind, {
        ...(draft.id.trim() ? { id: draft.id.trim() } : {}),
        path: draft.path.trim(),
        ...(draft.label.trim() ? { label: draft.label.trim() } : {}),
      });
      if (kind === 'read') {
        setReadRoots(roots);
      } else {
        setWriteRoots(roots);
      }
      reset();
    });

  const addRootPreset = (
    kind: AoiHostRootKind,
    preset: { id: string; path: string; label: string },
  ) =>
    void runAction(`root:preset:${kind}:${preset.id}`, async () => {
      const roots = await addAoiHostRoot(kind, {
        id: preset.id,
        path: preset.path,
        label: preset.label,
      });
      if (kind === 'read') {
        setReadRoots(roots);
      } else {
        setWriteRoots(roots);
      }
    });

  const removeRoot = (kind: AoiHostRootKind, id: string) =>
    void runAction(`root:del:${kind}:${id}`, async () => {
      const roots = await removeAoiHostRoot(kind, id);
      if (kind === 'read') {
        setReadRoots(roots);
      } else {
        setWriteRoots(roots);
      }
    });

  const approve = (fingerprint: string) =>
    void runAction(`approve:${fingerprint}`, async () => {
      await approveAoiHostApproval(fingerprint);
      setApprovals(await fetchAoiHostApprovals());
    });

  const renderRootsSection = (
    kind: AoiHostRootKind,
    title: string,
    roots: AoiHostRootView[],
    draft: RootDraft,
    setDraft: React.Dispatch<React.SetStateAction<RootDraft>>,
  ) => (
    <div className={styles.connectorRow} data-testid={`aoi-host-${kind}-roots`}>
      <div className={styles.connectorRowHeader}>
        <strong>{title}</strong>
        <span className={styles.modelHint}>{roots.length} registered</span>
      </div>
      <span className={styles.modelHint}>
        One-click presets or paste any absolute folder. Id is optional (auto from path).
      </span>
      <div className={styles.connectorToggleRow}>
        {readPresets.map((preset) => (
          <button
            key={`${kind}-${preset.id}`}
            type="button"
            className={styles.inlineActionBtn}
            onClick={() => addRootPreset(kind, preset)}
            disabled={busy === `root:preset:${kind}:${preset.id}`}
            data-testid={`aoi-host-${kind}-preset-${preset.id}`}
          >
            + {preset.label}
          </button>
        ))}
      </div>
      {roots.map((root) => (
        <div key={root.id} className={styles.connectorToggleRow}>
          <span className={styles.modelHint}>
            {root.label ? `${root.label} · ` : ''}
            {root.path}
          </span>
          <button
            type="button"
            className={styles.cancelBtn}
            onClick={() => removeRoot(kind, root.id)}
            disabled={busy === `root:del:${kind}:${root.id}`}
            title="Remove this root"
          >
            <Trash2 size={13} />
          </button>
        </div>
      ))}
      <div className={styles.connectorToggleRow}>
        <input
          className={styles.fieldInput}
          value={draft.path}
          onChange={(event) => setDraft((prev) => ({ ...prev, path: event.target.value }))}
          placeholder="absolute folder path (id auto)"
          aria-label={`${title} path`}
        />
        <button
          type="button"
          className={styles.saveBtn}
          onClick={() => addRoot(kind, draft, () => setDraft(EMPTY_DRAFT))}
          disabled={!draft.path.trim() || busy === `root:add:${kind}`}
        >
          Add
        </button>
      </div>
    </div>
  );

  return (
    <div className={styles.settingsSectionCard} data-testid="aoi-host-bridge-panel">
      <div className={styles.settingsSectionHeader}>
        <div>
          <div className={styles.settingsSectionTitle}>Aoi Host Access</div>
          <span className={styles.modelHint}>
            Machine-level control for Aoi&apos;s real-PC access. Every capability is off until you
            enable it here; irreversible actions still require a per-action approval below.
          </span>
        </div>
        <button
          type="button"
          className={styles.inlineActionBtn}
          onClick={() => void loadAll()}
          disabled={loading}
          title="Refresh host-bridge state"
        >
          <RotateCcw size={14} />
          Refresh
        </button>
      </div>

      {error ? <div className={styles.aoiAutonomyError}>{error}</div> : null}
      {loading ? <span className={styles.modelHint}>Loading host-bridge state...</span> : null}

      {status ? (
        <>
          {!status.tokenConfigured ? (
            <div className={styles.aoiAutonomyError} data-testid="aoi-host-no-token">
              The daemon has not minted its auth token yet. Rebuild + restart the daemon (pnpm
              daemon:build) so the host-bridge routes come online.
            </div>
          ) : null}

          {/* Kill switch */}
          <div className={styles.connectorList}>
            <div className={styles.connectorRow}>
              <div className={styles.connectorRowHeader}>
                <strong>Master kill switch</strong>
                <span className={styles.modelHint}>
                  {panic ? 'PANIC ENGAGED — everything blocked' : 'Per-capability control'}
                </span>
              </div>
              <div className={styles.connectorToggleRow}>
                <button
                  type="button"
                  className={panic ? styles.saveBtn : styles.cancelBtn}
                  onClick={() => setPanic(!panic)}
                  disabled={busy === 'panic'}
                  data-testid="aoi-host-panic"
                >
                  {panic ? 'Clear panic' : 'Panic (block all)'}
                </button>
              </div>
              {CAPABILITIES.map((capability) => (
                <div key={capability.key} className={styles.connectorToggleRow}>
                  <span className={styles.modelHint}>
                    <strong>{capability.label}</strong> · {capability.hint}
                  </span>
                  <button
                    type="button"
                    className={enabled.has(capability.key) ? styles.saveBtn : styles.cancelBtn}
                    onClick={() => toggleCapability(capability.key, !enabled.has(capability.key))}
                    disabled={panic || busy === `cap:${capability.key}`}
                    data-testid={`aoi-host-cap-${capability.key}`}
                  >
                    {enabled.has(capability.key) ? 'Enabled' : 'Disabled'}
                  </button>
                </div>
              ))}
            </div>

            {/* Spawn allowlist */}
            <div className={styles.connectorRow} data-testid="aoi-host-spawn-allowlist">
              <div className={styles.connectorRowHeader}>
                <strong>Spawn allowlist</strong>
                <span className={styles.modelHint}>{spawnEntries.length} registered</span>
              </div>
              <span className={styles.modelHint}>
                Register a single .exe, or a folder so any .exe under it is allowed. Id is optional.
                Capability kill-switch + per-action approval still required.
              </span>
              <div className={styles.connectorToggleRow}>
                {spawnPresets.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    className={styles.inlineActionBtn}
                    onClick={() => addSpawnPreset(preset)}
                    disabled={busy === `spawn:preset:${preset.id}`}
                    data-testid={`aoi-host-spawn-preset-${preset.id}`}
                  >
                    + {preset.label}
                  </button>
                ))}
              </div>
              {spawnEntries.map((entry) => (
                <div key={entry.id} className={styles.connectorToggleRow}>
                  <span className={styles.modelHint}>
                    [{entry.match === 'directory' ? 'dir' : 'file'}]{' '}
                    {entry.label ? `${entry.label} · ` : ''}
                    {entry.path}
                  </span>
                  <button
                    type="button"
                    className={styles.cancelBtn}
                    onClick={() => removeSpawn(entry.id)}
                    disabled={busy === `spawn:del:${entry.id}`}
                    title="Remove this entry"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
              <div className={styles.connectorToggleRow}>
                <input
                  className={styles.fieldInput}
                  value={spawnDraft.path}
                  onChange={(event) =>
                    setSpawnDraft((prev) => ({ ...prev, path: event.target.value }))
                  }
                  placeholder="absolute exe or folder path"
                  aria-label="Spawn entry path"
                />
                <button
                  type="button"
                  className={spawnDraft.match === 'directory' ? styles.saveBtn : styles.cancelBtn}
                  onClick={() =>
                    setSpawnDraft((prev) => ({
                      ...prev,
                      match: prev.match === 'directory' ? 'file' : 'directory',
                    }))
                  }
                  title="Toggle file vs directory allow"
                  data-testid="aoi-host-spawn-match-toggle"
                >
                  {spawnDraft.match === 'directory' ? 'Directory' : 'File'}
                </button>
                <button
                  type="button"
                  className={styles.saveBtn}
                  onClick={addSpawn}
                  disabled={!spawnDraft.path.trim() || busy === 'spawn:add'}
                >
                  Add
                </button>
              </div>
            </div>

            {renderRootsSection('read', 'Read roots', readRoots, readDraft, setReadDraft)}
            {renderRootsSection('write', 'Write roots', writeRoots, writeDraft, setWriteDraft)}

            {/* Approvals */}
            <div className={styles.connectorRow} data-testid="aoi-host-approvals">
              <div className={styles.connectorRowHeader}>
                <strong>Pending approvals</strong>
                <span className={styles.modelHint}>{approvals.length} waiting</span>
              </div>
              {approvals.length === 0 ? (
                <span className={styles.modelHint}>No pending approvals.</span>
              ) : (
                approvals.map((entry) => (
                  <div key={entry.id} className={styles.connectorToggleRow}>
                    <span className={styles.modelHint}>
                      <strong>{entry.capability}</strong> · {entry.targetSummary}
                    </span>
                    <button
                      type="button"
                      className={styles.saveBtn}
                      onClick={() => approve(entry.approvalFingerprint)}
                      disabled={busy === `approve:${entry.approvalFingerprint}`}
                      title="Approve this single, time-bounded action"
                    >
                      <Check size={13} />
                      Approve
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
};
