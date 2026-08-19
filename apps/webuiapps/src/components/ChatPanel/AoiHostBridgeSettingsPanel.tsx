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
  approveAndExecuteAoiHostApproval,
  fetchAoiBrowserDriveAllowlist,
  addAoiBrowserDriveAllowlistDomain,
  removeAoiBrowserDriveAllowlistDomain,
  fetchAoiBrowserDriveStandingGrants,
  addAoiBrowserDriveStandingGrant,
  removeAoiBrowserDriveStandingGrant,
  fetchAoiBrowserDriveAudit,
  fetchAoiBrowserDriveProfile,
  setAoiBrowserDriveProfile,
  type AoiHostBridgeStatus,
  type AoiHostSpawnAllowlistEntryView,
  type AoiHostRootView,
  type AoiHostBridgeApprovalView,
  type AoiHostRootKind,
  type AoiBrowserDriveAllowlistEntryView,
  type AoiBrowserDriveStandingGrantView,
  type AoiBrowserDriveAuditEntryView,
  type AoiBrowserDriveProfileView,
} from '@/lib/aoiHostBridgeClient';
import {
  AOI_HOST_BRIDGE_CONSENT_LINKS,
  buildAoiHostBridgeLinkedSourcePatch,
  getAoiHostBridgeConsentLink,
} from '@/lib/aoiHostBridgeConsent';
import { listAoiHostReadRootPresets, listAoiHostSpawnPresets } from '@/lib/aoiHostBridgePresets';
import { updateAoiEnvironmentSource } from '@/lib/aoiAutonomyClient';

import styles from './index.module.scss';

// The kill-switch capability keys the daemon recognizes, with operator-facing
// labels. Kept in sync with the *_CAPABILITY constants (server-only, so not
// imported here). Enabling one is the MACHINE-level master switch; process /
// desktop list also need per-session environment-source consent (auto-synced
// from this panel when sessionPath is provided). Irreversible ops still need
// per-action approval.
// NOTE: the daemon reports EFFECTIVE enablement, so a capability that is on by
// default and untouched arrives in enabledCapabilities like any other. This
// panel therefore needs no default table of its own -- and must not grow one,
// or the two would drift and the switch would stop describing the machine.

