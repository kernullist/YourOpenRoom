import React, { useCallback, useEffect, useState } from 'react';

import {
  AOI_AUTONOMY_CAPABILITIES_ROUTE,
  AOI_DAEMON_CAPABILITIES_ROUTE,
  buildAoiAutonomyCapabilityBody,
  describeAoiCapabilityOrigin,
  describeAoiCapabilitySource,
  parseAoiAutonomyCapabilityResponse,
  parseAoiDaemonCapabilityResponse,
  validateAoiPushWebhookUrl,
  type AoiAutonomyCapabilityView,
  type AoiAutonomyEnvOnlyGateView,
  type AoiCapabilitySource,
  type AoiCapabilityViewOrigin,
} from '@/lib/aoiAutonomyCapabilityPanelModel';

import styles from './index.module.scss';

// Operator surface for the autonomy capabilities. These were environment
// variables, so the Autonomy panel showed a configurable system whose
// capabilities could only be turned on by editing system env vars and
// restarting. They now live in config.json and are edited here; the env vars
// remain a fallback for headless deployments, which is why a control can read
// "on via environment".
//
// The env-only gates below the toggles are shown but NOT editable. They raise
// Aoi's trust level, weaken approval, or hard-disable a whole subsystem -- an
// operator with the app open must be able to see them without the app being
// able to change them.
export const AoiAutonomyCapabilityPanel: React.FC = () => {
  const [view, setView] = useState<AoiAutonomyCapabilityView | null>(null);
  const [envOnly, setEnvOnly] = useState<AoiAutonomyEnvOnlyGateView[]>([]);
  const [origin, setOrigin] = useState<AoiCapabilityViewOrigin>('local');
  const [webhookDraft, setWebhookDraft] = useState('');
  const [webhookError, setWebhookError] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const applyResponse = useCallback((raw: unknown): boolean => {
    const parsed = parseAoiAutonomyCapabilityResponse(raw);
    if (!parsed) {
      return false;
    }
    setView(parsed.capabilities);
    setEnvOnly(parsed.envOnly);
    // The draft follows the server on load/save, not on every keystroke, so a
    // half-typed URL is never clobbered mid-edit by a background refresh.
    setWebhookDraft(parsed.capabilities.pushWebhookUrl);
    return true;
  }, []);

  const load = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      // Prefer the daemon's answer: the config half is shared, but the env half
      // is per process and the autonomy env vars only ever reach the daemon.
      // Showing this server's env would report a capability the daemon has ON as
      // "Disabled (default)".
      try {
        const daemon = await fetch(AOI_DAEMON_CAPABILITIES_ROUTE);
        if (daemon.ok) {
          const parsed = parseAoiDaemonCapabilityResponse(await daemon.json());
          if (parsed) {
            setView(parsed.capabilities);
            setEnvOnly(parsed.envOnly);
            setWebhookDraft(parsed.capabilities.pushWebhookUrl);
            setOrigin('daemon');
            return;
          }
        }
      } catch {
        // Relay missing or daemon down: fall through to the local view.
      }
      const response = await fetch(AOI_AUTONOMY_CAPABILITIES_ROUTE);
      if (!response.ok) {
        throw new Error(`status ${response.status}`);
      }
      if (!applyResponse(await response.json())) {
        setError('No capability settings available.');
      }
      setOrigin('local');
    } catch (err) {
      setError(`Failed to load capability settings: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }, [applyResponse]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(
    async (next: AoiAutonomyCapabilityView) => {
      // Optimistic: the control flips immediately, the server response replaces
      // it (and corrects the source labels) a moment later.
      setView(next);
      setBusy(true);
      setError('');
      try {
        const response = await fetch(AOI_AUTONOMY_CAPABILITIES_ROUTE, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildAoiAutonomyCapabilityBody(next)),
        });
        if (!response.ok) {
          throw new Error(`status ${response.status}`);
        }
        applyResponse(await response.json());
      } catch (err) {
        setError(`Failed to save capability settings: ${String(err)}`);
        await load();
      } finally {
        setBusy(false);
      }
    },
    [applyResponse, load],
  );

  const saveWebhook = useCallback(() => {
    if (!view) {
      return;
    }
    const invalid = validateAoiPushWebhookUrl(webhookDraft);
    if (invalid) {
      setWebhookError(invalid);
      return;
    }
    setWebhookError('');
    void save({ ...view, pushWebhookUrl: webhookDraft.trim() });
  }, [save, view, webhookDraft]);

  const renderToggle = (
    label: string,
    hint: string,
    enabled: boolean,
    source: AoiCapabilitySource,
    testId: string,
    onToggle: () => void,
  ) => (
    <div className={styles.field}>
      <label className={styles.label}>{label}</label>
      <button
        type="button"
        className={enabled ? styles.saveBtn : styles.cancelBtn}
        disabled={busy || !view}
        onClick={onToggle}
        data-testid={testId}
      >
        {enabled ? 'Enabled' : 'Disabled'}
      </button>
      <span className={styles.modelHint}>
        {hint} ({describeAoiCapabilitySource(source)})
      </span>
    </div>
  );

  return (
    <div className={styles.settingsSectionCard} data-testid="aoi-autonomy-capability-panel">
      <div className={styles.settingsSectionHeader}>
        <div>
          <div className={styles.settingsSectionTitle}>Autonomy Capabilities</div>
          <span className={styles.modelHint}>
            What Aoi is allowed to do on her own. Each still passes its own safety gate; these only
            decide whether that gate is reached at all.
          </span>
        </div>
        <button
          type="button"
          className={styles.inlineActionBtn}
          disabled={busy}
          onClick={() => void load()}
          title="Reload capability settings"
        >
          Refresh
        </button>
      </div>

      {error ? <div className={styles.aoiAutonomyError}>{error}</div> : null}

      <div
        className={origin === 'daemon' ? styles.modelHint : styles.aoiAutonomyError}
        data-testid="aoi-capability-origin"
      >
        {describeAoiCapabilityOrigin(origin)}
      </div>

      {view ? (
        <>
          {renderToggle(
            'Self-execute accepted proposals',
            'Carries out proposals you already accepted, without a second click. Reversible actions only, with a checkpoint.',
            view.selfExecute,
            view.sources.selfExecute,
            'aoi-capability-self-execute-toggle',
            () => void save({ ...view, selfExecute: !view.selfExecute }),
          )}
          {renderToggle(
            'Live app-operation dispatch',
            'Sends an approved app action straight to the app instead of filing it for review.',
            view.appOpLiveDispatch,
            view.sources.appOpLiveDispatch,
            'aoi-capability-app-op-dispatch-toggle',
            () => void save({ ...view, appOpLiveDispatch: !view.appOpLiveDispatch }),
          )}
          {renderToggle(
            'Goal synthesis',
            'Lets Aoi form new goals from what she has observed, instead of only reacting.',
            view.goalSynthesis,
            view.sources.goalSynthesis,
            'aoi-capability-goal-synthesis-toggle',
            () => void save({ ...view, goalSynthesis: !view.goalSynthesis }),
          )}
          {renderToggle(
            'Idle confidence surge',
            'Raises how readily she speaks up while you are idle.',
            view.idleConfidenceSurge,
            view.sources.idleConfidenceSurge,
            'aoi-capability-idle-surge-toggle',
            () => void save({ ...view, idleConfidenceSurge: !view.idleConfidenceSurge }),
          )}

          <div className={styles.field}>
            <label className={styles.label}>Proactive push webhook</label>
            <input
              className={styles.input}
              type="text"
              value={webhookDraft}
              placeholder="https://..."
              disabled={busy}
              onChange={(event) => {
                setWebhookDraft(event.target.value);
                setWebhookError('');
              }}
              data-testid="aoi-capability-push-webhook-input"
            />
            <button
              type="button"
              className={styles.inlineActionBtn}
              disabled={busy}
              onClick={saveWebhook}
              data-testid="aoi-capability-push-webhook-save"
            >
              Save
            </button>
            <span className={styles.modelHint}>
              Where high-urgency cards are delivered when you are not in the panel. Empty means off.
              ({describeAoiCapabilitySource(view.sources.pushWebhookUrl)})
            </span>
            {webhookError ? <div className={styles.aoiAutonomyError}>{webhookError}</div> : null}
          </div>
        </>
      ) : null}

      {envOnly.length > 0 ? (
        <div className={styles.field} data-testid="aoi-capability-env-only">
          <label className={styles.label}>Environment-only (not settable here)</label>
          <span className={styles.modelHint}>
            These raise Aoi&apos;s own trust level, weaken approval, or hard-disable a subsystem, so
            they stay with whoever runs the deployment.
          </span>
          {envOnly.map((gate) => (
            <div key={gate.key} className={styles.promptBudgetMetric}>
              <span className={styles.promptBudgetLabel}>{gate.label}</span>
              <span
                className={styles.modelHint}
                data-testid={`aoi-capability-env-gate-${gate.key}`}
              >
                {gate.on ? 'On' : 'Off'} — {gate.detail}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
};
