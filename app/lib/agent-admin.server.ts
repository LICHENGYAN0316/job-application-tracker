import {
  AGENT_DAILY_LIMIT,
  AGENT_MAX_DAILY_LIMIT,
  AGENT_MIN_DAILY_LIMIT,
  AGENT_WINDOW_MS,
  isAgentAdmin,
  type AgentDatabase,
  type AgentRuntimeConfig,
} from './agent-service.server.ts';
import type { AuthPrincipal } from './auth-principal.server.ts';

export type AgentAdminUser = {
  userNumber: number;
  role: 'admin' | 'user';
  disabled: boolean;
  limitOverride: number | null;
  effectiveLimit: number | null;
  used24h: number;
  lastCallAt: string | null;
  totalTokens: number;
};

export type AgentAdminDashboard = {
  globalEnabled: boolean;
  defaultLimit: number;
  users: AgentAdminUser[];
  totals: {
    successfulCalls: number;
    totalTokens: number;
  };
  quality: {
    technicalSuccessRate: number | null;
    technicalSamples: number;
    taskSuccessRate: number | null;
    ratedTasks: number;
    oneRoundResolutionRate: number | null;
    oneRoundResolvedTasks: number;
    feedbackCoverageRate: number | null;
    feedbackEligibleTasks: number;
    toolParameterSchemaPassRate: number | null;
    toolParameterSamples: number;
    actionExecutionSuccessRate: number | null;
    actionExecutionSamples: number;
    ambiguitySafeClarificationRate: number | null;
    ambiguitySamples: number;
    wrongActionRate: number | null;
    actionFeedbackSamples: number;
    unauthorizedExecutionCount: number;
    duplicateBlockedCount: number;
    versionConflictRate: number | null;
    versionConflictSamples: number;
    averageCompletedRounds: number | null;
    completedTasks: number;
    averageLatencyMs: number | null;
    p95LatencyMs: number | null;
    latencySamples: number;
  };
};

