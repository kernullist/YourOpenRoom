<#
.SYNOPSIS
  Single source of truth for the Aoi daemon's autonomy environment.

.DESCRIPTION
  Dot-source this from any launcher (Start-App.ps1, the boot-persistent scheduled
  task) so the supervised daemon always runs with the same Jarvis autonomy tier,
  no matter how it was started. Each variable is set ONLY when unset, so an
  explicit value in the caller's shell still wins.

  These flags make Aoi think, propose, remember, and reach out MORE, and open the
  operator-enabled action tier. None of them lets Aoi act without the unchanged
  approval gates: real effects still require earned trusted_operator readiness +
  content-addressed approval, and autonomous self-execution stays behind its own
  AOI_AUTONOMY_SELF_EXECUTE gate (deliberately NOT set here). AOI_AUTONOMY_BACKGROUND=0
  remains the hard off switch.
#>

$script:AoiDaemonEnv = [ordered]@{
    'AOI_AUTONOMY_GOAL_SYNTHESIS'        = '1'
    'AOI_AUTONOMY_CONSOLIDATION'         = '1'
    'AOI_AUTONOMY_EMBED_SWEEP'           = '1'
    'AOI_AUTONOMY_IDLE_CONFIDENCE_SURGE' = '1'
    # Field-shadow capture is session-policy controlled (settings toggle / ignition).
    # Do NOT soft-set AOI_AUTONOMY_FIELD_SHADOW_CAPTURE=1 here -- that made the
    # operator OFF toggle a no-op. Env=0 remains a hard process ceiling when set.
    'AOI_AUTONOMY_APP_OP_LIVE_DISPATCH'  = '1'
    'AOI_AUTONOMY_APPROVAL_TTL'          = '1'
    'AOI_MCP_SIDE_EFFECTING_RPC'         = '1'
}

function Set-AoiDaemonEnv
{
    foreach ($key in $script:AoiDaemonEnv.Keys)
    {
        if ([string]::IsNullOrEmpty([Environment]::GetEnvironmentVariable($key)))
        {
            [Environment]::SetEnvironmentVariable($key, $script:AoiDaemonEnv[$key])
        }
    }
}
