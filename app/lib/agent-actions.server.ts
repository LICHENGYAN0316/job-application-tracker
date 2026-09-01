import type { AuthPrincipal } from './auth-principal.server.ts';
import { jobIdentityKey, normalizeIdentityPart, STAGES } from './domain.ts';

export const AGENT_ACTION_PROPOSAL_TTL_MS = 10 * 60 * 1_000;
export const AGENT_ACTION_EXECUTION_LEASE_MS = 30_000;
export const AGENT_ACTION_MAX_STATE_BYTES = 2_000_000;

export const createAgentActionProposalsTableSql = `
  CREATE TABLE IF NOT EXISTS agent_action_proposals (
    id TEXT PRIMARY KEY,
    account_key TEXT NOT NULL,
    session_id TEXT NOT NULL,
    source_call_id TEXT NOT NULL DEFAULT '',
    idempotency_key TEXT NOT NULL,
    action_kind TEXT NOT NULL CHECK (
      action_kind IN (
        'add_company', 'add_job', 'add_company_job',
        'update_company', 'update_job', 'delete_company', 'delete_job'
      )
    ),
    base_state_version TEXT NOT NULL,
    target_company_id TEXT NOT NULL DEFAULT '',
    target_job_id TEXT NOT NULL DEFAULT '',
    target_fingerprint TEXT NOT NULL DEFAULT '',
    payload_json TEXT NOT NULL DEFAULT '{}',
    confirmation_nonce_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
      status IN (
        'awaiting_confirmation', 'executing', 'executed', 'cancelled',
        'expired', 'conflict', 'failed'
      )
    ),
    created_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER NOT NULL,
    confirmed_at_ms INTEGER,
    completed_at_ms INTEGER,
    execution_lease_expires_at_ms INTEGER,
    execution_idempotency_key TEXT NOT NULL DEFAULT '',
    result_state_version TEXT NOT NULL DEFAULT '',
    failure_code TEXT NOT NULL DEFAULT '',
    feedback TEXT CHECK (feedback IN ('correct', 'incorrect')),
    feedback_at_ms INTEGER,
    UNIQUE(account_key, idempotency_key)
  ) WITHOUT ROWID
`;

export const createAgentActionEventsTableSql = `
  CREATE TABLE IF NOT EXISTS agent_action_events (
    id TEXT PRIMARY KEY,
    proposal_id TEXT NOT NULL DEFAULT '',
    account_key TEXT NOT NULL,
    session_id TEXT NOT NULL DEFAULT '',
    action_kind TEXT NOT NULL DEFAULT '',
    event_type TEXT NOT NULL,
    reason_code TEXT NOT NULL DEFAULT '',
    schema_valid INTEGER CHECK (schema_valid IN (0, 1)),
    ambiguity_detected INTEGER CHECK (ambiguity_detected IN (0, 1)),
    ambiguity_handled INTEGER CHECK (ambiguity_handled IN (0, 1)),
    parameter_exact INTEGER CHECK (parameter_exact IN (0, 1)),
    user_review_outcome TEXT CHECK (user_review_outcome IN ('correct', 'incorrect')),
    latency_ms INTEGER NOT NULL DEFAULT 0,
    created_at_ms INTEGER NOT NULL
  ) WITHOUT ROWID
`;

export const AGENT_ACTION_TOOL_DEFINITIONS = [
  {
    type: 'function',
    name: 'query_applications',
    description: '只读查询当前账号的公司和岗位；绝不修改数据。不限定的条件传空字符串。',
    strict: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        companyName: { type: 'string', maxLength: 120 },
        title: { type: 'string', maxLength: 160 },
        location: { type: 'string', maxLength: 120 },
        stage: { type: 'string', enum: ['', ...STAGES] },
        appliedAt: {
          type: 'string',
          maxLength: 10,
          description: '空字符串表示不限日期；“未填写”表示只查未填投递日期的岗位；其余使用 YYYY-MM-DD。',
        },
      },
      required: ['companyName', 'title', 'location', 'stage', 'appliedAt'],
    },
  },
  {
    type: 'function',
    name: 'propose_add_company',
    description: '仅提出新增一家公司的待确认提案，不执行写入。未提供招聘网站时传空字符串。',
    strict: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        companyName: { type: 'string', minLength: 1, maxLength: 120 },
        website: { type: 'string', maxLength: 2_000 },
      },
      required: ['companyName', 'website'],
    },
  },
  {
    type: 'function',
    name: 'propose_add_job',
    description: '提出新增岗位的待确认提案，不执行写入。地点、链接和投递日期未提供时必须传空字符串，不得因此拒绝提案。公司不存在时，服务器会转为“先创建公司再新增岗位”的安全确认。',
    strict: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        companyName: { type: 'string', minLength: 1, maxLength: 120 },
        title: { type: 'string', minLength: 1, maxLength: 160 },
        location: { type: 'string', maxLength: 120 },
        portalUrl: { type: 'string', maxLength: 2_000 },
        appliedAt: { type: 'string', maxLength: 10 },
      },
      required: ['companyName', 'title', 'location', 'portalUrl', 'appliedAt'],
    },
  },
  {
    type: 'function',
    name: 'propose_update_company',
    description: '仅提出修改唯一确定公司的待确认提案。null 表示保持原值，不执行写入。',
    strict: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        companyName: { type: 'string', minLength: 1, maxLength: 120 },
        newName: { type: ['string', 'null'], minLength: 1, maxLength: 120 },
        website: { type: ['string', 'null'], maxLength: 2_000 },
      },
      required: ['companyName', 'newName', 'website'],
    },
  },
  {
    type: 'function',
    name: 'propose_update_job',
    description: '仅提出修改唯一确定岗位的待确认提案。原地点只用于匹配；新字段中 null 表示保持原值，空字符串可清空可空字段。',
    strict: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        companyName: { type: 'string', minLength: 1, maxLength: 120 },
        title: { type: 'string', minLength: 1, maxLength: 160 },
        location: { type: 'string', maxLength: 120 },
        newTitle: { type: ['string', 'null'], minLength: 1, maxLength: 160 },
        newLocation: { type: ['string', 'null'], maxLength: 120 },
        portalUrl: { type: ['string', 'null'], maxLength: 2_000 },
        appliedAt: { type: ['string', 'null'], maxLength: 10 },
        stage: { anyOf: [{ type: 'string', enum: [...STAGES] }, { type: 'null' }] },
        priority: { anyOf: [{ type: 'string', enum: ['高', '中', '低'] }, { type: 'null' }] },
        nextAction: { type: ['string', 'null'], maxLength: 500 },
        nextDate: { type: ['string', 'null'], maxLength: 10 },
      },
      required: [
        'companyName', 'title', 'location', 'newTitle', 'newLocation',
        'portalUrl', 'appliedAt', 'stage', 'priority', 'nextAction', 'nextDate',
      ],
    },
  },
  {
    type: 'function',
    name: 'propose_delete_company',
    description: '仅提出删除唯一确定的一家公司的待确认提案，不执行删除。',
    strict: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        companyName: { type: 'string', minLength: 1, maxLength: 120 },
      },
      required: ['companyName'],
    },
  },
  {
    type: 'function',
    name: 'propose_delete_job',
    description: '仅提出删除唯一确定的一个岗位的待确认提案，不执行删除。',
    strict: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        companyName: { type: 'string', minLength: 1, maxLength: 120 },
        title: { type: 'string', minLength: 1, maxLength: 160 },
        location: { type: 'string', maxLength: 120 },
      },
      required: ['companyName', 'title', 'location'],
    },
  },
] as const;

export const AGENT_ACTION_TOOLS = AGENT_ACTION_TOOL_DEFINITIONS;

export type AgentActionKind =
  | 'add_company'
  | 'add_job'
  | 'add_company_job'
  | 'update_company'
  | 'update_job'
  | 'delete_company'
  | 'delete_job';
export type AgentActionStatus =
  | 'awaiting_confirmation'
  | 'executing'
  | 'executed'
  | 'cancelled'
  | 'expired'
  | 'conflict'
  | 'failed';

export type AgentActionToolCall =
  | { kind: 'add_company'; companyName: string; website: string }
  | {
      kind: 'add_job';
      companyName: string;
      title: string;
      location: string;
      portalUrl: string;
      appliedAt: string;
    }
  | {
      kind: 'update_company';
      companyName: string;
      newName: string | null;
      website: string | null;
    }
  | {
      kind: 'update_job';
      companyName: string;
      title: string;
      location: string;
      changes: {
        title?: string;
        location?: string;
        portalUrl?: string;
        appliedAt?: string;
        stage?: string;
        priority?: string;
        nextAction?: string;
        nextDate?: string;
      };
    }
  | { kind: 'delete_company'; companyName: string }
  | { kind: 'delete_job'; companyName: string; title: string; location: string };

export type AgentActionCandidate = {
  id: string;
  label: string;
  detail: string;
};

export type AgentActionPreview = {
  id: string;
  kind: AgentActionKind;
  actionKind: AgentActionKind;
  status: 'awaiting_confirmation';
  destructive: boolean;
  title: string;
  summary: string;
  impactCount: number;
  impact: string;
  fields: Array<{ label: string; value: string }>;
  details: Array<{ label: string; value: string }>;
  expiresAt: string;
  confirmationNonce: string;
};

export type PreparedAgentActionResult =
  | { kind: 'proposal'; proposal: AgentActionPreview }
  | { kind: 'read'; message: string }
  | { kind: 'clarification'; message: string; candidates?: AgentActionCandidate[] };

export type CreateAgentActionProposalResult =
  | { ok: true; proposal: AgentActionPreview }
  | {
      ok: false;
      code:
        | 'invalid_request'
        | 'not_found'
        | 'ambiguous'
        | 'duplicate'
        | 'state_invalid'
        | 'duplicate_request';
      message: string;
      candidates?: AgentActionCandidate[];
    };

export type ConfirmAgentActionResult =
  | {
      ok: true;
      status: 'executed';
      actionId: string;
      actionKind: AgentActionKind;
      state: unknown;
      version: string;
      replayed: boolean;
      message: string;
    }
  | {
      ok: false;
      code:
        | 'invalid_request'
        | 'not_found'
        | 'invalid_confirmation'
        | 'expired'
        | 'cancelled'
        | 'conflict'
        | 'failed'
        | 'in_progress';
      message: string;
    };

export type CancelAgentActionResult =
  | { ok: true; status: 'cancelled'; message: string }
  | {
      ok: false;
      code: 'invalid_request' | 'not_found' | 'invalid_confirmation' | 'expired' | 'already_executed' | 'in_progress';
      message: string;
    };

type AgentActionRunResult = { meta?: { changes?: number } };

export type AgentActionStatement = {
  bind: (...values: unknown[]) => AgentActionStatement;
  first: <T>() => Promise<T | null>;
  run: () => Promise<AgentActionRunResult>;
};

export type AgentActionDatabase = {
  prepare: (query: string) => AgentActionStatement;
  batch?: (statements: AgentActionStatement[]) => Promise<AgentActionRunResult[]>;
};

type AgentActionDependencies = {
  now?: () => number;
  randomId?: () => string;
};

type StoredStateRow = {
  data_json: string;
  version: string;
  deleted_at: string | null;
};

type StoredProposalRow = {
  id: string;
  account_key: string;
  session_id: string;
  action_kind: AgentActionKind;
  base_state_version: string;
  target_company_id: string;
  target_job_id: string;
  target_fingerprint: string;
  payload_json: string;
  confirmation_nonce_hash: string;
  status: AgentActionStatus;
  created_at_ms: number;
  expires_at_ms: number;
  confirmed_at_ms: number | null;
  completed_at_ms: number | null;
  execution_lease_expires_at_ms: number | null;
  execution_idempotency_key: string;
  result_state_version: string;
  failure_code: string;
  feedback: 'correct' | 'incorrect' | null;
};

type CompanyRecord = Record<string, unknown> & {
  id: string;
  name: string;
  website: string;
  jobs: JobRecord[];
};

type JobRecord = Record<string, unknown> & {
  id: string;
  title: string;
  location: string;
  process: unknown[];
};

type ApplicationState = Record<string, unknown> & { companies: CompanyRecord[] };

type LoadedState = {
  state: ApplicationState;
  version: string;
  exists: boolean;
};

type ParsedActionResult =
  | { ok: true; action: AgentActionToolCall }
  | { ok: false; message: string };

const VALID_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VALID_STAGES = new Set<string>(STAGES);

function changed(result: AgentActionRunResult) {
  return (result.meta?.changes ?? 0) === 1;
}

function boundedString(value: unknown, maximumLength: number) {
  if (typeof value !== 'string') return '';
  const normalized = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim();
  return normalized.length <= maximumLength ? normalized : '';
}

