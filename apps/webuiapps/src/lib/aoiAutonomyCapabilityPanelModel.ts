// Pure model for the autonomy capability settings panel: route, response
// parsing, the request body, and the honest source labels. Kept out of the
// component so the rules stay unit-testable and the panel is a thin renderer
// (same split as aoiMemoryMaintenancePanelModel).

export const AOI_AUTONOMY_CAPABILITIES_ROUTE = '/api/aoi-autonomy/capabilities';
// The daemon's own view of the same settings. Reads must prefer it: the config
// half is shared, but the env half is per process, and the autonomy env vars only
// ever reach the daemon. Writes still go to the local route -- both processes
// resolve the same config.json, so the daemon picks the change up on its next
// cycle.
export const AOI_DAEMON_CAPABILITIES_ROUTE = '/api/aoi-daemon/capabilities';

// Which process the displayed state came from. 'daemon' is the truth about what
// actually runs; 'local' means the daemon could not be reached, so anything
// sourced from the environment may be wrong.
export type AoiCapabilityViewOrigin = 'daemon' | 'local';

export type AoiCapabilitySource = 'config' | 'env' | 'default';

export interface AoiAutonomyCapabilityView {
  selfExecute: boolean;
  appOpLiveDispatch: boolean;
  pushWebhookUrl: string;
  goalSynthesis: boolean;
  idleConfidenceSurge: boolean;
  sources: {
    selfExecute: AoiCapabilitySource;
    appOpLiveDispatch: AoiCapabilitySource;
    pushWebhookUrl: AoiCapabilitySource;
    goalSynthesis: AoiCapabilitySource;
    idleConfidenceSurge: AoiCapabilitySource;
  };
}

// The gates that stay environment-only on purpose. Rendered read-only so the
// operator can SEE their state without the app being able to change it: these
// raise Aoi's own trust level or weaken approval, which is a safety posture
// decision, not an accessibility one.
export interface AoiAutonomyEnvOnlyGateView {
  key: string;
  label: string;
  detail: string;
  on: boolean;
}

export interface AoiAutonomyCapabilityPanelData {
  capabilities: AoiAutonomyCapabilityView;
  envOnly: AoiAutonomyEnvOnlyGateView[];
}

function asBool(value: unknown): boolean {
  return value === true;
}

function asSource(value: unknown): AoiCapabilitySource {
  return value === 'config' || value === 'env' ? value : 'default';
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function parseAoiAutonomyCapabilityResponse(
  raw: unknown,
): AoiAutonomyCapabilityPanelData | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const body = raw as Record<string, unknown>;
  const settings = body.settings as Record<string, unknown> | undefined;
  if (!settings || typeof settings !== 'object') {
    return null;
  }
  const sources = (settings.sources ?? {}) as Record<string, unknown>;
  const envOnlyRaw = Array.isArray(body.envOnly) ? body.envOnly : [];

  return {
    capabilities: {
      selfExecute: asBool(settings.selfExecute),
      appOpLiveDispatch: asBool(settings.appOpLiveDispatch),
      pushWebhookUrl: asText(settings.pushWebhookUrl),
      goalSynthesis: asBool(settings.goalSynthesis),
      idleConfidenceSurge: asBool(settings.idleConfidenceSurge),
      sources: {
        selfExecute: asSource(sources.selfExecute),
        appOpLiveDispatch: asSource(sources.appOpLiveDispatch),
        pushWebhookUrl: asSource(sources.pushWebhookUrl),
        goalSynthesis: asSource(sources.goalSynthesis),
        idleConfidenceSurge: asSource(sources.idleConfidenceSurge),
      },
    },
    envOnly: envOnlyRaw
      .map((entry) => {
        const row = (entry ?? {}) as Record<string, unknown>;
        return {
          key: asText(row.key),
          label: asText(row.label),
          detail: asText(row.detail),
          on: asBool(row.on),
        };
      })
      .filter((row) => row.key.length > 0),
  };
}

// Only the fields the panel actually controls are sent, and each is explicit so
// a saved setting beats the env fallback.
export function buildAoiAutonomyCapabilityBody(
  view: AoiAutonomyCapabilityView,
): Record<string, unknown> {
  return {
    version: 1,
    selfExecuteEnabled: view.selfExecute,
    appOpLiveDispatchEnabled: view.appOpLiveDispatch,
    pushWebhookUrl: view.pushWebhookUrl,
    goalSynthesisEnabled: view.goalSynthesis,
    idleConfidenceSurgeEnabled: view.idleConfidenceSurge,
  };
}

export function describeAoiCapabilitySource(source: AoiCapabilitySource): string {
  if (source === 'config') {
    return 'set here';
  }
  return source === 'env' ? 'on via environment' : 'default';
}

// Whether the daemon relay actually answered with a capability payload. A relay
// that reports the daemon down (or that answers with nothing parseable) must not
// be treated as the daemon's view.
export function parseAoiDaemonCapabilityResponse(
  raw: unknown,
): AoiAutonomyCapabilityPanelData | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  if ((raw as Record<string, unknown>).status !== 'running') {
    return null;
  }
  return parseAoiAutonomyCapabilityResponse(raw);
}

export function describeAoiCapabilityOrigin(origin: AoiCapabilityViewOrigin): string {
  return origin === 'daemon'
    ? 'Showing the running daemon state.'
    : 'The daemon is not reachable, so anything marked "on via environment" reflects this server, not the process that acts.';
}

// A URL the operator typed is checked before it is sent, so the failure is a
// message next to the field rather than a silent server-side rejection.
export function validateAoiPushWebhookUrl(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return 'Push webhook must be an http(s) URL.';
    }
    return null;
  } catch {
    return 'Push webhook must be a valid URL.';
  }
}