function integer(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function storedLimit(value: unknown, fallback = AGENT_DAILY_LIMIT) {
  if (!isAgentDailyLimit(value)) return fallback;
  return value;
}

function nullableStoredLimit(value: unknown) {
  return isAgentDailyLimit(value) ? value : null;
}

function timestamp(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? new Date(value).toISOString()
    : null;
}

function decimal(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function ratio(numerator: number, denominator: number) {
  return denominator > 0 ? numerator / denominator : null;
}

export function requireAgentAdmin(principal: AuthPrincipal, config: AgentRuntimeConfig) {
  if (!isAgentAdmin(principal, config.adminChatgptUserId)) throw new AgentAdminForbiddenError();
}

export function isAgentDailyLimit(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= AGENT_MIN_DAILY_LIMIT
    && value <= AGENT_MAX_DAILY_LIMIT;
}

export async function readAgentAdminDashboard(
  database: AgentDatabase,
  principal: AuthPrincipal,
  config: AgentRuntimeConfig,
  nowMs = Date.now(),
): Promise<AgentAdminDashboard> {
  requireAgentAdmin(principal, config);
  const settingPromise = database.prepare(
    'SELECT global_enabled, default_daily_limit FROM agent_settings WHERE id = 1',
  ).first<{ global_enabled?: number; default_daily_limit?: number }>();
  const cutoffMs = nowMs - AGENT_WINDOW_MS;
  const rowsPromise = database.prepare(`
    SELECT
      u.id AS user_number,
      u.role,
      u.disabled,
      u.quota_override,
      COALESCE(SUM(CASE WHEN c.status = 'success' AND c.completed_at_ms > ? THEN 1 ELSE 0 END), 0) AS used_24h,
      MAX(COALESCE(c.completed_at_ms, c.reserved_at_ms)) AS last_call_at_ms,
      COALESCE(SUM(CASE WHEN c.status = 'success' THEN c.total_tokens ELSE 0 END), 0) AS total_tokens
    FROM agent_users u
    LEFT JOIN agent_calls c ON c.account_key = u.account_key
    GROUP BY u.id, u.role, u.disabled, u.quota_override
    ORDER BY last_call_at_ms DESC, u.id ASC
    LIMIT 500
  `).bind(cutoffMs).all<Record<string, unknown>>();
  const totalsPromise = database.prepare(`
    SELECT
      COUNT(*) AS successful_calls,
      COALESCE(SUM(total_tokens), 0) AS total_tokens
    FROM agent_calls WHERE status = 'success'
  `).first<Record<string, unknown>>();
  const qualityPromise = database.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0) AS successful_calls,
      COALESCE(SUM(CASE WHEN status = 'technical_failure' THEN 1 ELSE 0 END), 0) AS technical_failures,
      COALESCE(SUM(CASE WHEN status = 'success' AND latency_ms > 0 THEN 1 ELSE 0 END), 0) AS latency_samples,
      COALESCE(AVG(CASE WHEN status = 'success' AND latency_ms > 0 THEN latency_ms END), 0) AS average_latency_ms,
      (
        SELECT latency_ms FROM agent_calls
        WHERE status = 'success' AND latency_ms > 0
        ORDER BY latency_ms
        LIMIT 1 OFFSET (
          SELECT CAST(
            (CASE WHEN COUNT(*) > 0 THEN COUNT(*) - 1 ELSE 0 END) * 95 / 100
            AS INTEGER
          )
          FROM agent_calls WHERE status = 'success' AND latency_ms > 0
        )
      ) AS p95_latency_ms,
      (
        SELECT COUNT(*) FROM (
          SELECT account_key, session_id
          FROM agent_calls
          WHERE status = 'success' AND session_id <> ''
          GROUP BY account_key, session_id
        )
      ) AS successful_sessions,
      (
        SELECT COUNT(*) FROM (
          SELECT account_key, session_id
          FROM agent_calls
          WHERE session_id <> '' AND feedback IS NOT NULL
          GROUP BY account_key, session_id
          UNION
          SELECT account_key, session_id
          FROM agent_action_proposals
          WHERE session_id <> '' AND feedback IS NOT NULL
          GROUP BY account_key, session_id
        )
      ) AS rated_tasks,
      (
        SELECT COUNT(*) FROM (
          SELECT account_key, session_id
          FROM agent_calls
          WHERE session_id <> '' AND feedback = 'resolved'
          GROUP BY account_key, session_id
          UNION
          SELECT account_key, session_id
          FROM agent_action_proposals
          WHERE session_id <> '' AND feedback = 'correct'
          GROUP BY account_key, session_id
        )
      ) AS completed_tasks,
      (
        SELECT COUNT(*) FROM (
          SELECT calls.account_key, calls.session_id, COUNT(*) AS round_count
          FROM agent_calls calls
          WHERE calls.status = 'success'
            AND calls.session_id <> ''
            AND EXISTS (
              SELECT 1 FROM agent_calls feedback_calls
              WHERE feedback_calls.account_key = calls.account_key
                AND feedback_calls.session_id = calls.session_id
                AND feedback_calls.feedback = 'resolved'
            )
            OR (
              calls.status = 'success'
              AND calls.session_id <> ''
              AND EXISTS (
                SELECT 1 FROM agent_action_proposals action_feedback
                WHERE action_feedback.account_key = calls.account_key
                  AND action_feedback.session_id = calls.session_id
                  AND action_feedback.feedback = 'correct'
              )
            )
          GROUP BY calls.account_key, calls.session_id
          HAVING COUNT(*) = 1
        )
      ) AS one_round_resolved_tasks,
      (
        SELECT COALESCE(AVG(round_count), 0) FROM (
          SELECT calls.account_key, calls.session_id, COUNT(*) AS round_count
          FROM agent_calls calls
          WHERE calls.status = 'success'
            AND calls.session_id <> ''
            AND EXISTS (
              SELECT 1 FROM agent_calls feedback_calls
              WHERE feedback_calls.account_key = calls.account_key
                AND feedback_calls.session_id = calls.session_id
                AND feedback_calls.feedback = 'resolved'
            )
            OR (
              calls.status = 'success'
              AND calls.session_id <> ''
              AND EXISTS (
                SELECT 1 FROM agent_action_proposals action_feedback
                WHERE action_feedback.account_key = calls.account_key
                  AND action_feedback.session_id = calls.session_id
                  AND action_feedback.feedback = 'correct'
              )
            )
          GROUP BY calls.account_key, calls.session_id
        )
      ) AS average_completed_rounds,
      (
        SELECT COUNT(*) FROM agent_action_events
        WHERE schema_valid IS NOT NULL
      ) AS tool_parameter_samples,
      (
        SELECT COALESCE(SUM(schema_valid), 0) FROM agent_action_events
        WHERE schema_valid IS NOT NULL
      ) AS valid_tool_parameters,
      (
        SELECT COUNT(DISTINCT proposal_id) FROM agent_action_events
        WHERE event_type = 'execution_started'
      ) AS action_execution_samples,
      (
        SELECT COUNT(DISTINCT proposal_id) FROM agent_action_events
        WHERE event_type = 'executed'
      ) AS executed_actions,
      (
        SELECT COUNT(*) FROM agent_action_events
        WHERE ambiguity_detected = 1
      ) AS ambiguity_samples,
      (
        SELECT COALESCE(SUM(ambiguity_handled), 0) FROM agent_action_events
        WHERE ambiguity_detected = 1
      ) AS handled_ambiguities,
      (
        SELECT COUNT(*) FROM agent_action_proposals
        WHERE feedback IN ('correct', 'incorrect')
      ) AS action_feedback_samples,
      (
        SELECT COUNT(*) FROM agent_action_proposals
        WHERE feedback = 'incorrect'
      ) AS incorrect_actions,
      (
        SELECT COUNT(*) FROM agent_action_proposals
        WHERE status = 'executed' AND confirmed_at_ms IS NULL
      ) AS unauthorized_executions,
      (
        SELECT COUNT(*) FROM agent_action_events
        WHERE reason_code = 'duplicate'
      ) AS duplicate_blocks,
      (
        SELECT COUNT(DISTINCT proposal_id) FROM agent_action_events
        WHERE event_type = 'execution_conflict'
      ) AS version_conflicts
    FROM agent_calls
  `).first<Record<string, unknown>>();

  const [setting, rows, totals, quality] = await Promise.all([
    settingPromise,
    rowsPromise,
    totalsPromise,
    qualityPromise,
  ]);
  const defaultLimit = storedLimit(setting?.default_daily_limit);

  const successfulCalls = integer(quality?.successful_calls);
  const technicalFailures = integer(quality?.technical_failures);
  const latencySamples = integer(quality?.latency_samples);
  const ratedTasks = integer(quality?.rated_tasks);
  const completedTasks = integer(quality?.completed_tasks);
  const successfulSessions = integer(quality?.successful_sessions);
  const oneRoundResolvedTasks = integer(quality?.one_round_resolved_tasks);
  const toolParameterSamples = integer(quality?.tool_parameter_samples);
  const validToolParameters = integer(quality?.valid_tool_parameters);
  const actionExecutionSamples = integer(quality?.action_execution_samples);
  const executedActions = integer(quality?.executed_actions);
  const ambiguitySamples = integer(quality?.ambiguity_samples);
  const handledAmbiguities = integer(quality?.handled_ambiguities);
  const actionFeedbackSamples = integer(quality?.action_feedback_samples);
  const incorrectActions = integer(quality?.incorrect_actions);
  const versionConflicts = integer(quality?.version_conflicts);

  return {
    globalEnabled: integer(setting?.global_enabled) === 1,
    defaultLimit,
    users: (rows.results ?? []).map((row) => {
      const role = row.role === 'admin' ? 'admin' : 'user';
      const limitOverride = role === 'admin' ? null : nullableStoredLimit(row.quota_override);
      return {
        userNumber: integer(row.user_number),
        role,
        disabled: integer(row.disabled) === 1,
        limitOverride,
        effectiveLimit: role === 'admin' ? null : limitOverride ?? defaultLimit,
        used24h: integer(row.used_24h),
        lastCallAt: timestamp(row.last_call_at_ms),
        totalTokens: integer(row.total_tokens),
      };
    }),
    totals: {
      successfulCalls: integer(totals?.successful_calls),
      totalTokens: integer(totals?.total_tokens),
    },
    quality: {
      technicalSuccessRate: ratio(successfulCalls, successfulCalls + technicalFailures),
      technicalSamples: successfulCalls + technicalFailures,
      taskSuccessRate: ratio(completedTasks, ratedTasks),
      ratedTasks,
      oneRoundResolutionRate: ratio(oneRoundResolvedTasks, ratedTasks),
      oneRoundResolvedTasks,
      feedbackCoverageRate: ratio(ratedTasks, successfulSessions),
      feedbackEligibleTasks: successfulSessions,
      toolParameterSchemaPassRate: ratio(validToolParameters, toolParameterSamples),
      toolParameterSamples,
      actionExecutionSuccessRate: ratio(executedActions, actionExecutionSamples),
      actionExecutionSamples,
      ambiguitySafeClarificationRate: ratio(handledAmbiguities, ambiguitySamples),
      ambiguitySamples,
      wrongActionRate: ratio(incorrectActions, actionFeedbackSamples),
      actionFeedbackSamples,
      unauthorizedExecutionCount: integer(quality?.unauthorized_executions),
      duplicateBlockedCount: integer(quality?.duplicate_blocks),
      versionConflictRate: ratio(versionConflicts, actionExecutionSamples),
      versionConflictSamples: actionExecutionSamples,
      averageCompletedRounds: completedTasks > 0
        ? decimal(quality?.average_completed_rounds)
        : null,
      completedTasks,
      averageLatencyMs: latencySamples > 0 ? decimal(quality?.average_latency_ms) : null,
      p95LatencyMs: latencySamples > 0 ? decimal(quality?.p95_latency_ms) : null,
      latencySamples,
    },
  };
}

export async function setAgentGlobalEnabled(
  database: AgentDatabase,
  principal: AuthPrincipal,
  config: AgentRuntimeConfig,
  enabled: boolean,
  nowMs = Date.now(),
) {
  requireAgentAdmin(principal, config);
  await database.prepare(`
    UPDATE agent_settings
    SET global_enabled = ?, version = version + 1, updated_at_ms = ?, updated_by_account_key = ?
    WHERE id = 1
  `).bind(enabled ? 1 : 0, nowMs, principal.id).run();
}

export async function setAgentDefaultLimit(
  database: AgentDatabase,
  principal: AuthPrincipal,
  config: AgentRuntimeConfig,
  limit: number,
  nowMs = Date.now(),
) {
  requireAgentAdmin(principal, config);
  if (!isAgentDailyLimit(limit)) throw new AgentAdminInvalidLimitError();
  await database.prepare(`
    UPDATE agent_settings
    SET default_daily_limit = ?, version = version + 1,
      updated_at_ms = ?, updated_by_account_key = ?
    WHERE id = 1
  `).bind(limit, nowMs, principal.id).run();
}

export async function setAgentUserDisabled(
  database: AgentDatabase,
  principal: AuthPrincipal,
  config: AgentRuntimeConfig,
  userNumber: number,
  disabled: boolean,
) {
  requireAgentAdmin(principal, config);
  const target = await database.prepare(
    'SELECT role FROM agent_users WHERE id = ?',
  ).bind(userNumber).first<{ role?: string }>();
  if (!target) throw new AgentAdminTargetNotFoundError();
  if (target.role === 'admin') throw new AgentAdminProtectedAccountError();
  await database.prepare('UPDATE agent_users SET disabled = ? WHERE id = ?')
    .bind(disabled ? 1 : 0, userNumber)
    .run();
}

export async function setAgentUserLimit(
  database: AgentDatabase,
  principal: AuthPrincipal,
  config: AgentRuntimeConfig,
  userNumber: number,
  limit: number | null,
) {
  requireAgentAdmin(principal, config);
  if (limit !== null && !isAgentDailyLimit(limit)) throw new AgentAdminInvalidLimitError();
  const target = await database.prepare(
    'SELECT role FROM agent_users WHERE id = ?',
  ).bind(userNumber).first<{ role?: string }>();
  if (!target) throw new AgentAdminTargetNotFoundError();
  if (target.role === 'admin') throw new AgentAdminProtectedAccountError();
  await database.prepare('UPDATE agent_users SET quota_override = ? WHERE id = ?')
    .bind(limit, userNumber)
    .run();
}

export class AgentAdminForbiddenError extends Error {}
export class AgentAdminInvalidLimitError extends Error {}
export class AgentAdminTargetNotFoundError extends Error {}
export class AgentAdminProtectedAccountError extends Error {}