function exactKeys(record: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function parseHttpUrl(value: unknown, optional: boolean) {
  const normalized = boundedString(value, 2_000);
  if (!normalized) return optional && value === '' ? '' : null;
  try {
    const url = new URL(normalized);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return normalized;
  } catch {
    return null;
  }
}

function validDate(value: string) {
  if (!value) return true;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

const RELATIVE_DATE_OFFSETS: Record<string, number> = {
  前天: -2,
  昨天: -1,
  昨日: -1,
  今天: 0,
  今日: 0,
  当天: 0,
  明天: 1,
  明日: 1,
  后天: 2,
};

const RELATIVE_DATE_WORDS = '(?:前天|昨天|昨日|今天|今日(?!头条)|当天|明天|明日|后天)';
const APPLICATION_DATE_CONTEXT = '(?:投递日期|申请日期|投递|申请|投了|投的)';
const NEXT_DATE_CONTEXT = '(?:下一步日期|下一次日期|提醒日期|安排日期|面试日期|笔试日期|下一步|提醒|安排|面试|笔试)';

function compactQuestion(value: unknown) {
  return boundedString(value, 800).replace(/\s+/g, '');
}

function relativeDateWordNearContext(question: string, context: string) {
  const match = new RegExp(
    `(?:${context}).{0,12}(${RELATIVE_DATE_WORDS})|(${RELATIVE_DATE_WORDS}).{0,12}(?:${context})`,
  ).exec(question);
  return match?.[1] ?? match?.[2] ?? '';
}

export function agentQuestionUsesRelativeDate(value: unknown) {
  const question = compactQuestion(value);
  return Boolean(
    relativeDateWordNearContext(question, APPLICATION_DATE_CONTEXT)
    || relativeDateWordNearContext(question, NEXT_DATE_CONTEXT),
  );
}

function hasDateContext(question: string, context: string) {
  return new RegExp(context).test(question);
}

function normalizeExplicitDate(value: string, referenceDate = '') {
  const normalized = value.replace(/\//g, '-').replace('年', '-').replace('月', '-').replace('日', '');
  const parts = normalized.split('-');
  if (parts.length === 2 && /^\d{4}-\d{2}-\d{2}$/.test(referenceDate)) {
    parts.unshift(referenceDate.slice(0, 4));
  }
  if (parts.length !== 3) return '';
  const [year, month, day] = parts.map(Number);
  const result = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return validDate(result) ? result : '';
}

function explicitIsoDateNearContext(question: string, context: string, referenceDate = '') {
  const datePattern = '(\\d{4}(?:-|/|年)\\d{1,2}(?:-|/|月)\\d{1,2}日?|\\d{1,2}月\\d{1,2}日)';
  const followingContext = new RegExp(
    `(?:${context})[^,，。；;!！?？]{0,20}?${datePattern}`,
  ).exec(question);
  const followingDate = normalizeExplicitDate(followingContext?.[1] ?? '', referenceDate);
  if (followingDate) return followingDate;
  const precedingContext = new RegExp(
    `${datePattern}[^,，。；;!！?？]{0,12}?(?:${context})`,
  ).exec(question);
  return normalizeExplicitDate(precedingContext?.[1] ?? '', referenceDate);
}

function requestsEmptyDate(question: string, context: string) {
  return new RegExp(
    `(?:${context}).{0,12}(?:未填(?:写)?|未写|没填|没写|不填|留空|空着|没有|无)|(?:未填(?:写)?|未写|没填|没写|不填|留空|空着|没有|无).{0,12}(?:${context})`,
  ).test(question);
}

function addCalendarDays(referenceDate: string, amount: number) {
  const [year, month, day] = referenceDate.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function relativeDateFromQuestion(question: string, context: string, referenceDate: string) {
  const word = relativeDateWordNearContext(question, context);
  if (!word) return { matched: false as const, value: '' };
  if (!referenceDate || !validDate(referenceDate)) {
    return { matched: true as const, value: '', invalidReferenceDate: true as const };
  }
  return {
    matched: true as const,
    value: addCalendarDays(referenceDate, RELATIVE_DATE_OFFSETS[word] ?? 0),
  };
}

function normalizeRelativeToolDates(options: {
  toolName: string;
  argumentsRecord: Record<string, unknown>;
  question: unknown;
  referenceDate: unknown;
}) {
  if (options.toolName !== 'propose_add_job' && options.toolName !== 'propose_update_job') {
    return { ok: true as const, argumentsRecord: options.argumentsRecord };
  }
  const question = compactQuestion(options.question);
  const referenceDate = boundedString(options.referenceDate, 10);
  const argumentsRecord = { ...options.argumentsRecord };

  if (requestsEmptyDate(question, APPLICATION_DATE_CONTEXT)) {
    argumentsRecord.appliedAt = '';
  } else {
    const appliedAt = relativeDateFromQuestion(question, APPLICATION_DATE_CONTEXT, referenceDate);
    if (appliedAt.matched && 'invalidReferenceDate' in appliedAt) {
      return { ok: false as const };
    }
    if (appliedAt.matched) {
      argumentsRecord.appliedAt = appliedAt.value;
    } else {
      const explicitDate = explicitIsoDateNearContext(question, APPLICATION_DATE_CONTEXT, referenceDate);
      if (explicitDate) {
        argumentsRecord.appliedAt = explicitDate;
      } else if (!hasDateContext(question, APPLICATION_DATE_CONTEXT)) {
        argumentsRecord.appliedAt = options.toolName === 'propose_update_job' ? null : '';
      }
    }
  }

  if (options.toolName === 'propose_update_job') {
    if (requestsEmptyDate(question, NEXT_DATE_CONTEXT)) {
      argumentsRecord.nextDate = '';
    } else {
      const nextDate = relativeDateFromQuestion(question, NEXT_DATE_CONTEXT, referenceDate);
      if (nextDate.matched && 'invalidReferenceDate' in nextDate) {
        return { ok: false as const };
      }
      if (nextDate.matched) {
        argumentsRecord.nextDate = nextDate.value;
      } else {
        const explicitDate = explicitIsoDateNearContext(question, NEXT_DATE_CONTEXT, referenceDate)
          || (
            /(?:下一步|待办)/.test(question)
            && !hasDateContext(question, APPLICATION_DATE_CONTEXT)
              ? explicitIsoDateNearContext(question, '(?:日期|时间)', referenceDate)
              : ''
          );
        if (explicitDate) {
          argumentsRecord.nextDate = explicitDate;
        } else if (!hasDateContext(question, NEXT_DATE_CONTEXT)) {
          argumentsRecord.nextDate = null;
        }
      }
    }
  }

  return { ok: true as const, argumentsRecord };
}

const UPDATE_JOB_ARGUMENT_KEYS = [
  'companyName', 'title', 'location', 'newTitle', 'newLocation',
  'portalUrl', 'appliedAt', 'stage', 'priority', 'nextAction', 'nextDate',
] as const;

function cleanCapturedValue(value: string, maximumLength: number) {
  return boundedString(value, maximumLength)
    .replace(/^[“”"'「」『』]+|[“”"'「」『』]+$/g, '')
    .trim();
}

function renamedValueFromQuestion(question: string, target: 'company' | 'job') {
  const normalized = boundedString(question, 800);
  const specific = target === 'company'
    ? /(?:公司名|公司名称).{0,8}(?:改成|改为|设为|重命名为)\s*([^,，。；;!！?？]+)/
    : /(?:岗位名|岗位名称|职位名|职位名称).{0,8}(?:改成|改为|设为|重命名为)\s*([^,，。；;!！?？]+)/;
  const generic = /(?:改名为|重命名为)\s*([^,，。；;!！?？]+)/;
  const match = specific.exec(normalized) ?? generic.exec(normalized);
  return cleanCapturedValue(match?.[1] ?? '', target === 'company' ? 120 : 160);
}

function priorityFromQuestion(question: string) {
  const match = /(?:优先级).{0,10}(?:改成|改为|设成|设为|设置成|设置为|调整为|是)?\s*(高|中|低)(?:优先级)?/.exec(question);
  return match?.[1] ?? '';
}

function nextActionFromQuestion(question: string) {
  const match = /(?:下一步(?!\s*日期)(?:行动)?|待办)\s*(?:改成|改为|设成|设为|设置成|设置为|填写为|填写|改)?\s*[:：]?\s*([^,，。；;!！?？]+?)(?=\s*(?:[,，]\s*(?:日期|时间|下一步日期|提醒日期)|[。；;!！?？]|$))/.exec(question);
  return cleanCapturedValue(match?.[1] ?? '', 500);
}

function portalUrlFromQuestion(question: string) {
  if (!/(?:岗位链接|职位链接|申请链接|投递链接|链接|网址)/.test(question)) return null;
  if (/(?:岗位链接|职位链接|申请链接|投递链接|链接|网址).{0,8}(?:清空|删除|留空|未填|不填)/.test(question)) return '';
  const match = /https?:\/\/[^\s,，。；;!！?？]+/i.exec(question);
  return match?.[0] ?? null;
}

function normalizedStageValue(value: string) {
  const normalized = value.replace(/[\s“”"'「」『』]/g, '').replace(/(?:阶段|状态)$/, '');
  if (VALID_STAGES.has(normalized)) return normalized;
  if (/^(?:投递|已投|已投递)$/.test(normalized)) return '已投递';
  if (/^(?:测评|笔试|测评\/笔试)$/.test(normalized)) return '测评/笔试';
  if (/^(?:初面|一面)$/.test(normalized)) return '一面';
  if (/^(?:二面|三面|四面|复试|终面|后续面试)$/.test(normalized)) return '后续面试';
  if (/^(?:offer|录用|收到offer)$/i.test(normalized)) return 'Offer';
  if (/^(?:人才库|进入人才库)$/.test(normalized)) return '进入人才库';
  if (/^(?:被拒|拒绝|挂了|淘汰)$/.test(normalized)) return '被拒';
  if (/^(?:结束|已结束)$/.test(normalized)) return '已结束';
  if (/^(?:意向|意向岗位)$/.test(normalized)) return '意向岗位';
  return '';
}

function requestedStageFromQuestion(question: string) {
  const explicit = /(?:阶段|状态|招聘流程).{0,8}(?:改成|改为|设成|设为|设置成|设置为|更新为|调整为|推进到)\s*([^,，。；;!！?？]+)/.exec(question)
    ?? /(?:推进到)\s*([^,，。；;!！?？]+)/.exec(question);
  if (explicit) return { explicit: true as const, raw: cleanCapturedValue(explicit[1] ?? '', 40) };
  const generic = /(?:改成|改为|设成|设为|调整为)\s*([^,，。；;!！?？]+)$/.exec(question);
  const raw = cleanCapturedValue(generic?.[1] ?? '', 40);
  return { explicit: false as const, raw: normalizedStageValue(raw) ? raw : '' };
}

function normalizeUpdateArguments(
  toolName: string,
  argumentsRecord: Record<string, unknown>,
  questionValue: unknown,
) {
  const question = boundedString(questionValue, 800);
  if (toolName === 'propose_update_company') {
    const normalized: Record<string, unknown> = {
      companyName: '', newName: null, website: null, ...argumentsRecord,
    };
    const renamed = renamedValueFromQuestion(question, 'company');
    if (renamed) normalized.newName = renamed;
    return { ok: true as const, argumentsRecord: normalized };
  }
  if (toolName !== 'propose_update_job') {
    return { ok: true as const, argumentsRecord };
  }
  const normalized: Record<string, unknown> = Object.fromEntries(
    UPDATE_JOB_ARGUMENT_KEYS.map((key) => [key, ['companyName', 'title', 'location'].includes(key) ? '' : null]),
  );
  Object.assign(normalized, argumentsRecord);
  const renamed = renamedValueFromQuestion(question, 'job');
  const priority = priorityFromQuestion(question);
  const nextAction = nextActionFromQuestion(question);
  const portalUrl = portalUrlFromQuestion(question);
  if (renamed) normalized.newTitle = renamed;
  if (priority) normalized.priority = priority;
  if (nextAction) normalized.nextAction = nextAction;
  if (portalUrl !== null) normalized.portalUrl = portalUrl;

  const requestedStage = requestedStageFromQuestion(question);
  if (requestedStage.raw) {
    const stage = normalizedStageValue(requestedStage.raw);
    if (stage) {
      normalized.stage = stage;
    } else if (requestedStage.explicit) {
      return {
        ok: false as const,
        message: `“${requestedStage.raw}”不是可用的招聘流程。请选择：${[...VALID_STAGES].join('、')}。本次没有修改数据。`,
      };
    }
  } else if (requestedStage.explicit) {
    return {
      ok: false as const,
      message: `“${requestedStage.raw || '该状态'}”不是可用的招聘流程。请选择：${[...VALID_STAGES].join('、')}。本次没有修改数据。`,
    };
  }
  return { ok: true as const, argumentsRecord: normalized };
}

export function parseAgentActionToolCall(value: unknown): ParsedActionResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, message: '操作提案格式不完整，本次没有修改数据。' };
  }
  const record = value as Record<string, unknown>;
  const kind = record.kind;
  if (kind === 'add_company') {
    if (!exactKeys(record, ['kind', 'companyName', 'website'])) {
      return { ok: false, message: '新增公司的参数不完整，本次没有修改数据。' };
    }
    const companyName = boundedString(record.companyName, 120);
    const website = parseHttpUrl(record.website, true);
    if (!companyName || website === null) {
      return { ok: false, message: '请提供公司名称；招聘网站如填写，必须是完整的 http/https 地址。本次没有修改数据。' };
    }
    return { ok: true, action: { kind, companyName, website } };
  }
  if (kind === 'add_job') {
    if (!exactKeys(record, ['kind', 'companyName', 'title', 'location', 'portalUrl', 'appliedAt'])) {
      return { ok: false, message: '新增岗位的参数不完整，本次没有修改数据。' };
    }
    const companyName = boundedString(record.companyName, 120);
    const title = boundedString(record.title, 160);
    const location = boundedString(record.location, 120);
    const portalUrl = parseHttpUrl(record.portalUrl, true);
    const appliedAt = boundedString(record.appliedAt, 10);
    if (!companyName || !title || portalUrl === null || !validDate(appliedAt)) {
      return { ok: false, message: '岗位参数不完整，请核对公司、岗位、链接和日期，本次没有修改数据。' };
    }
    return { ok: true, action: { kind, companyName, title, location, portalUrl, appliedAt } };
  }
  if (kind === 'update_company') {
    if (!exactKeys(record, ['kind', 'companyName', 'newName', 'website'])) {
      return { ok: false, message: '修改公司的参数不完整，本次没有修改数据。' };
    }
    const companyName = boundedString(record.companyName, 120);
    const newName = record.newName === null ? null : boundedString(record.newName, 120);
    const website = record.website === null ? null : parseHttpUrl(record.website, true);
    if (!companyName || (record.newName !== null && !newName) || website === null && record.website !== null) {
      return { ok: false, message: '请核对公司名称和完整的 http/https 网址，本次没有修改数据。' };
    }
    if (newName === null && website === null) {
      return { ok: false, message: '请说明要修改的公司字段，本次没有修改数据。' };
    }
    return { ok: true, action: { kind, companyName, newName, website } };
  }
  if (kind === 'update_job') {
    const keys = [
      'kind', 'companyName', 'title', 'location', 'newTitle', 'newLocation',
      'portalUrl', 'appliedAt', 'stage', 'priority', 'nextAction', 'nextDate',
    ] as const;
    if (!exactKeys(record, keys)) {
      return { ok: false, message: '修改岗位的参数不完整，本次没有修改数据。' };
    }
    const companyName = boundedString(record.companyName, 120);
    const title = boundedString(record.title, 160);
    const location = boundedString(record.location, 120);
    const newTitle = record.newTitle === null ? null : boundedString(record.newTitle, 160);
    const newLocation = record.newLocation === null ? null : boundedString(record.newLocation, 120);
    const portalUrl = record.portalUrl === null ? null : parseHttpUrl(record.portalUrl, true);
    const appliedAt = record.appliedAt === null ? null : boundedString(record.appliedAt, 10);
    const stage = record.stage === null ? null : boundedString(record.stage, 30);
    const priority = record.priority === null ? null : boundedString(record.priority, 10);
    const nextAction = record.nextAction === null ? null : boundedString(record.nextAction, 500);
    const nextDate = record.nextDate === null ? null : boundedString(record.nextDate, 10);
    if (
      !companyName
      || !title
      || (record.newTitle !== null && !newTitle)
      || (record.newLocation !== null && (
        typeof record.newLocation !== 'string' || record.newLocation.length > 120
      ))
      || (record.portalUrl !== null && portalUrl === null)
      || (record.appliedAt !== null && (!validDate(appliedAt ?? '') || typeof record.appliedAt !== 'string'))
      || (record.stage !== null && !VALID_STAGES.has(stage ?? ''))
      || (record.priority !== null && !['高', '中', '低'].includes(priority ?? ''))
      || (record.nextAction !== null && (
        typeof record.nextAction !== 'string' || record.nextAction.length > 500
      ))
      || (record.nextDate !== null && (!validDate(nextDate ?? '') || typeof record.nextDate !== 'string'))
    ) {
      return { ok: false, message: '岗位修改参数未通过校验，本次没有修改数据。' };
    }
    const changes = Object.fromEntries([
      ['title', newTitle],
      ['location', newLocation],
      ['portalUrl', portalUrl],
      ['appliedAt', appliedAt],
      ['stage', stage],
      ['priority', priority],
      ['nextAction', nextAction],
      ['nextDate', nextDate],
    ].filter((entry): entry is [string, string] => entry[1] !== null));
    if (Object.keys(changes).length === 0) {
      return { ok: false, message: '请说明要修改的岗位字段，本次没有修改数据。' };
    }
    return { ok: true, action: { kind, companyName, title, location, changes } };
  }
  if (kind === 'delete_company') {
    if (!exactKeys(record, ['kind', 'companyName'])) {
      return { ok: false, message: '删除公司的参数不完整，本次没有修改数据。' };
    }
    const companyName = boundedString(record.companyName, 120);
    if (!companyName) return { ok: false, message: '请说明要删除的公司，本次没有修改数据。' };
    return { ok: true, action: { kind, companyName } };
  }
  if (kind === 'delete_job') {
    if (!exactKeys(record, ['kind', 'companyName', 'title', 'location'])) {
      return { ok: false, message: '删除岗位的参数不完整，本次没有修改数据。' };
    }
    const companyName = boundedString(record.companyName, 120);
    const title = boundedString(record.title, 160);
    const location = boundedString(record.location, 120);
    if (!companyName || !title) {
      return { ok: false, message: '请说明公司和岗位，本次没有修改数据。' };
    }
    return { ok: true, action: { kind, companyName, title, location } };
  }
  return { ok: false, message: '这类操作尚未开放，本次没有修改数据。' };
}

export async function ensureAgentActionSchema(database: AgentActionDatabase) {
  await database.prepare(createAgentActionProposalsTableSql).run();
  await database.prepare(createAgentActionEventsTableSql).run();
  await database.prepare(
    'CREATE INDEX IF NOT EXISTS agent_action_proposals_account_idx ON agent_action_proposals(account_key, status, expires_at_ms)',
  ).run();
  await database.prepare(
    'CREATE INDEX IF NOT EXISTS agent_action_events_created_idx ON agent_action_events(created_at_ms)',
  ).run();
}

export async function expireAgentActionProposals(
  database: AgentActionDatabase,
  accountKey: string,
  nowMs = Date.now(),
) {
  const result = await database.prepare(`
    UPDATE agent_action_proposals
    SET status = 'expired', completed_at_ms = ?, failure_code = 'proposal_expired',
      payload_json = '{}'
    WHERE account_key = ? AND status = 'awaiting_confirmation' AND expires_at_ms <= ?
  `).bind(nowMs, accountKey, nowMs).run();
  return result.meta?.changes ?? 0;
}

export function agentQuestionAsksRecentActionOutcome(value: unknown) {
  const question = boundedString(value, 800).replace(/\s+/g, '');
  return /(?:刚才|刚刚|上次|之前).*(?:操作|创建|新增|添加|修改|删除).*(?:成功|完成|执行|取消|了吗|了没有|了么)/.test(question);
}

export async function readLatestAgentActionOutcome(
  database: AgentActionDatabase,
  accountKey: string,
  sessionId: string,
) {
  if (!VALID_UUID.test(sessionId)) return '';
  try {
    const row = await database.prepare(`
      SELECT action_kind, status
      FROM agent_action_proposals
      WHERE account_key = ? AND session_id = ?
      ORDER BY created_at_ms DESC
      LIMIT 1
    `).bind(accountKey, sessionId).first<{ action_kind: AgentActionKind; status: AgentActionStatus }>();
    if (!row) return '';
    const labels: Record<AgentActionKind, string> = {
      add_company: '新增公司',
      add_job: '新增岗位',
      add_company_job: '创建公司和岗位',
      update_company: '修改公司',
      update_job: '修改岗位',
      delete_company: '删除公司',
      delete_job: '删除岗位',
    };
    const label = labels[row.action_kind] ?? '操作';
    if (row.status === 'executed') return `刚才的${label}已经确认并保存。`;
    if (row.status === 'cancelled') return `刚才的${label}已取消，没有修改任何求职数据。`;
    if (row.status === 'awaiting_confirmation') return `刚才的${label}仍在等待你确认，尚未修改数据。`;
    if (row.status === 'executing') return `刚才的${label}正在安全保存，请稍后刷新核对。`;
    if (row.status === 'expired') return `刚才的${label}提案已过期，没有修改数据。`;
    if (row.status === 'conflict') return `刚才的${label}因数据版本冲突未执行，没有重复写入。`;
    return `刚才的${label}未完成，没有修改数据。`;
  } catch {
    return '';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validState(value: unknown): value is ApplicationState {
  if (!isRecord(value) || !Array.isArray(value.companies) || value.companies.length > 500) return false;
  return value.companies.every((companyValue) => {
    if (!isRecord(companyValue) || typeof companyValue.id !== 'string' || typeof companyValue.name !== 'string') return false;
    if (!Array.isArray(companyValue.jobs) || companyValue.jobs.length > 500) return false;
    return companyValue.jobs.every((jobValue) => {
      if (!isRecord(jobValue) || typeof jobValue.id !== 'string' || typeof jobValue.title !== 'string') return false;
      if (typeof jobValue.stage !== 'string' || !VALID_STAGES.has(jobValue.stage)) return false;
      if (!Array.isArray(jobValue.process) || jobValue.process.length > 1_000) return false;
      return jobValue.process.every((event) => (
        isRecord(event)
        && typeof event.id === 'string'
        && typeof event.stage === 'string'
        && VALID_STAGES.has(event.stage)
      ));
    });
  });
}

function companyRecord(value: Record<string, unknown>): CompanyRecord {
  return value as CompanyRecord;
}

function jobRecord(value: Record<string, unknown>): JobRecord {
  return value as JobRecord;
}

async function loadState(database: AgentActionDatabase, accountKey: string): Promise<LoadedState | null> {
  const row = await database.prepare(`
    SELECT data_json, version, deleted_at
    FROM application_states WHERE user_id = ?
  `).bind(accountKey).first<StoredStateRow>();
  if (!row) return { state: { companies: [] }, version: 'none', exists: false };
  // Keep the exact stored value for the guarded CAS. Historical rows may use
  // an empty version; the public state API labels that value as "legacy", but
  // the database UPDATE must still compare against the real empty string.
  const version = typeof row.version === 'string' ? row.version : '';
  if (row.deleted_at) return { state: { companies: [] }, version, exists: true };
  try {
    const state = JSON.parse(row.data_json) as unknown;
    return validState(state) ? { state, version, exists: true } : null;
  } catch {
    return null;
  }
}

function stateBytes(state: unknown) {
  return new TextEncoder().encode(JSON.stringify(state)).byteLength;
}

function canonicalWebsite(value: string) {
  try {
    const url = new URL(value);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    return `${url.protocol.toLowerCase()}//${url.hostname.toLowerCase()}${url.port ? `:${url.port}` : ''}${pathname}${url.search}`;
  } catch {
    return value.trim().toLocaleLowerCase();
  }
}

function matchingCompanies(state: ApplicationState, name: string) {
  const key = normalizeIdentityPart(name);
  return state.companies.filter((company) => normalizeIdentityPart(company.name) === key);
}

function companyCandidates(companies: CompanyRecord[]): AgentActionCandidate[] {
  return companies.slice(0, 10).map((company) => ({
    id: company.id,
    label: company.name,
    detail: `${typeof company.website === 'string' && company.website ? company.website : '未填写网站'} · ${company.jobs.length} 个岗位`,
  }));
}

function matchingJobs(company: CompanyRecord, title: string, location: string) {
  const titleKey = normalizeIdentityPart(title);
  const locationKey = normalizeIdentityPart(location);
  return company.jobs.filter((job) => (
    normalizeIdentityPart(job.title) === titleKey
    && (!location || normalizeIdentityPart(typeof job.location === 'string' ? job.location : '') === locationKey)
  ));
}

function questionIdentity(value: string) {
  return normalizeIdentityPart(value).replace(/\s+/g, '');
}

function questionContainsIdentity(question: string, value: string) {
  const identity = questionIdentity(value);
  return Boolean(identity) && questionIdentity(question).includes(identity);
}

function mostSpecificMentionedJobs<T extends { job: JobRecord }>(matches: T[]) {
  return matches.filter(({ job }, index) => {
    const title = questionIdentity(job.title);
    return !matches.some(({ job: otherJob }, otherIndex) => {
      if (index === otherIndex) return false;
      const otherTitle = questionIdentity(otherJob.title);
      return otherTitle.length > title.length && otherTitle.includes(title);
    });
  });
}

async function resolveKnownToolTargets(options: {
  database: AgentActionDatabase;
  accountKey: string;
  toolName: string;
  argumentsRecord: Record<string, unknown>;
  question: unknown;
}): Promise<{
  argumentsRecord: Record<string, unknown>;
  ambiguousCandidates?: AgentActionCandidate[];
}> {
  const question = boundedString(options.question, 800);
  if (!question) return { argumentsRecord: options.argumentsRecord };
  const loaded = await loadState(options.database, options.accountKey);
  if (!loaded) return { argumentsRecord: options.argumentsRecord };
  const argumentsRecord = { ...options.argumentsRecord };
  const companyMatches = loaded.state.companies
    .filter((company) => questionContainsIdentity(question, company.name))
    .sort((left, right) => questionIdentity(right.name).length - questionIdentity(left.name).length);
  const longestCompany = companyMatches[0];
  const sameLengthCompany = longestCompany
    ? companyMatches.filter((company) => questionIdentity(company.name).length === questionIdentity(longestCompany.name).length)
    : [];
  const company = sameLengthCompany.length === 1 ? longestCompany : null;

  const mentionedJobs = mostSpecificMentionedJobs(
    loaded.state.companies.flatMap((candidateCompany) => candidateCompany.jobs.flatMap((job) => (
      questionContainsIdentity(question, job.title)
        ? [{ company: candidateCompany, job }]
        : []
    ))),
  );
  const jobMatches = company
    ? mentionedJobs.filter(({ company: candidateCompany }) => candidateCompany.id === company.id)
    : mentionedJobs;
  const locationMatches = jobMatches.filter(({ job }) => (
    typeof job.location === 'string'
    && Boolean(job.location)
    && questionContainsIdentity(question, job.location)
  ));
  const uniqueJob = locationMatches.length === 1
    ? locationMatches[0]
    : jobMatches.length === 1
      ? jobMatches[0]
      : null;

  if (['propose_update_job', 'propose_delete_job', 'query_applications'].includes(options.toolName) && uniqueJob) {
    argumentsRecord.companyName = uniqueJob.company.name;
    argumentsRecord.title = uniqueJob.job.title;
    argumentsRecord.location = typeof uniqueJob.job.location === 'string' ? uniqueJob.job.location : '';
    return { argumentsRecord };
  }
  if (
    ['propose_update_job', 'propose_delete_job'].includes(options.toolName)
    && jobMatches.length > 1
  ) {
    return {
      argumentsRecord,
      ambiguousCandidates: jobMatches.slice(0, 10).map(({ company: candidateCompany, job }) => ({
        id: job.id,
        label: `${candidateCompany.name} · ${job.title}`,
        detail: typeof job.location === 'string' && job.location ? job.location : '地点未填写',
      })),
    };
  }
  if (['propose_update_company', 'propose_delete_company', 'query_applications'].includes(options.toolName) && company) {
    argumentsRecord.companyName = company.name;
    if (options.toolName === 'query_applications') {
      argumentsRecord.title = '';
      argumentsRecord.location = '';
    }
  }
  return { argumentsRecord };
}

function jobCandidates(company: CompanyRecord, jobs: JobRecord[]): AgentActionCandidate[] {
  return jobs.slice(0, 10).map((job) => ({
    id: job.id,
    label: `${company.name} · ${job.title}`,
    detail: typeof job.location === 'string' && job.location ? job.location : '地点未填写',
  }));
}

type AgentReadQuery = {
  companyName: string;
  title: string;
  location: string;
  stage: string;
  appliedAt: string;
};

function parseAgentReadQuery(value: unknown): AgentReadQuery | null {
  if (!isRecord(value)) return null;
  const currentKeys = ['companyName', 'title', 'location', 'stage', 'appliedAt'] as const;
  const legacyKeys = ['companyName', 'title', 'location', 'stage'] as const;
  if (!exactKeys(value, currentKeys) && !exactKeys(value, legacyKeys)) return null;
  const companyName = boundedString(value.companyName, 120);
  const title = boundedString(value.title, 160);
  const location = boundedString(value.location, 120);
  const stage = boundedString(value.stage, 30);
  const appliedAt = 'appliedAt' in value ? boundedString(value.appliedAt, 10) : '';
  if (
    typeof value.companyName !== 'string'
    || typeof value.title !== 'string'
    || typeof value.location !== 'string'
    || typeof value.stage !== 'string'
    || ('appliedAt' in value && typeof value.appliedAt !== 'string')
    || (stage && !VALID_STAGES.has(stage))
    || (appliedAt && appliedAt !== '未填写' && !validDate(appliedAt))
  ) return null;
  return { companyName, title, location, stage, appliedAt };
}

function normalizeMention(value: string) {
  return normalizeIdentityPart(value).replace(/\s+/g, '');
}

function exactIdentity(value: string, search: string) {
  return normalizeIdentityPart(value) === normalizeIdentityPart(search);
}

function containsIdentity(value: string, search: string) {
  return normalizeIdentityPart(value).includes(normalizeIdentityPart(search));
}

function stagesMentionedInQuestion(question: string) {
  const normalized = normalizeMention(question);
  const stages = new Set<string>();
  for (const stage of STAGES) {
    if (normalized.includes(normalizeMention(stage))) stages.add(stage);
  }
  if (/(?:二面|三面|终面|后续轮次|复试)/.test(normalized)) stages.add('后续面试');
  if (normalized.includes('笔试')) stages.add('测评/笔试');
  return stages;
}

function normalizeAgentReadQueryDates(
  value: Record<string, unknown> | null,
  questionValue: unknown,
  referenceDateValue: unknown,
) {
  if (!value) return { ok: true as const, value };
  const question = compactQuestion(questionValue);
  const referenceDate = boundedString(referenceDateValue, 10);
  const normalized = { ...value, appliedAt: typeof value.appliedAt === 'string' ? value.appliedAt : '' };
  if (requestsEmptyDate(question, APPLICATION_DATE_CONTEXT)) {
    normalized.appliedAt = '未填写';
    return { ok: true as const, value: normalized };
  }
  const relativeDate = relativeDateFromQuestion(question, APPLICATION_DATE_CONTEXT, referenceDate);
  if (relativeDate.matched && 'invalidReferenceDate' in relativeDate) return { ok: false as const, value: normalized };
  if (relativeDate.matched) {
    normalized.appliedAt = relativeDate.value;
  } else {
    const explicitDate = explicitIsoDateNearContext(question, APPLICATION_DATE_CONTEXT, referenceDate);
    const modelDate = typeof value.appliedAt === 'string'
      && validDate(value.appliedAt)
      && value.appliedAt
      ? value.appliedAt
      : '';
    const questionContainsExplicitDate = /(?:\d{4}(?:-|\/|年)\d{1,2}(?:-|\/|月)\d{1,2}日?|\d{1,2}月\d{1,2}日)/.test(question);
    normalized.appliedAt = explicitDate
      || (questionContainsExplicitDate && hasDateContext(question, APPLICATION_DATE_CONTEXT) ? modelDate : '')
      || '';
  }
  return { ok: true as const, value: normalized };
}

async function executeAgentReadQuery(
  database: AgentActionDatabase,
  accountKey: string,
  query: AgentReadQuery,
  question: string,
) {
  const loaded = await loadState(database, accountKey);
  if (!loaded) return '当前求职数据暂时无法安全读取，本次没有修改任何数据。';
  const normalizedQuestion = normalizeMention(question);
  const explicitlyMentionedCompanies = loaded.state.companies.filter((company) => (
    normalizedQuestion.includes(normalizeMention(company.name))
  ));
  const companies = explicitlyMentionedCompanies.length > 0
    ? explicitlyMentionedCompanies
    : query.companyName
      ? loaded.state.companies.filter((company) => exactIdentity(company.name, query.companyName))
      : loaded.state.companies;
  const explicitlyMentionedJobIds = new Set(mostSpecificMentionedJobs(
    companies.flatMap((company) => company.jobs.flatMap((job) => (
      normalizedQuestion.includes(normalizeMention(job.title)) ? [{ company, job }] : []
    ))),
  ).map(({ job }) => job.id));
  const exactTitleExists = Boolean(query.title) && companies.some((company) => (
    company.jobs.some((job) => exactIdentity(job.title, query.title))
  ));
  const requestedStages = stagesMentionedInQuestion(question);
  if (requestedStages.size === 0 && query.stage) requestedStages.add(query.stage);
  const matches = companies.flatMap((company) => company.jobs.flatMap((job) => {
    const jobLocation = typeof job.location === 'string' ? job.location : '';
    const jobStage = typeof job.stage === 'string' ? job.stage : '';
    const jobAppliedAt = typeof job.appliedAt === 'string' ? job.appliedAt : '';
    const titleMatches = explicitlyMentionedJobIds.size > 0
      ? explicitlyMentionedJobIds.has(job.id)
      : !query.title
        || (exactTitleExists ? exactIdentity(job.title, query.title) : containsIdentity(job.title, query.title));
    if (
      !titleMatches
      || (query.location && !exactIdentity(jobLocation, query.location))
      || (requestedStages.size > 0 && !requestedStages.has(jobStage))
      || (query.appliedAt === '未填写' && Boolean(jobAppliedAt))
      || (query.appliedAt && query.appliedAt !== '未填写' && jobAppliedAt !== query.appliedAt)
    ) return [];
    return [{ company, job, jobLocation, jobStage, jobAppliedAt }];
  }));
  if (matches.length === 0) {
    if (companies.length === 1 && !query.title && !query.location && !query.stage && !query.appliedAt) {
      return `已找到“${companies[0].name}”，当前还没有岗位记录。`;
    }
    return '没有找到符合条件的岗位，本次查询不会修改数据。';
  }
  const stageCounts = new Map<string, number>();
  for (const { jobStage } of matches) stageCounts.set(jobStage, (stageCounts.get(jobStage) ?? 0) + 1);
  const stageSummary = STAGES.flatMap((stage) => {
    const count = stageCounts.get(stage) ?? 0;
    return count > 0 ? [`${stage} ${count}`] : [];
  }).join('、');
  const visibleMatches = matches.slice(0, 100);
  const lines = visibleMatches.map(({ company, job, jobLocation, jobStage, jobAppliedAt }) => {
    const appliedAt = jobAppliedAt || '未填写投递日期';
    return `· ${company.name} · ${job.title} · ${jobLocation || '地点未填写'} · ${jobStage || '流程未填写'} · ${appliedAt}`;
  });
  return [
    `${/(比较|对比)/.test(question) ? '对比找到' : '找到'} ${matches.length} 个符合条件的岗位：`,
    `阶段分布：${stageSummary || '暂无可统计阶段'}。`,
    ...lines,
    ...(matches.length > visibleMatches.length
      ? [`当前展示第 1–${visibleMatches.length} 个，共 ${matches.length} 个；请指定公司、阶段或日期继续查询。`]
      : []),
  ].join('\n');
}

async function digest(value: string) {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function stableUuid(value: string) {
  const hash = await digest(value);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

async function fingerprint(value: unknown) {
  return digest(JSON.stringify(value));
}

function proposalRow(database: AgentActionDatabase, id: string, accountKey: string) {
  return database.prepare(`
    SELECT id, account_key, session_id, action_kind, base_state_version,
      target_company_id, target_job_id, target_fingerprint, payload_json,
      confirmation_nonce_hash, status, created_at_ms, expires_at_ms,
      confirmed_at_ms, completed_at_ms, execution_lease_expires_at_ms,
      execution_idempotency_key, result_state_version, failure_code, feedback
    FROM agent_action_proposals WHERE id = ? AND account_key = ?
  `).bind(id, accountKey).first<StoredProposalRow>();
}

function proposalByIdempotency(database: AgentActionDatabase, accountKey: string, idempotencyKey: string) {
  return database.prepare(`
    SELECT id, account_key, session_id, action_kind, base_state_version,
      target_company_id, target_job_id, target_fingerprint, payload_json,
      confirmation_nonce_hash, status, created_at_ms, expires_at_ms,
      confirmed_at_ms, completed_at_ms, execution_lease_expires_at_ms,
      execution_idempotency_key, result_state_version, failure_code, feedback
    FROM agent_action_proposals WHERE account_key = ? AND idempotency_key = ?
  `).bind(accountKey, idempotencyKey).first<StoredProposalRow>();
}

function safePayload(row: StoredProposalRow) {
  try {
    const value = JSON.parse(row.payload_json) as unknown;
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function previewFromProposal(
  row: StoredProposalRow,
  state: ApplicationState,
  confirmationNonce: string,
): AgentActionPreview | null {
  const payload = safePayload(row);
  if (!payload) return null;
  const company = state.companies.find((item) => item.id === row.target_company_id);
  const job = company?.jobs.find((item) => item.id === row.target_job_id);
  let title = '';
  let summary = '';
  let impactCount = 1;
  let impact = '新增 1 条记录';
  let fields: Array<{ label: string; value: string }> = [];
  if (row.action_kind === 'add_company') {
    const name = boundedString(payload.name, 120);
    const website = boundedString(payload.website, 2_000);
    if (!name) return null;
    title = '新增公司';
    impact = '新增 1 家公司';
    summary = `待新增“${name}”，确认前不会写入。`;
    fields = [{ label: '公司', value: name }, { label: '招聘网站', value: website || '未填写' }];
  } else if (row.action_kind === 'add_company_job') {
    const companyName = boundedString(payload.companyName, 120);
    const jobTitle = boundedString(payload.title, 160);
    if (!companyName || !jobTitle) return null;
    title = '创建公司并新增岗位';
    impactCount = 2;
    impact = '新增 1 家公司和 1 个岗位';
    summary = `尚未找到“${companyName}”。确认后将先创建该公司，再新增“${jobTitle}”岗位。`;
    fields = [
      { label: '公司', value: companyName },
      { label: '公司网站', value: '未填写' },
      { label: '岗位', value: jobTitle },
      { label: '地点', value: boundedString(payload.location, 120) || '未填写' },
      { label: '岗位链接', value: boundedString(payload.portalUrl, 2_000) || '未填写' },
      { label: '投递日期', value: boundedString(payload.appliedAt, 10) || '未填写' },
    ];
  } else if (row.action_kind === 'add_job') {
    const jobTitle = boundedString(payload.title, 160);
    if (!company || !jobTitle) return null;
    title = '新增岗位';
    impact = '新增 1 个岗位';
    summary = `待向“${company.name}”新增“${jobTitle}”，确认前不会写入。`;
    fields = [
      { label: '公司', value: company.name },
      { label: '岗位', value: jobTitle },
      { label: '地点', value: boundedString(payload.location, 120) || '未填写' },
      { label: '岗位链接', value: boundedString(payload.portalUrl, 2_000) || '未填写' },
      { label: '投递日期', value: boundedString(payload.appliedAt, 10) || '未填写' },
    ];
  } else if (row.action_kind === 'update_company') {
    if (!company) return null;
    const changes = isRecord(payload.changes) ? payload.changes : null;
    if (!changes) return null;
    title = '修改公司';
    impact = '修改 1 家公司';
    summary = `待修改“${company.name}”，确认前不会写入。`;
    fields = Object.entries(changes).flatMap(([key, value]) => {
      if (typeof value !== 'string') return [];
      const label = key === 'name' ? '公司名称' : key === 'website' ? '招聘网站' : key;
      const before = key === 'name' ? company.name : typeof company[key] === 'string' ? company[key] as string : '';
      return [{ label, value: `${before || '未填写'} → ${value || '未填写'}` }];
    });
    if (fields.length === 0) return null;
  } else if (row.action_kind === 'update_job') {
    if (!company || !job) return null;
    const changes = isRecord(payload.changes) ? payload.changes : null;
    if (!changes) return null;
    const labels: Record<string, string> = {
      title: '岗位名称', location: '地点', portalUrl: '岗位链接', appliedAt: '投递日期',
      stage: '招聘流程', priority: '优先级', nextAction: '下一步行动', nextDate: '下一步日期',
    };
    title = '修改岗位';
    impact = '修改 1 个岗位';
    summary = `待修改“${company.name} · ${job.title}”，确认前不会写入。`;
    fields = Object.entries(changes).flatMap(([key, value]) => {
      if (typeof value !== 'string' || !labels[key]) return [];
      const before = typeof job[key] === 'string' ? job[key] as string : '';
      return [{ label: labels[key], value: `${before || '未填写'} → ${value || '未填写'}` }];
    });
    if (fields.length === 0) return null;
  } else if (row.action_kind === 'delete_company') {
    if (!company) return null;
    title = '删除公司';
    impactCount = company.jobs.length;
    impact = `删除 1 家公司及其 ${company.jobs.length} 个岗位`;
    summary = `将删除“${company.name}”及其 ${company.jobs.length} 个岗位，仍需红色危险确认。`;
    fields = [{ label: '公司', value: company.name }, { label: '同时删除岗位', value: String(company.jobs.length) }];
  } else if (row.action_kind === 'delete_job') {
    if (!company || !job) return null;
    title = '删除岗位';
    impactCount = Array.isArray(job.process) ? job.process.length : 0;
    impact = `删除 1 个岗位及 ${impactCount} 条流程记录`;
    summary = `将删除“${company.name} · ${job.title}”及其流程记录，仍需红色危险确认。`;
    fields = [
      { label: '公司', value: company.name },
      { label: '岗位', value: job.title },
      { label: '流程记录', value: String(impactCount) },
    ];
  } else return null;
  return {
    id: row.id,
    kind: row.action_kind,
    actionKind: row.action_kind,
    status: 'awaiting_confirmation',
    destructive: row.action_kind.startsWith('delete_'),
    title,
    summary,
    impactCount,
    impact,
    fields,
    details: fields,
    expiresAt: new Date(row.expires_at_ms).toISOString(),
    confirmationNonce,
  };
}

async function recordEvent(
  database: AgentActionDatabase,
  values: {
    id: string;
    proposalId?: string;
    accountKey: string;
    sessionId?: string;
    actionKind?: AgentActionKind;
    eventType: string;
    reasonCode?: string;
    schemaValid?: boolean;
    ambiguityDetected?: boolean;
    ambiguityHandled?: boolean;
    parameterExact?: boolean;
    review?: 'correct' | 'incorrect';
    latencyMs?: number;
    nowMs: number;
  },
) {
  try {
    await database.prepare(`
      INSERT OR IGNORE INTO agent_action_events (
        id, proposal_id, account_key, session_id, action_kind, event_type,
        reason_code, schema_valid, ambiguity_detected, ambiguity_handled,
        parameter_exact, user_review_outcome, latency_ms, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      values.id,
      values.proposalId ?? '',
      values.accountKey,
      values.sessionId ?? '',
      values.actionKind ?? '',
      values.eventType,
      values.reasonCode ?? '',
      values.schemaValid === undefined ? null : values.schemaValid ? 1 : 0,
      values.ambiguityDetected === undefined ? null : values.ambiguityDetected ? 1 : 0,
      values.ambiguityHandled === undefined ? null : values.ambiguityHandled ? 1 : 0,
      values.parameterExact === undefined ? null : values.parameterExact ? 1 : 0,
      values.review ?? null,
      Math.max(0, Math.floor(values.latencyMs ?? 0)),
      values.nowMs,
    ).run();
  } catch {
    // Telemetry must not turn a safely rejected proposal into a mutation.
  }
}

function actionFailure(
  code: Exclude<CreateAgentActionProposalResult, { ok: true }>['code'],
  message: string,
  candidates?: AgentActionCandidate[],
): CreateAgentActionProposalResult {
  return candidates?.length ? { ok: false, code, message, candidates } : { ok: false, code, message };
}

export async function createAgentActionProposal(options: {
  database: AgentActionDatabase;
  principal: AuthPrincipal;
  sessionId: unknown;
  sourceCallId?: unknown;
  idempotencyKey: unknown;
  confirmationNonce: unknown;
  toolCall: unknown;
  dependencies?: AgentActionDependencies;
}): Promise<CreateAgentActionProposalResult> {
  const nowMs = (options.dependencies?.now ?? Date.now)();
  await expireAgentActionProposals(options.database, options.principal.id, nowMs);
  const randomId = options.dependencies?.randomId ?? (() => crypto.randomUUID());
  const sessionId = boundedString(options.sessionId, 100);
  const sourceCallId = boundedString(options.sourceCallId, 100);
  const idempotencyKey = boundedString(options.idempotencyKey, 120);
  const confirmationNonce = boundedString(options.confirmationNonce, 120);
  const parsed = parseAgentActionToolCall(options.toolCall);
  if (!VALID_UUID.test(sessionId) || !VALID_UUID.test(idempotencyKey) || !VALID_UUID.test(confirmationNonce) || !parsed.ok) {
    await recordEvent(options.database, {
      id: randomId(),
      accountKey: options.principal.id,
      sessionId: VALID_UUID.test(sessionId) ? sessionId : '',
      actionKind: parsed.ok ? parsed.action.kind : undefined,
      eventType: 'proposal_rejected',
      reasonCode: 'invalid_schema',
      schemaValid: false,
      nowMs,
    });
    return actionFailure('invalid_request', parsed.ok
      ? '操作提案缺少安全标识，本次没有修改数据。'
      : parsed.message);
  }

  const nonceHash = await digest(confirmationNonce);
  const existing = await proposalByIdempotency(options.database, options.principal.id, idempotencyKey);
  if (existing) {
    if (
      existing.status === 'awaiting_confirmation'
      && existing.expires_at_ms > nowMs
      && existing.confirmation_nonce_hash === nonceHash
    ) {
      const loaded = await loadState(options.database, options.principal.id);
      const preview = loaded ? previewFromProposal(existing, loaded.state, confirmationNonce) : null;
      if (preview) return { ok: true, proposal: preview };
    }
    return actionFailure('duplicate_request', '这次操作请求已经处理，本次没有重复写入。');
  }

  const loaded = await loadState(options.database, options.principal.id);
  if (!loaded) return actionFailure('state_invalid', '当前求职数据无法安全读取，本次没有修改数据。');
  const { state } = loaded;
  const action = parsed.action;
  let proposalActionKind: AgentActionKind = action.kind;
  let targetCompanyId = '';
  let targetJobId = '';
  let targetFingerprint = '';
  let payload: Record<string, unknown> = {};

  if (action.kind === 'add_company') {
    const nameKey = normalizeIdentityPart(action.companyName);
    const websiteKey = canonicalWebsite(action.website);
    const duplicate = state.companies.find((company) => (
      normalizeIdentityPart(company.name) === nameKey
      || (Boolean(action.website) && typeof company.website === 'string' && Boolean(company.website)
        && canonicalWebsite(company.website) === websiteKey)
    ));
    if (duplicate) {
      await recordEvent(options.database, {
        id: randomId(), accountKey: options.principal.id, sessionId, actionKind: action.kind,
        eventType: 'proposal_rejected', reasonCode: 'duplicate', schemaValid: true, nowMs,
      });
      return actionFailure('duplicate', `“${duplicate.name}”已存在，本次没有重复新增。`);
    }
    payload = {
      newCompanyId: `company-${nowMs}-${randomId().slice(0, 8)}`,
      name: action.companyName,
      website: action.website,
    };
  } else {
    const companies = matchingCompanies(state, action.companyName);
    if (companies.length === 0) {
      if (action.kind === 'add_job') {
        proposalActionKind = 'add_company_job';
        payload = {
          newCompanyId: `company-${nowMs}-${randomId().slice(0, 8)}`,
          newJobId: `job-${nowMs}-${randomId().slice(0, 8)}`,
          companyName: action.companyName,
          title: action.title,
          location: action.location,
          portalUrl: action.portalUrl,
          appliedAt: action.appliedAt,
        };
      } else {
        await recordEvent(options.database, {
          id: randomId(), accountKey: options.principal.id, sessionId, actionKind: action.kind,
          eventType: 'clarification_required', reasonCode: 'company_not_found', schemaValid: true,
          ambiguityDetected: true, ambiguityHandled: true, nowMs,
        });
        return actionFailure('not_found', `没有找到名为“${action.companyName}”的公司，本次没有修改数据。`);
      }
    } else if (companies.length > 1) {
      await recordEvent(options.database, {
        id: randomId(), accountKey: options.principal.id, sessionId, actionKind: action.kind,
        eventType: 'clarification_required', reasonCode: 'ambiguous_company', schemaValid: true,
        ambiguityDetected: true, ambiguityHandled: true, nowMs,
      });
      return actionFailure(
        'ambiguous',
        `找到 ${companies.length} 家同名公司，请先明确选择，本次没有修改数据。`,
        companyCandidates(companies),
      );
    } else {
      const company = companies[0];
      targetCompanyId = company.id;
      if (action.kind === 'add_job') {
        const duplicate = company.jobs.find((job) => jobIdentityKey(
          job.title,
          typeof job.location === 'string' ? job.location : '',
        ) === jobIdentityKey(action.title, action.location));
        if (duplicate) {
          await recordEvent(options.database, {
            id: randomId(), accountKey: options.principal.id, sessionId, actionKind: action.kind,
            eventType: 'proposal_rejected', reasonCode: 'duplicate', schemaValid: true, nowMs,
          });
          return actionFailure('duplicate', `“${duplicate.title}”在当前公司和地点下已存在，本次没有重复新增。`);
        }
        targetFingerprint = await fingerprint(company);
        payload = {
          newJobId: `job-${nowMs}-${randomId().slice(0, 8)}`,
          title: action.title,
          location: action.location,
          portalUrl: action.portalUrl,
          appliedAt: action.appliedAt,
        };
      } else if (action.kind === 'update_company') {
        const changes: Record<string, string> = {};
        if (action.newName !== null && action.newName !== company.name) {
          const duplicateName = state.companies.find((item) => (
            item.id !== company.id
            && normalizeIdentityPart(item.name) === normalizeIdentityPart(action.newName ?? '')
          ));
          if (duplicateName) return actionFailure('duplicate', `“${duplicateName.name}”已存在，本次没有修改数据。`);
          changes.name = action.newName;
        }
        if (action.website !== null && action.website !== company.website) {
          const duplicateWebsite = action.website && state.companies.find((item) => (
            item.id !== company.id && canonicalWebsite(item.website) === canonicalWebsite(action.website ?? '')
          ));
          if (duplicateWebsite) return actionFailure('duplicate', `该招聘网站已属于“${duplicateWebsite.name}”，本次没有修改数据。`);
          changes.website = action.website;
        }
        if (Object.keys(changes).length === 0) return actionFailure('duplicate', '新内容与当前公司信息相同，本次无需修改。');
        targetFingerprint = await fingerprint(company);
        payload = { changes };
      } else if (action.kind === 'delete_company') {
        targetFingerprint = await fingerprint(company);
      } else {
        const jobs = matchingJobs(company, action.title, action.location);
        if (jobs.length === 0) {
          await recordEvent(options.database, {
            id: randomId(), accountKey: options.principal.id, sessionId, actionKind: action.kind,
            eventType: 'clarification_required', reasonCode: 'job_not_found', schemaValid: true,
            ambiguityDetected: true, ambiguityHandled: true, nowMs,
          });
          return actionFailure('not_found', `没有在“${company.name}”找到“${action.title}”，本次没有修改数据。`);
        }
        if (jobs.length > 1) {
          await recordEvent(options.database, {
            id: randomId(), accountKey: options.principal.id, sessionId, actionKind: action.kind,
            eventType: 'clarification_required', reasonCode: 'ambiguous_job', schemaValid: true,
            ambiguityDetected: true, ambiguityHandled: true, nowMs,
          });
          return actionFailure(
            'ambiguous',
            `找到 ${jobs.length} 个同名岗位，请补充地点后再试，本次没有修改数据。`,
            jobCandidates(company, jobs),
          );
        }
        const job = jobs[0];
        targetJobId = job.id;
        targetFingerprint = await fingerprint(job);
        if (action.kind === 'update_job') {
          const changes = Object.fromEntries(Object.entries(action.changes).filter(([key, value]) => (
            typeof value === 'string' && value !== (typeof job[key] === 'string' ? job[key] : '')
          )));
          if (Object.keys(changes).length === 0) return actionFailure('duplicate', '新内容与当前岗位信息相同，本次无需修改。');
          const nextTitle = typeof changes.title === 'string' ? changes.title : job.title;
          const nextLocation = typeof changes.location === 'string'
            ? changes.location
            : typeof job.location === 'string' ? job.location : '';
          const duplicate = company.jobs.find((item) => (
            item.id !== job.id
            && jobIdentityKey(item.title, typeof item.location === 'string' ? item.location : '')
              === jobIdentityKey(nextTitle, nextLocation)
          ));
          if (duplicate) return actionFailure('duplicate', '修改后会与现有岗位重复，本次没有修改数据。');
          payload = { changes };
        }
      }
    }
  }

  const proposalId = randomId();
  const expiresAtMs = nowMs + AGENT_ACTION_PROPOSAL_TTL_MS;
  const insert = await options.database.prepare(`
    INSERT INTO agent_action_proposals (
      id, account_key, session_id, source_call_id, idempotency_key, action_kind,
      base_state_version, target_company_id, target_job_id, target_fingerprint,
      payload_json, confirmation_nonce_hash, status, created_at_ms, expires_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_confirmation', ?, ?)
    ON CONFLICT(account_key, idempotency_key) DO NOTHING
  `).bind(
    proposalId,
    options.principal.id,
    sessionId,
    sourceCallId,
    idempotencyKey,
    proposalActionKind,
    loaded.version,
    targetCompanyId,
    targetJobId,
    targetFingerprint,
    JSON.stringify(payload),
    nonceHash,
    nowMs,
    expiresAtMs,
  ).run();
  if (!changed(insert)) return actionFailure('duplicate_request', '这次操作请求已经处理，本次没有重复写入。');

  const row = await proposalRow(options.database, proposalId, options.principal.id);
  const preview = row ? previewFromProposal(row, state, confirmationNonce) : null;
  if (!row || !preview) {
    await options.database.prepare(`
      UPDATE agent_action_proposals
      SET status = 'failed', completed_at_ms = ?, failure_code = 'preview_failed', payload_json = '{}'
      WHERE id = ? AND account_key = ? AND status = 'awaiting_confirmation'
    `).bind(nowMs, proposalId, options.principal.id).run();
    return actionFailure('state_invalid', '操作提案无法安全展示，本次没有修改数据。');
  }
  await recordEvent(options.database, {
    id: `proposed:${proposalId}`,
    proposalId,
    accountKey: options.principal.id,
    sessionId,
    actionKind: proposalActionKind,
    eventType: 'proposal_ready',
    schemaValid: true,
    nowMs,
  });
  return { ok: true, proposal: preview };
}

export async function prepareAgentActionFromToolCall(options: {
  database: AgentActionDatabase;
  principal: AuthPrincipal;
  sourceCallId: unknown;
  sessionId: unknown;
  toolName: unknown;
  argumentsJson: unknown;
  question?: unknown;
  referenceDate?: unknown;
  now?: () => number;
}): Promise<PreparedAgentActionResult> {
  const nowMs = (options.now ?? Date.now)();
  await expireAgentActionProposals(options.database, options.principal.id, nowMs);
  const toolName = boundedString(options.toolName, 80);
  let argumentsRecord: Record<string, unknown> | null = null;
  let targetAmbiguity: AgentActionCandidate[] = [];
  try {
    const parsed = typeof options.argumentsJson === 'string'
      ? JSON.parse(options.argumentsJson) as unknown
      : options.argumentsJson;
    if (isRecord(parsed)) argumentsRecord = parsed;
  } catch {
    argumentsRecord = null;
  }

  if (argumentsRecord) {
    const resolvedTargets = await resolveKnownToolTargets({
      database: options.database,
      accountKey: options.principal.id,
      toolName,
      argumentsRecord,
      question: options.question,
    });
    argumentsRecord = resolvedTargets.argumentsRecord;
    targetAmbiguity = resolvedTargets.ambiguousCandidates ?? [];
  }

  if (toolName === 'query_applications') {
    const normalizedReadQuery = normalizeAgentReadQueryDates(
      argumentsRecord,
      options.question,
      options.referenceDate,
    );
    const query = normalizedReadQuery.ok ? parseAgentReadQuery(normalizedReadQuery.value) : null;
    if (!query) {
      await recordEvent(options.database, {
        id: crypto.randomUUID(), accountKey: options.principal.id,
        sessionId: boundedString(options.sessionId, 100), eventType: 'read_rejected',
        reasonCode: 'invalid_schema', schemaValid: false, nowMs,
      });
      return { kind: 'clarification', message: '查询条件不完整，请换一种说法后再试；本次没有修改数据。' };
    }
    const message = await executeAgentReadQuery(
      options.database,
      options.principal.id,
      query,
      boundedString(options.question, 800),
    );
    await recordEvent(options.database, {
      id: crypto.randomUUID(), accountKey: options.principal.id,
      sessionId: boundedString(options.sessionId, 100), eventType: 'read_executed',
      schemaValid: true, parameterExact: true, nowMs,
    });
    return { kind: 'read', message };
  }

  const mapping: Record<string, AgentActionKind> = {
    propose_add_company: 'add_company',
    propose_add_job: 'add_job',
    propose_update_company: 'update_company',
    propose_update_job: 'update_job',
    propose_delete_company: 'delete_company',
    propose_delete_job: 'delete_job',
  };
  const actionKind = mapping[toolName];
  if (!actionKind) {
    await recordEvent(options.database, {
      id: crypto.randomUUID(),
      accountKey: options.principal.id,
      sessionId: boundedString(options.sessionId, 100),
      eventType: 'proposal_rejected',
      reasonCode: 'unknown_tool',
      schemaValid: false,
      nowMs,
    });
    return { kind: 'clarification', message: '这类操作尚未开放，本次没有修改数据。' };
  }
  if (targetAmbiguity.length > 0) {
    await recordEvent(options.database, {
      id: crypto.randomUUID(),
      accountKey: options.principal.id,
      sessionId: boundedString(options.sessionId, 100),
      actionKind,
      eventType: 'clarification_required',
      reasonCode: 'ambiguous_target',
      schemaValid: true,
      ambiguityDetected: true,
      ambiguityHandled: true,
      nowMs,
    });
    return {
      kind: 'clarification',
      message: '找到多个同名岗位，请补充公司或地点后再试；本次没有修改数据。',
      candidates: targetAmbiguity,
    };
  }
  if (!argumentsRecord) {
    await recordEvent(options.database, {
      id: crypto.randomUUID(),
      accountKey: options.principal.id,
      sessionId: boundedString(options.sessionId, 100),
      actionKind,
      eventType: 'proposal_rejected',
      reasonCode: 'invalid_arguments_json',
      schemaValid: false,
      nowMs,
    });
    return { kind: 'clarification', message: '操作参数不完整，请补充后再试；本次没有修改数据。' };
  }
  const normalizedDates = normalizeRelativeToolDates({
    toolName,
    argumentsRecord,
    question: options.question,
    referenceDate: options.referenceDate,
  });
  if (!normalizedDates.ok) {
    await recordEvent(options.database, {
      id: crypto.randomUUID(),
      accountKey: options.principal.id,
      sessionId: boundedString(options.sessionId, 100),
      actionKind,
      eventType: 'clarification_required',
      reasonCode: 'local_timezone_required',
      schemaValid: true,
      ambiguityDetected: true,
      ambiguityHandled: true,
      nowMs,
    });
    return {
      kind: 'clarification',
      message: '无法确认你当地的日期，本次没有修改数据。请刷新页面后重试，或直接填写 YYYY-MM-DD 格式的明确日期。',
    };
  }
  argumentsRecord = normalizedDates.argumentsRecord;
  const normalizedUpdate = normalizeUpdateArguments(toolName, argumentsRecord, options.question);
  if (!normalizedUpdate.ok) {
    await recordEvent(options.database, {
      id: crypto.randomUUID(),
      accountKey: options.principal.id,
      sessionId: boundedString(options.sessionId, 100),
      actionKind,
      eventType: 'clarification_required',
      reasonCode: 'invalid_stage',
      schemaValid: true,
      ambiguityDetected: true,
      ambiguityHandled: true,
      nowMs,
    });
    return { kind: 'clarification', message: normalizedUpdate.message };
  }
  argumentsRecord = normalizedUpdate.argumentsRecord;
  if (actionKind === 'add_job') {
    argumentsRecord = {
      ...argumentsRecord,
      location: typeof argumentsRecord.location === 'string' ? argumentsRecord.location : '',
      portalUrl: typeof argumentsRecord.portalUrl === 'string' ? argumentsRecord.portalUrl : '',
      appliedAt: typeof argumentsRecord.appliedAt === 'string' ? argumentsRecord.appliedAt : '',
    };
  }
  const sourceCallId = boundedString(options.sourceCallId, 100);
  const idempotencyKey = sourceCallId
    ? await stableUuid(`${options.principal.id}:${sourceCallId}`)
    : crypto.randomUUID();
  const confirmationNonce = crypto.randomUUID();
  const result = await createAgentActionProposal({
    database: options.database,
    principal: options.principal,
    sessionId: options.sessionId,
    sourceCallId,
    idempotencyKey,
    confirmationNonce,
    toolCall: { kind: actionKind, ...argumentsRecord },
    dependencies: options.now ? { now: options.now } : undefined,
  });
  if (result.ok) return { kind: 'proposal', proposal: result.proposal };
  return {
    kind: 'clarification',
    message: result.message,
    ...(result.candidates?.length ? { candidates: result.candidates } : {}),
  };
}

function makeCompany(payload: Record<string, unknown>, websiteOptional = false) {
  const id = boundedString(payload.newCompanyId, 160);
  const name = boundedString(payload.name, 120);
  const website = parseHttpUrl(payload.website, websiteOptional);
  if (!id || !name || website === null) return null;
  return companyRecord({
    id,
    name,
    shortName: name.slice(0, 2),
    website,
    color: '#275A53',
    note: '',
    jobs: [],
  });
}

function makeJob(payload: Record<string, unknown>) {
  const id = boundedString(payload.newJobId, 160);
  const title = boundedString(payload.title, 160);
  const location = boundedString(payload.location, 120);
  const portalUrl = parseHttpUrl(payload.portalUrl, true);
  const appliedAt = boundedString(payload.appliedAt, 10);
  if (!id || !title || portalUrl === null || !validDate(appliedAt)) return null;
  return jobRecord({
    id,
    title,
    location,
    jobType: '校招',
    portalUrl,
    appliedAt,
    stage: '意向岗位',
    priority: '中',
    nextAction: '',
    nextDate: '',
    notes: '',
    process: [],
  });
}

async function markProposal(
  database: AgentActionDatabase,
  row: StoredProposalRow,
  status: 'expired' | 'conflict' | 'failed',
  failureCode: string,
  nowMs: number,
) {
  await database.prepare(`
    UPDATE agent_action_proposals
    SET status = ?, completed_at_ms = ?, failure_code = ?, payload_json = '{}'
    WHERE id = ? AND account_key = ? AND status IN ('awaiting_confirmation', 'executing')
  `).bind(status, nowMs, failureCode, row.id, row.account_key).run();
}

async function executedResult(
  database: AgentActionDatabase,
  row: StoredProposalRow,
  replayed: boolean,
): Promise<ConfirmAgentActionResult> {
  await recordEvent(database, {
    id: `executed:${row.id}`,
    proposalId: row.id,
    accountKey: row.account_key,
    sessionId: row.session_id,
    actionKind: row.action_kind,
    eventType: 'executed',
    nowMs: row.completed_at_ms ?? Date.now(),
  });
  const loaded = await loadState(database, row.account_key);
  if (!loaded) {
    return { ok: false, code: 'failed', message: '操作已记录，但最新数据暂时无法读取，请重新加载页面核对。' };
  }
  return {
    ok: true,
    status: 'executed',
    actionId: row.id,
    actionKind: row.action_kind,
    state: loaded.state,
    version: loaded.version,
    replayed,
    message: replayed ? '该操作已经完成，没有重复执行。' : '操作已确认并保存。',
  };
}

async function recoverExecuting(
  database: AgentActionDatabase,
  row: StoredProposalRow,
  nowMs: number,
): Promise<ConfirmAgentActionResult | null> {
  const loaded = await loadState(database, row.account_key);
  if (!loaded) return { ok: false, code: 'failed', message: '暂时无法确认操作结果，请重新加载页面核对。' };
  if (row.result_state_version && loaded.version === row.result_state_version) {
    await database.prepare(`
      UPDATE agent_action_proposals
      SET status = 'executed', completed_at_ms = ?, failure_code = '', payload_json = '{}'
      WHERE id = ? AND account_key = ? AND status = 'executing'
    `).bind(nowMs, row.id, row.account_key).run();
    const refreshed = await proposalRow(database, row.id, row.account_key);
    return refreshed ? executedResult(database, refreshed, true) : null;
  }
  if ((row.execution_lease_expires_at_ms ?? 0) > nowMs) {
    return { ok: false, code: 'in_progress', message: '正在安全保存这次操作，请稍候，不会重复执行。' };
  }
  if (loaded.version !== row.base_state_version) {
    await markProposal(database, row, 'conflict', 'state_version_changed', nowMs);
    return { ok: false, code: 'conflict', message: '数据已在另一页发生变化，无法确认本次操作是否完成，请重新加载页面核对。' };
  }
  return null;
}

async function prepareMutatedState(
  row: StoredProposalRow,
  loaded: LoadedState,
): Promise<{ ok: true; state: ApplicationState } | { ok: false; code: 'conflict' | 'failed'; message: string }> {
  if (loaded.version !== row.base_state_version) {
    return { ok: false, code: 'conflict', message: '数据已在另一页发生变化，本次操作未执行，请重新确认。' };
  }
  const payload = safePayload(row);
  if (!payload) return { ok: false, code: 'failed', message: '操作提案已失效，本次没有修改数据。' };
  const state = loaded.state;
  const companyIndex = state.companies.findIndex((company) => company.id === row.target_company_id);
  if (row.action_kind === 'add_company') {
    const company = makeCompany(payload, true);
    if (!company) return { ok: false, code: 'failed', message: '新增公司提案已失效，本次没有修改数据。' };
    const duplicate = state.companies.some((item) => (
      normalizeIdentityPart(item.name) === normalizeIdentityPart(company.name)
      || (Boolean(company.website) && Boolean(item.website)
        && canonicalWebsite(item.website) === canonicalWebsite(company.website))
    ));
    if (duplicate) return { ok: false, code: 'conflict', message: '相同公司已经存在，本次没有重复新增。' };
    state.companies.push(company);
  } else if (row.action_kind === 'add_company_job') {
    const company = makeCompany({
      newCompanyId: payload.newCompanyId,
      name: payload.companyName,
      website: '',
    }, true);
    const job = makeJob(payload);
    if (!company || !job) return { ok: false, code: 'failed', message: '创建公司和岗位的提案已失效，本次没有修改数据。' };
    const duplicate = state.companies.some((item) => normalizeIdentityPart(item.name) === normalizeIdentityPart(company.name));
    if (duplicate) return { ok: false, code: 'conflict', message: '相同公司已经存在，请重新发起新增岗位。' };
    company.jobs.push(job);
    state.companies.push(company);
  } else if (row.action_kind === 'add_job') {
    if (companyIndex < 0) return { ok: false, code: 'conflict', message: '目标公司已不存在，本次没有新增岗位。' };
    const company = state.companies[companyIndex];
    if (await fingerprint(company) !== row.target_fingerprint) {
      return { ok: false, code: 'conflict', message: '目标公司已发生变化，本次操作未执行，请重新确认。' };
    }
    const job = makeJob(payload);
    if (!job) return { ok: false, code: 'failed', message: '新增岗位提案已失效，本次没有修改数据。' };
    const duplicate = company.jobs.some((item) => jobIdentityKey(
      item.title,
      typeof item.location === 'string' ? item.location : '',
    ) === jobIdentityKey(job.title, job.location));
    if (duplicate) return { ok: false, code: 'conflict', message: '相同岗位已经存在，本次没有重复新增。' };
    company.jobs.push(job);
  } else if (row.action_kind === 'update_company') {
    if (companyIndex < 0) return { ok: false, code: 'conflict', message: '目标公司已不存在，本次没有修改数据。' };
    const company = state.companies[companyIndex];
    if (await fingerprint(company) !== row.target_fingerprint) {
      return { ok: false, code: 'conflict', message: '目标公司已发生变化，本次修改未执行，请重新确认。' };
    }
    const changes = isRecord(payload.changes) ? payload.changes : null;
    if (!changes) return { ok: false, code: 'failed', message: '修改公司提案已失效，本次没有修改数据。' };
    const nextName = typeof changes.name === 'string' ? boundedString(changes.name, 120) : company.name;
    const nextWebsite = typeof changes.website === 'string' ? parseHttpUrl(changes.website, true) : company.website;
    if (!nextName || nextWebsite === null) return { ok: false, code: 'failed', message: '修改后的公司信息未通过校验，本次没有修改数据。' };
    const duplicate = state.companies.some((item) => item.id !== company.id && (
      normalizeIdentityPart(item.name) === normalizeIdentityPart(nextName)
      || (nextWebsite && canonicalWebsite(item.website) === canonicalWebsite(nextWebsite))
    ));
    if (duplicate) return { ok: false, code: 'conflict', message: '修改后会与现有公司重复，本次没有修改数据。' };
    company.name = nextName;
    company.shortName = nextName.slice(0, 2);
    company.website = nextWebsite;
  } else if (row.action_kind === 'update_job') {
    if (companyIndex < 0) return { ok: false, code: 'conflict', message: '目标公司已不存在，本次没有修改岗位。' };
    const company = state.companies[companyIndex];
    const jobIndex = company.jobs.findIndex((job) => job.id === row.target_job_id);
    if (jobIndex < 0) return { ok: false, code: 'conflict', message: '目标岗位已不存在，本次没有修改数据。' };
    const job = company.jobs[jobIndex];
    if (await fingerprint(job) !== row.target_fingerprint) {
      return { ok: false, code: 'conflict', message: '目标岗位已发生变化，本次修改未执行，请重新确认。' };
    }
    const changes = isRecord(payload.changes) ? payload.changes : null;
    if (!changes || Object.keys(changes).length === 0) return { ok: false, code: 'failed', message: '修改岗位提案已失效，本次没有修改数据。' };
    const allowedKeys = new Set(['title', 'location', 'portalUrl', 'appliedAt', 'stage', 'priority', 'nextAction', 'nextDate']);
    for (const [key, value] of Object.entries(changes)) {
      if (!allowedKeys.has(key) || typeof value !== 'string') {
        return { ok: false, code: 'failed', message: '修改岗位提案未通过字段校验，本次没有修改数据。' };
      }
      if (
        (key === 'title' && !boundedString(value, 160))
        || (key === 'location' && value !== boundedString(value, 120))
        || (key === 'portalUrl' && parseHttpUrl(value, true) === null)
        || ((key === 'appliedAt' || key === 'nextDate') && !validDate(value))
        || (key === 'stage' && !VALID_STAGES.has(value))
        || (key === 'priority' && !['高', '中', '低'].includes(value))
        || (key === 'nextAction' && value !== boundedString(value, 500))
      ) return { ok: false, code: 'failed', message: '修改岗位提案未通过取值校验，本次没有修改数据。' };
      job[key] = value;
    }
    const duplicate = company.jobs.some((item, index) => index !== jobIndex && jobIdentityKey(
      item.title,
      typeof item.location === 'string' ? item.location : '',
    ) === jobIdentityKey(job.title, typeof job.location === 'string' ? job.location : ''));
    if (duplicate) return { ok: false, code: 'conflict', message: '修改后会与现有岗位重复，本次没有修改数据。' };
  } else if (row.action_kind === 'delete_company') {
    if (companyIndex < 0) return { ok: false, code: 'conflict', message: '目标公司已不存在，本次没有重复删除。' };
    const company = state.companies[companyIndex];
    if (await fingerprint(company) !== row.target_fingerprint) {
      return { ok: false, code: 'conflict', message: '目标公司已发生变化，本次删除未执行，请重新确认。' };
    }
    state.companies.splice(companyIndex, 1);
  } else if (row.action_kind === 'delete_job') {
    if (companyIndex < 0) return { ok: false, code: 'conflict', message: '目标公司已不存在，本次没有删除岗位。' };
    const company = state.companies[companyIndex];
    const jobIndex = company.jobs.findIndex((job) => job.id === row.target_job_id);
    if (jobIndex < 0) return { ok: false, code: 'conflict', message: '目标岗位已不存在，本次没有重复删除。' };
    if (await fingerprint(company.jobs[jobIndex]) !== row.target_fingerprint) {
      return { ok: false, code: 'conflict', message: '目标岗位已发生变化，本次删除未执行，请重新确认。' };
    }
    company.jobs.splice(jobIndex, 1);
  } else return { ok: false, code: 'failed', message: '这类操作尚未开放，本次没有修改数据。' };
  if (!validState(state) || stateBytes(state) > AGENT_ACTION_MAX_STATE_BYTES) {
    return { ok: false, code: 'failed', message: '操作后数据未通过完整性检查，本次没有修改数据。' };
  }
  return { ok: true, state };
}

export async function confirmAgentAction(options: {
  database: AgentActionDatabase;
  principal: AuthPrincipal;
  actionId: unknown;
  confirmationNonce: unknown;
  requestId: unknown;
  dependencies?: AgentActionDependencies;
}): Promise<ConfirmAgentActionResult> {
  const nowMs = (options.dependencies?.now ?? Date.now)();
  await expireAgentActionProposals(options.database, options.principal.id, nowMs);
  const randomId = options.dependencies?.randomId ?? (() => crypto.randomUUID());
  const actionId = boundedString(options.actionId, 120);
  const confirmationNonce = boundedString(options.confirmationNonce, 120);
  const requestId = boundedString(options.requestId, 120);
  if (!VALID_UUID.test(actionId) || !VALID_UUID.test(confirmationNonce) || !VALID_UUID.test(requestId)) {
    return { ok: false, code: 'invalid_request', message: '确认信息不完整，本次没有修改数据。' };
  }
  let row = await proposalRow(options.database, actionId, options.principal.id);
  if (!row) return { ok: false, code: 'not_found', message: '没有找到属于当前账号的待确认操作。' };
  if (row.confirmation_nonce_hash !== await digest(confirmationNonce)) {
    return { ok: false, code: 'invalid_confirmation', message: '确认凭证无效，本次没有修改数据。' };
  }
  await recordEvent(options.database, {
    id: `confirmation:${row.id}:${requestId}`,
    proposalId: row.id,
    accountKey: options.principal.id,
    sessionId: row.session_id,
    actionKind: row.action_kind,
    eventType: 'confirmation_attempted',
    nowMs,
  });
  if (row.status === 'executed') return executedResult(options.database, row, true);
  if (row.status === 'cancelled') return { ok: false, code: 'cancelled', message: '这次操作已取消，没有修改数据。' };
  if (row.status === 'expired' || row.expires_at_ms <= nowMs) {
    if (row.status !== 'expired') await markProposal(options.database, row, 'expired', 'proposal_expired', nowMs);
    return { ok: false, code: 'expired', message: '这次操作提案已过期，没有修改数据，请重新发起。' };
  }
  if (row.status === 'conflict') return { ok: false, code: 'conflict', message: '数据已发生变化，本次操作没有重复执行，请重新确认。' };
  if (row.status === 'failed') return { ok: false, code: 'failed', message: '这次操作未完成，请重新发起；系统不会声称已经修改。' };
  if (row.status === 'executing') {
    const recovered = await recoverExecuting(options.database, row, nowMs);
    if (recovered) {
      if (!recovered.ok && (recovered.code === 'conflict' || recovered.code === 'failed')) {
        await recordEvent(options.database, {
          id: `${recovered.code === 'conflict' ? 'execution_conflict' : 'execution_failed'}:${row.id}:${requestId}`,
          proposalId: row.id, accountKey: options.principal.id, sessionId: row.session_id,
          actionKind: row.action_kind,
          eventType: recovered.code === 'conflict' ? 'execution_conflict' : 'execution_failed',
          reasonCode: 'execution_recovery', nowMs,
        });
      }
      return recovered;
    }
  }

  const loaded = await loadState(options.database, options.principal.id);
  if (!loaded) {
    await markProposal(options.database, row, 'failed', 'state_invalid', nowMs);
    await recordEvent(options.database, {
      id: `execution_failed:${row.id}:${requestId}`, proposalId: row.id,
      accountKey: options.principal.id, sessionId: row.session_id, actionKind: row.action_kind,
      eventType: 'execution_failed', reasonCode: 'state_invalid', nowMs,
    });
    return { ok: false, code: 'failed', message: '当前数据无法安全读取，本次没有修改数据。' };
  }
  const mutation = await prepareMutatedState(row, loaded);
  if (!mutation.ok) {
    await markProposal(options.database, row, mutation.code, mutation.code === 'conflict' ? 'validation_conflict' : 'invalid_payload', nowMs);
    await recordEvent(options.database, {
      id: `${mutation.code === 'conflict' ? 'execution_conflict' : 'execution_failed'}:${row.id}:${requestId}`,
      proposalId: row.id,
      accountKey: options.principal.id,
      sessionId: row.session_id,
      actionKind: row.action_kind,
      eventType: mutation.code === 'conflict' ? 'execution_conflict' : 'execution_failed',
      reasonCode: mutation.code === 'conflict' ? 'validation_conflict' : 'invalid_payload',
      nowMs,
    });
    return { ok: false, code: mutation.code, message: mutation.message };
  }

  const resultVersion = row.result_state_version || randomId();
  if (row.status === 'awaiting_confirmation') {
    const claim = await options.database.prepare(`
      UPDATE agent_action_proposals
      SET status = 'executing', confirmed_at_ms = ?, execution_lease_expires_at_ms = ?,
        execution_idempotency_key = ?, result_state_version = ?
      WHERE id = ? AND account_key = ? AND status = 'awaiting_confirmation'
        AND expires_at_ms > ?
    `).bind(
      nowMs,
      nowMs + AGENT_ACTION_EXECUTION_LEASE_MS,
      requestId,
      resultVersion,
      row.id,
      options.principal.id,
      nowMs,
    ).run();
    if (!changed(claim)) {
      const current = await proposalRow(options.database, row.id, options.principal.id);
      if (!current) return { ok: false, code: 'not_found', message: '待确认操作已不存在。' };
      if (current.status === 'executed') return executedResult(options.database, current, true);
      if (current.status === 'executing') {
        const recovered = await recoverExecuting(options.database, current, nowMs);
        if (recovered && !recovered.ok && (recovered.code === 'conflict' || recovered.code === 'failed')) {
          await recordEvent(options.database, {
            id: `${recovered.code === 'conflict' ? 'execution_conflict' : 'execution_failed'}:${current.id}:${requestId}`,
            proposalId: current.id, accountKey: options.principal.id, sessionId: current.session_id,
            actionKind: current.action_kind,
            eventType: recovered.code === 'conflict' ? 'execution_conflict' : 'execution_failed',
            reasonCode: 'execution_recovery', nowMs,
          });
        }
        return recovered ?? { ok: false, code: 'in_progress', message: '正在安全保存这次操作，请稍候，不会重复执行。' };
      }
      return { ok: false, code: 'conflict', message: '操作状态已发生变化，本次没有重复执行。' };
    }
    row = (await proposalRow(options.database, row.id, options.principal.id)) ?? row;
  } else {
    await options.database.prepare(`
      UPDATE agent_action_proposals
      SET execution_lease_expires_at_ms = ?, execution_idempotency_key = ?
      WHERE id = ? AND account_key = ? AND status = 'executing'
    `).bind(nowMs + AGENT_ACTION_EXECUTION_LEASE_MS, requestId, row.id, options.principal.id).run();
  }

  // This event is the execution-success denominator: it is emitted only after this
  // account has obtained the executing lease and immediately before the real state
  // write. Its proposal-scoped id keeps retries and double clicks from inflating it.
  await recordEvent(options.database, {
    id: `execution_started:${row.id}`,
    proposalId: row.id,
    accountKey: options.principal.id,
    sessionId: row.session_id,
    actionKind: row.action_kind,
    eventType: 'execution_started',
    nowMs,
  });

  const serialized = JSON.stringify(mutation.state);
  const updatedAt = new Date(nowMs).toISOString();
  const stateStatement = loaded.exists
    ? options.database.prepare(`
        UPDATE application_states
        SET user_email = ?, data_json = ?, updated_at = ?, version = ?, deleted_at = NULL
        WHERE user_id = ? AND version = ?
      `).bind(options.principal.email, serialized, updatedAt, resultVersion, options.principal.id, row.base_state_version)
    : options.database.prepare(`
        INSERT OR IGNORE INTO application_states
          (user_id, user_email, data_json, updated_at, version, deleted_at)
        VALUES (?, ?, ?, ?, ?, NULL)
      `).bind(options.principal.id, options.principal.email, serialized, updatedAt, resultVersion);
  const finalizeStatement = options.database.prepare(`
    UPDATE agent_action_proposals
    SET status = 'executed', completed_at_ms = ?, failure_code = '', payload_json = '{}'
    WHERE id = ? AND account_key = ? AND status = 'executing'
      AND result_state_version = ?
      AND EXISTS (
        SELECT 1 FROM application_states WHERE user_id = ? AND version = ?
      )
  `).bind(nowMs, row.id, options.principal.id, resultVersion, options.principal.id, resultVersion);
  const eventStatement = options.database.prepare(`
    INSERT OR IGNORE INTO agent_action_events (
      id, proposal_id, account_key, session_id, action_kind, event_type,
      reason_code, schema_valid, ambiguity_detected, ambiguity_handled,
      parameter_exact, user_review_outcome, latency_ms, created_at_ms
    )
    SELECT ?, id, account_key, session_id, action_kind, 'executed', '', NULL, NULL, NULL, NULL, NULL, 0, ?
    FROM agent_action_proposals
    WHERE id = ? AND account_key = ? AND status = 'executed'
  `).bind(`executed:${row.id}`, nowMs, row.id, options.principal.id);

  try {
    if (options.database.batch) {
      await options.database.batch([stateStatement, finalizeStatement, eventStatement]);
    } else {
      await stateStatement.run();
      await finalizeStatement.run();
      await eventStatement.run();
    }
  } catch {
    const current = await proposalRow(options.database, row.id, options.principal.id).catch(() => null);
    if (current?.status === 'executed') return executedResult(options.database, current, true);
    await recordEvent(options.database, {
      id: `execution_failed:${row.id}:${requestId}`, proposalId: row.id,
      accountKey: options.principal.id, sessionId: row.session_id, actionKind: row.action_kind,
      eventType: 'execution_failed', reasonCode: 'database_uncertain', nowMs,
    });
    return {
      ok: false,
      code: 'in_progress',
      message: '暂时无法确认本次操作的最终状态，请稍后重新加载页面核对，系统不会误报成功。',
    };
  }
  const completed = await proposalRow(options.database, row.id, options.principal.id);
  if (completed?.status === 'executed') return executedResult(options.database, completed, false);
  const currentState = await loadState(options.database, options.principal.id);
  if (currentState?.version === resultVersion && completed) {
    await options.database.prepare(`
      UPDATE agent_action_proposals
      SET status = 'executed', completed_at_ms = ?, failure_code = '', payload_json = '{}'
      WHERE id = ? AND account_key = ? AND status = 'executing'
    `).bind(nowMs, row.id, options.principal.id).run();
    const repaired = await proposalRow(options.database, row.id, options.principal.id);
    return repaired ? executedResult(options.database, repaired, false) : {
      ok: false, code: 'failed', message: '数据已保存，但状态暂时无法读取，请重新加载页面核对。',
    };
  }
  if (completed) await markProposal(options.database, completed, 'conflict', 'state_version_changed', nowMs);
  await recordEvent(options.database, {
    id: `execution_conflict:${row.id}:${requestId}`, proposalId: row.id,
    accountKey: options.principal.id, sessionId: row.session_id, actionKind: row.action_kind,
    eventType: 'execution_conflict', reasonCode: 'state_version_changed', nowMs,
  });
  return { ok: false, code: 'conflict', message: '数据已在另一页发生变化，本次操作未执行，请重新确认。' };
}

export async function cancelAgentAction(options: {
  database: AgentActionDatabase;
  principal: AuthPrincipal;
  actionId: unknown;
  confirmationNonce: unknown;
  dependencies?: AgentActionDependencies;
}): Promise<CancelAgentActionResult> {
  const nowMs = (options.dependencies?.now ?? Date.now)();
  await expireAgentActionProposals(options.database, options.principal.id, nowMs);
  const actionId = boundedString(options.actionId, 120);
  const confirmationNonce = boundedString(options.confirmationNonce, 120);
  if (!VALID_UUID.test(actionId) || !VALID_UUID.test(confirmationNonce)) {
    return { ok: false, code: 'invalid_request', message: '取消信息不完整，没有修改数据。' };
  }
  const row = await proposalRow(options.database, actionId, options.principal.id);
  if (!row) return { ok: false, code: 'not_found', message: '没有找到属于当前账号的待确认操作。' };
  if (row.confirmation_nonce_hash !== await digest(confirmationNonce)) {
    return { ok: false, code: 'invalid_confirmation', message: '取消凭证无效，没有修改数据。' };
  }
  if (row.status === 'cancelled') return { ok: true, status: 'cancelled', message: '这次操作已取消，没有修改数据。' };
  if (row.status === 'executed') return { ok: false, code: 'already_executed', message: '这次操作已经完成，无法再取消。' };
  if (row.status === 'executing') return { ok: false, code: 'in_progress', message: '操作正在安全保存，暂时无法取消，请稍后核对。' };
  if (row.status === 'expired' || row.expires_at_ms <= nowMs) {
    if (row.status !== 'expired') await markProposal(options.database, row, 'expired', 'proposal_expired', nowMs);
    return { ok: false, code: 'expired', message: '这次操作提案已过期，没有修改数据。' };
  }
  const result = await options.database.prepare(`
    UPDATE agent_action_proposals
    SET status = 'cancelled', completed_at_ms = ?, failure_code = '', payload_json = '{}'
    WHERE id = ? AND account_key = ? AND status = 'awaiting_confirmation'
  `).bind(nowMs, row.id, options.principal.id).run();
  if (!changed(result)) return { ok: false, code: 'in_progress', message: '操作状态已发生变化，没有重复处理。' };
  await recordEvent(options.database, {
    id: `cancelled:${row.id}`, proposalId: row.id, accountKey: options.principal.id,
    sessionId: row.session_id, actionKind: row.action_kind, eventType: 'cancelled', nowMs,
  });
  return { ok: true, status: 'cancelled', message: '这次操作已取消，没有修改数据。' };
}

export async function recordAgentActionFeedback(options: {
  database: AgentActionDatabase;
  principal: AuthPrincipal;
  actionId: unknown;
  outcome: unknown;
  now?: () => number;
}) {
  const actionId = boundedString(options.actionId, 120);
  const outcome = options.outcome;
  const nowMs = (options.now ?? Date.now)();
  await expireAgentActionProposals(options.database, options.principal.id, nowMs);
  if (!VALID_UUID.test(actionId) || (outcome !== 'correct' && outcome !== 'incorrect')) return false;
  const result = await options.database.prepare(`
    UPDATE agent_action_proposals
    SET feedback = ?, feedback_at_ms = ?
    WHERE id = ? AND account_key = ?
      AND status IN ('executed', 'cancelled') AND feedback IS NULL
  `).bind(outcome, nowMs, actionId, options.principal.id).run();
  if (!changed(result)) return false;
  const row = await proposalRow(options.database, actionId, options.principal.id);
  if (row) {
    await recordEvent(options.database, {
      id: `feedback:${row.id}`, proposalId: row.id, accountKey: options.principal.id,
      sessionId: row.session_id, actionKind: row.action_kind, eventType: 'user_review',
      review: outcome, nowMs,
    });
  }
  return true;
}
