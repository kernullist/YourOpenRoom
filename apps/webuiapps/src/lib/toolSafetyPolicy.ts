export interface ToolSafetyPolicy {
  autoVerifyFixes: boolean;
  allowWorkspaceCommands: boolean;
  allowSemanticRefactors: boolean;
  allowBackgroundWatches: boolean;
  requirePreviewBeforeMutation: boolean;
}

const STORAGE_KEY = 'openroom-tool-safety-policy-v1';

export const DEFAULT_TOOL_SAFETY_POLICY: ToolSafetyPolicy = {
  autoVerifyFixes: true,
  allowWorkspaceCommands: true,
  allowSemanticRefactors: false,
  allowBackgroundWatches: false,
  requirePreviewBeforeMutation: false,
};

export function loadToolSafetyPolicy(): ToolSafetyPolicy {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_TOOL_SAFETY_POLICY;
    const parsed = JSON.parse(raw) as Partial<ToolSafetyPolicy>;
    return {
      autoVerifyFixes:
        typeof parsed.autoVerifyFixes === 'boolean'
          ? parsed.autoVerifyFixes
          : DEFAULT_TOOL_SAFETY_POLICY.autoVerifyFixes,
      allowWorkspaceCommands:
        typeof parsed.allowWorkspaceCommands === 'boolean'
          ? parsed.allowWorkspaceCommands
          : DEFAULT_TOOL_SAFETY_POLICY.allowWorkspaceCommands,
      allowSemanticRefactors:
        typeof parsed.allowSemanticRefactors === 'boolean'
          ? parsed.allowSemanticRefactors
          : DEFAULT_TOOL_SAFETY_POLICY.allowSemanticRefactors,
      allowBackgroundWatches:
        typeof parsed.allowBackgroundWatches === 'boolean'
          ? parsed.allowBackgroundWatches
          : DEFAULT_TOOL_SAFETY_POLICY.allowBackgroundWatches,
      requirePreviewBeforeMutation:
        typeof parsed.requirePreviewBeforeMutation === 'boolean'
          ? parsed.requirePreviewBeforeMutation
          : DEFAULT_TOOL_SAFETY_POLICY.requirePreviewBeforeMutation,
    };
  } catch {
    return DEFAULT_TOOL_SAFETY_POLICY;
  }
}

export function saveToolSafetyPolicy(policy: ToolSafetyPolicy): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(policy));
  } catch {
    // ignore persistence failures
  }
}