const CAPABILITIES: { key: string; label: string; hint: string }[] = [
  {
    key: 'process_activity',
    label: 'Process list',
    hint: 'Read running-process metadata (no command line). Also grants session process-activity consent.',
  },
  {
    key: 'desktop_activity',
    label: 'Desktop activity',
    hint: 'Learn interests from foreground app usage. Also grants session desktop-activity consent.',
  },
  {
    key: 'screen_vision',
    label: 'Screen vision',
    hint: 'Redacted summary of the FOCUSED window via a local vision model. Also grants screen-vision consent. Pixels are never persisted and never leave the local process.',
  },
  {
    key: 'os_browser_read',
    label: 'Headless browser read',
    hint: 'Open public pages with local Chrome/Edge headless and extract text. Also grants host-browser-read consent.',
  },
  {
    key: 'os_computer_use',
    label: 'Computer use (drive my PC and browser)',
    hint: 'ON BY DEFAULT. The single switch for everything Aoi does with the machine: reading and driving app windows through Windows UI Automation, taking a numbered picture of a window, and acting on your own logged-in Chrome/Edge. Turning it off stops all of it at once. What it does NOT relax: credential fields and CAPTCHAs are never touched, payments are never committed, browser interactions still need per-action approval, and an action that cannot be proven is reported as unproven rather than done. The three switches below stay off unless you turn them on.',
  },
  {
    key: 'os_desktop_input_foreground',
    label: 'Computer use: synthetic mouse and keyboard',
    hint: 'HIGH RISK, off by default. Lets Aoi take the foreground and move your REAL cursor when a control cannot be driven any other way. It interrupts whatever you are doing, and nothing can verify where the click landed, so it is always reported as unproven. Leave off to keep Aoi on the paths that can prove what they did.',
  },
  {
    key: 'os_browser_drive_standing',
    label: 'Computer use: browser standing approval',
    hint: 'HIGH RISK, off by default. While ON, an active standing grant lets Aoi act on its domain WITHOUT approving each action, up to the grant TTL and quota. Add grants under Standing grants. Panic and this switch disable it instantly; forbidden actions and the domain denylist still apply.',
  },
  {
    key: 'os_browser_drive_task',
    label: 'Computer use: autonomous browser tasks',
    hint: 'HIGHEST RISK, off by default. While ON, Aoi may run a bounded multi-act browser task you asked for (<=10 acts / <=40 steps, fail-stop). Each act still needs a standing grant or per-action approval. Leave off unless you want multi-step browser work running unattended.',
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

interface AoiHostBridgeSettingsPanelProps {
  // Active Aoi session path. Required to auto-sync process/desktop environment
  // source consent when the machine kill-switch is toggled.
  sessionPath?: string;
}

// Operator-only settings surface for the host-bridge (Aoi's real-PC access). It
// is the machine-level control panel: the kill-switch master toggles + panic,
// the spawn allowlist, the read/write roots, and the pending-approval queue.
// Everything here is fail-closed on the daemon; this panel just drives it.
export const AoiHostBridgeSettingsPanel: React.FC<AoiHostBridgeSettingsPanelProps> = ({
  sessionPath = '',
}) => {
  const [status, setStatus] = useState<AoiHostBridgeStatus | null>(null);
  const [spawnEntries, setSpawnEntries] = useState<AoiHostSpawnAllowlistEntryView[]>([]);
  const [readRoots, setReadRoots] = useState<AoiHostRootView[]>([]);
  const [writeRoots, setWriteRoots] = useState<AoiHostRootView[]>([]);
  const [approvals, setApprovals] = useState<AoiHostBridgeApprovalView[]>([]);
  const [browserDriveEntries, setBrowserDriveEntries] = useState<
    AoiBrowserDriveAllowlistEntryView[]
  >([]);
  const [browserDriveDraft, setBrowserDriveDraft] = useState({ domain: '', label: '' });
  const [standingGrants, setStandingGrants] = useState<AoiBrowserDriveStandingGrantView[]>([]);
  const [standingDraft, setStandingDraft] = useState({
    domain: '',
    ttlMin: '30',
    maxActions: '20',
  });
  const [auditEntries, setAuditEntries] = useState<AoiBrowserDriveAuditEntryView[]>([]);
  const [driveProfile, setDriveProfile] = useState<AoiBrowserDriveProfileView | null>(null);
  const [driveProfileDraft, setDriveProfileDraft] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [consentNote, setConsentNote] = useState('');

  const [spawnDraft, setSpawnDraft] = useState<SpawnDraft>(EMPTY_SPAWN_DRAFT);
  const [readDraft, setReadDraft] = useState<RootDraft>(EMPTY_DRAFT);
  const [writeDraft, setWriteDraft] = useState<RootDraft>(EMPTY_DRAFT);
  // Keep Host PC controls short: one role group visible at a time.
  const [hostSection, setHostSection] = useState<
    'capabilities' | 'spawn' | 'roots' | 'approvals' | 'browserDrive' | 'standing' | 'activity'
  >('capabilities');
  const readPresets = listAoiHostReadRootPresets();
  const spawnPresets = listAoiHostSpawnPresets();
  const HOST_SECTIONS: Array<{
    id: 'capabilities' | 'spawn' | 'roots' | 'approvals' | 'browserDrive' | 'standing' | 'activity';
    label: string;
  }> = [
    { id: 'capabilities', label: 'Capabilities' },
    { id: 'spawn', label: 'Spawn' },
    { id: 'roots', label: 'File roots' },
    { id: 'browserDrive', label: 'Browser denylist' },
    { id: 'standing', label: 'Standing grants' },
    { id: 'activity', label: 'Activity' },
    { id: 'approvals', label: 'Approvals' },
  ];

  const syncLinkedSessionConsent = useCallback(
    async (capabilityKey: string, enabled: boolean) => {
      const link = getAoiHostBridgeConsentLink(capabilityKey);
      const path = sessionPath.trim();
      if (!link || !path) {
        return;
      }
      await updateAoiEnvironmentSource(path, {
        sourceId: link.sourceId,
        patch: buildAoiHostBridgeLinkedSourcePatch(link, enabled),
      });
      setConsentNote(
        enabled
          ? `Session consent granted for ${link.sourceId} (${path}).`
          : `Session consent cleared for ${link.sourceId} (${path}).`,
      );
    },
    [sessionPath],
  );

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [nextStatus, spawn, read, write, pending, driveAllow, grants, audit] =
        await Promise.all([
          fetchAoiHostBridgeStatus(),
          fetchAoiHostSpawnAllowlist(),
          fetchAoiHostRoots('read'),
          fetchAoiHostRoots('write'),
          fetchAoiHostApprovals(),
          fetchAoiBrowserDriveAllowlist(),
          fetchAoiBrowserDriveStandingGrants(),
          fetchAoiBrowserDriveAudit(),
        ]);
      setStatus(nextStatus);
      setSpawnEntries(spawn);
      setReadRoots(read);
      setWriteRoots(write);
      setApprovals(pending);
      setBrowserDriveEntries(driveAllow);
      setStandingGrants(grants);
      setAuditEntries(audit);

      // Repair footgun: capability already ON but session consent never granted.
      try {
        const profile = await fetchAoiBrowserDriveProfile();
        setDriveProfile(profile);
        setDriveProfileDraft(profile.userDataDir);
      } catch {
        // The panel still works without it; the browser-drive section says so.
        setDriveProfile(null);
      }
      const enabledKeys = new Set(nextStatus.killSwitch.enabledCapabilities);
      const path = sessionPath.trim();
      if (path && !nextStatus.killSwitch.globalPanic) {
        const repaired: string[] = [];
        for (const link of AOI_HOST_BRIDGE_CONSENT_LINKS) {
          if (!enabledKeys.has(link.capabilityKey)) {
            continue;
          }
          try {
            await updateAoiEnvironmentSource(path, {
              sourceId: link.sourceId,
              patch: buildAoiHostBridgeLinkedSourcePatch(link, true),
            });
            repaired.push(link.sourceId);
          } catch {
            // Autonomy route may be unavailable; kill-switch still reflects truth.
          }
        }
        if (repaired.length > 0) {
          setConsentNote(`Synced session consent: ${repaired.join(', ')} (${path}).`);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [sessionPath]);

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
      try {
        await syncLinkedSessionConsent(key, next);
      } catch (err) {
        // Kill-switch succeeded; surface consent failure separately so the
        // operator knows chat tools may still be blocked.
        const message = err instanceof Error ? err.message : String(err);
        setError(
          `Capability ${key} is ${next ? 'enabled' : 'disabled'}, but session consent sync failed: ${message}`,
        );
      }
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

  const addBrowserDriveDomain = () =>
    void runAction('drive:add', async () => {
      const entries = await addAoiBrowserDriveAllowlistDomain({
        domain: browserDriveDraft.domain.trim(),
        ...(browserDriveDraft.label.trim() ? { label: browserDriveDraft.label.trim() } : {}),
      });
      setBrowserDriveEntries(entries);
      setBrowserDriveDraft({ domain: '', label: '' });
    });

  const removeBrowserDriveDomain = (id: string) =>
    void runAction(`drive:del:${id}`, async () => {
      setBrowserDriveEntries(await removeAoiBrowserDriveAllowlistDomain(id));
    });

  const addStandingGrant = () =>
    void runAction('standing:add', async () => {
      const ttlMin = Number.parseFloat(standingDraft.ttlMin);
      const maxActions = Number.parseInt(standingDraft.maxActions, 10);
      const grants = await addAoiBrowserDriveStandingGrant({
        domain: standingDraft.domain.trim(),
        ...(Number.isFinite(ttlMin) && ttlMin > 0 ? { ttlMs: Math.round(ttlMin * 60_000) } : {}),
        ...(Number.isFinite(maxActions) && maxActions > 0 ? { maxActions } : {}),
      });
      setStandingGrants(grants);
      setStandingDraft({ domain: '', ttlMin: '30', maxActions: '20' });
    });

  const removeStandingGrant = (id: string) =>
    void runAction(`standing:del:${id}`, async () => {
      setStandingGrants(await removeAoiBrowserDriveStandingGrant(id));
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
      const result = await approveAoiHostApproval(fingerprint);
      setApprovals(await fetchAoiHostApprovals());
      setConsentNote(
        result.note ||
          (result.alreadyApproved
            ? 'Already approved — use Run to execute.'
            : 'Approved. Use Run to execute, or ask Aoi to continue.'),
      );
    });

  const approveAndRun = (fingerprint: string) =>
    void runAction(`approve-run:${fingerprint}`, async () => {
      const result = await approveAndExecuteAoiHostApproval(fingerprint);
      setApprovals(await fetchAoiHostApprovals());
      if (!result.ok) {
        throw new Error(
          result.blockReasons.length > 0
            ? `Spawn failed: ${result.blockReasons.join(', ')}`
            : 'Spawn execute failed',
        );
      }
      setConsentNote(
        result.spawnedPid
          ? `Started ${result.program || 'program'} (pid ${result.spawnedPid}).`
          : `Started ${result.program || 'program'}.`,
      );
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
      {consentNote ? (
        <span className={styles.modelHint} data-testid="aoi-host-consent-note">
          {consentNote}
        </span>
      ) : null}
      {!sessionPath.trim() ? (
        <span className={styles.modelHint}>
          No active session path — process/desktop kill-switch will not auto-grant session consent.
        </span>
      ) : null}
      {loading ? <span className={styles.modelHint}>Loading host-bridge state...</span> : null}

      {status ? (
        <>
          {!status.tokenConfigured ? (
            <div className={styles.aoiAutonomyError} data-testid="aoi-host-no-token">
              The daemon has not minted its auth token yet. Rebuild + restart the daemon (pnpm
              daemon:build) so the host-bridge routes come online.
            </div>
          ) : null}

          <div className={styles.advancedSubnav} data-testid="aoi-host-section-subnav">
            {HOST_SECTIONS.map((section) => (
              <button
                key={section.id}
                type="button"
                className={
                  hostSection === section.id
                    ? `${styles.settingsTab} ${styles.settingsTabActive}`
                    : styles.settingsTab
                }
                data-testid={`aoi-host-section-${section.id}`}
                onClick={() => setHostSection(section.id)}
              >
                {section.label}
              </button>
            ))}
          </div>

          <div className={styles.connectorList}>
            {hostSection === 'capabilities' && (
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
            )}

            {hostSection === 'spawn' && (
              <div className={styles.connectorRow} data-testid="aoi-host-spawn-allowlist">
                <div className={styles.connectorRowHeader}>
                  <strong>Spawn allowlist</strong>
                  <span className={styles.modelHint}>{spawnEntries.length} registered</span>
                </div>
                <span className={styles.modelHint}>
                  Register a single .exe, or a folder so any .exe under it is allowed. Id is
                  optional. Capability kill-switch + per-action approval still required.
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
            )}

            {hostSection === 'browserDrive' && (
              <div className={styles.connectorRow} data-testid="aoi-host-browser-drive-denylist">
                <div className={styles.connectorRowHeader}>
                  <strong>Browser-drive denylist</strong>
                  <span className={styles.modelHint}>{browserDriveEntries.length} blocked</span>
                </div>
                <span className={styles.modelHint}>
                  Default ALLOW for public http(s) hosts. Domains listed here are blocked (exact
                  host and subdomains). Private/loopback hosts are always blocked. Attach still
                  exposes every login on the main profile — use this list for sites you never want
                  automated. Interactions still need per-action approval;
                  passwords/payments/CAPTCHAs are never entered.
                </span>
                {browserDriveEntries.map((entry) => (
                  <div key={entry.id} className={styles.connectorToggleRow}>
                    <span className={styles.modelHint}>
                      {entry.label && entry.label !== entry.domain ? `${entry.label} · ` : ''}
                      {entry.domain}
                    </span>
                    <button
                      type="button"
                      className={styles.cancelBtn}
                      onClick={() => removeBrowserDriveDomain(entry.id)}
                      disabled={busy === `drive:del:${entry.id}`}
                      title="Unblock this domain"
                      data-testid={`aoi-host-drive-remove-${entry.id}`}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
                <div className={styles.connectorToggleRow}>
                  <input
                    className={styles.fieldInput}
                    value={browserDriveDraft.domain}
                    onChange={(event) =>
                      setBrowserDriveDraft((prev) => ({ ...prev, domain: event.target.value }))
                    }
                    placeholder="blocked-site.com"
                    aria-label="Browser-drive denylist domain"
                    data-testid="aoi-host-drive-domain-input"
                  />
                  <button
                    type="button"
                    className={styles.saveBtn}
                    onClick={addBrowserDriveDomain}
                    disabled={!browserDriveDraft.domain.trim() || busy === 'drive:add'}
                    data-testid="aoi-host-drive-add"
                  >
                    Block
                  </button>
                </div>
              </div>
            )}

            {hostSection === 'standing' && (
              <div className={styles.connectorRow} data-testid="aoi-host-standing-grants">
                <div className={styles.connectorRowHeader}>
                  <strong>Standing grants</strong>
                  <span className={styles.modelHint}>{standingGrants.length} active</span>
                </div>
                <span className={styles.modelHint}>
                  HIGH RISK. A grant lets Aoi act on its domain WITHOUT a per-action approval, up to
                  the TTL and action quota. Honored only while the &quot;Browser drive: standing
                  approval&quot; capability is ON (Capabilities tab); panic disables it instantly.
                  The domain must not be on the browser-drive denylist; forbidden actions
                  (passwords/payments/CAPTCHA) are never performed.
                </span>
                <div className={styles.connectorRow} data-testid="aoi-browser-drive-profile">
                  <div className={styles.connectorRowHeader}>
                    <strong>Browser profile</strong>
                  </div>
                  <span className={styles.modelHint}>
                    Chrome refuses remote debugging on its own default profile, so Aoi drives a
                    SEPARATE one. Point this at a directory you have signed into: whatever you log
                    into there is what Aoi can reach, and nothing else.
                    {driveProfile?.defaultProfileDir ? (
                      <>
                        {' '}
                        Your everyday profile ({driveProfile.defaultProfileDir}) will be refused.
                      </>
                    ) : null}
                  </span>
                  <div className={styles.connectorToggleRow}>
                    <input
                      className={styles.textInput}
                      placeholder="C:\\Users\\you\\.openroom\\browser-profile"
                      value={driveProfileDraft}
                      onChange={(event) => setDriveProfileDraft(event.target.value)}
                      data-testid="aoi-browser-drive-profile-input"
                    />
                    <button
                      type="button"
                      className={styles.saveBtn}
                      disabled={busy === 'drive-profile'}
                      onClick={async () => {
                        setBusy('drive-profile');
                        setError('');
                        try {
                          const next = await setAoiBrowserDriveProfile(driveProfileDraft);
                          setDriveProfile(next);
                          setDriveProfileDraft(next.userDataDir);
                        } catch (saveError) {
                          setError(
                            saveError instanceof Error ? saveError.message : String(saveError),
                          );
                        } finally {
                          setBusy('');
                        }
                      }}
                    >
                      Save
                    </button>
                  </div>
                  {driveProfile && !driveProfile.configured ? (
                    <span className={styles.modelHint} data-testid="aoi-browser-drive-profile-warn">
                      Not configured yet, so browser drive will refuse rather than attach to a
                      profile that cannot work.
                    </span>
                  ) : null}
                </div>

                {!status?.killSwitch.enabledCapabilities.includes('os_browser_drive_standing') && (
                  <span className={styles.modelHint} data-testid="aoi-host-standing-off-hint">
                    Standing approval is currently OFF — grants below are inert until you enable it
                    in the Capabilities tab.
                  </span>
                )}
                {standingGrants.map((grant) => {
                  const minutesLeft = Math.max(
                    0,
                    Math.round((grant.expiresAt - Date.now()) / 60_000),
                  );
                  return (
                    <div key={grant.id} className={styles.connectorToggleRow}>
                      <span className={styles.modelHint}>
                        {grant.label && grant.label !== grant.domain ? `${grant.label} · ` : ''}
                        {grant.domain} · {grant.usedActions}/{grant.maxActions} used · ~
                        {minutesLeft}m left
                      </span>
                      <button
                        type="button"
                        className={styles.cancelBtn}
                        onClick={() => removeStandingGrant(grant.id)}
                        disabled={busy === `standing:del:${grant.id}`}
                        title="Revoke this grant"
                        data-testid={`aoi-host-standing-remove-${grant.id}`}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  );
                })}
                <div className={styles.connectorToggleRow}>
                  <input
                    className={styles.fieldInput}
                    value={standingDraft.domain}
                    onChange={(event) =>
                      setStandingDraft((prev) => ({ ...prev, domain: event.target.value }))
                    }
                    placeholder="example.com"
                    aria-label="Standing grant domain"
                    data-testid="aoi-host-standing-domain-input"
                  />
                  <input
                    className={styles.fieldInput}
                    value={standingDraft.ttlMin}
                    onChange={(event) =>
                      setStandingDraft((prev) => ({ ...prev, ttlMin: event.target.value }))
                    }
                    placeholder="TTL min"
                    aria-label="Standing grant TTL minutes"
                    data-testid="aoi-host-standing-ttl-input"
                  />
                  <input
                    className={styles.fieldInput}
                    value={standingDraft.maxActions}
                    onChange={(event) =>
                      setStandingDraft((prev) => ({ ...prev, maxActions: event.target.value }))
                    }
                    placeholder="Max actions"
                    aria-label="Standing grant max actions"
                    data-testid="aoi-host-standing-max-input"
                  />
                  <button
                    type="button"
                    className={styles.saveBtn}
                    onClick={addStandingGrant}
                    disabled={!standingDraft.domain.trim() || busy === 'standing:add'}
                    data-testid="aoi-host-standing-add"
                  >
                    Add
                  </button>
                </div>
              </div>
            )}

            {hostSection === 'activity' && (
              <div className={styles.connectorRow} data-testid="aoi-host-browser-drive-activity">
                <div className={styles.connectorRowHeader}>
                  <strong>Browser-drive activity</strong>
                  <span className={styles.modelHint}>{auditEntries.length} recent</span>
                </div>
                <span className={styles.modelHint}>
                  Every driven step Aoi performed on your browser (newest first), with the outcome
                  and a mark when a step ran under a standing grant rather than a per-action
                  approval. Read-only audit.
                </span>
                {auditEntries.length === 0 ? (
                  <span className={styles.modelHint}>No browser-drive activity recorded yet.</span>
                ) : (
                  auditEntries.map((entry) => (
                    <div
                      key={entry.id}
                      className={styles.connectorToggleRow}
                      data-testid={`aoi-host-activity-${entry.id}`}
                    >
                      <span className={styles.modelHint}>
                        {entry.ok ? 'ok' : `stop:${entry.stopReason ?? 'failed'}`} ·{' '}
                        {entry.category}
                        {entry.viaStanding ? ' · standing' : ''}
                        {entry.hasScreenshot ? ' · shot' : ''} ·{' '}
                        {entry.actionSummary || entry.actionKind}
                      </span>
                    </div>
                  ))
                )}
              </div>
            )}

            {hostSection === 'roots' && (
              <>
                {renderRootsSection('read', 'Read roots', readRoots, readDraft, setReadDraft)}
                {renderRootsSection('write', 'Write roots', writeRoots, writeDraft, setWriteDraft)}
              </>
            )}

            {hostSection === 'approvals' && (
              <div className={styles.connectorRow} data-testid="aoi-host-approvals">
                <div className={styles.connectorRowHeader}>
                  <strong>Approvals</strong>
                  <span className={styles.modelHint}>{approvals.length} open</span>
                </div>
                <span className={styles.modelHint}>
                  Primary flow is the in-chat Approve &amp; Run popup when Aoi proposes a PC launch.
                  This list is a backup for entries that did not get the chat popup.
                </span>
                {approvals.length === 0 ? (
                  <span className={styles.modelHint}>No open approvals.</span>
                ) : (
                  approvals.map((entry) => {
                    const isPending = entry.state === 'pending';
                    const isApproved = entry.state === 'approved';
                    const canRun = entry.canExecute && (isPending || isApproved);
                    return (
                      <div key={entry.id} className={styles.connectorToggleRow}>
                        <span className={styles.modelHint}>
                          <strong>{entry.capability}</strong> · {entry.state} ·{' '}
                          {entry.targetSummary}
                        </span>
                        {isPending && !entry.canExecute ? (
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
                        ) : null}
                        {canRun ? (
                          <button
                            type="button"
                            className={styles.saveBtn}
                            onClick={() => approveAndRun(entry.approvalFingerprint)}
                            disabled={busy === `approve-run:${entry.approvalFingerprint}`}
                            title={
                              isPending
                                ? 'Approve and immediately start this allowlisted program'
                                : 'Start the already-approved program now'
                            }
                            data-testid={`aoi-host-approve-run-${entry.id}`}
                          >
                            <Check size={13} />
                            {isPending ? 'Approve & Run' : 'Run'}
                          </button>
                        ) : null}
                        {isApproved && !entry.canExecute ? (
                          <span className={styles.modelHint}>
                            Approved — ask Aoi to run (no stored execute payload; re-request
                            launch).
                          </span>
                        ) : null}
                      </div>
                    );
                  })
                )}
              </div>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
};
