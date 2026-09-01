'use client';

import Image from 'next/image';
import { ChangeEvent, FormEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  buildNavigatorBriefing,
  NAVIGATOR_ENGLISH_NAME,
  NAVIGATOR_NAME,
  parseNavigatorCommand,
  type NavigatorAction,
  type NavigatorCommandResult,
} from './lib/career-navigator';
import { CORE_STAGES, jobIdentityKey, STAGES, type Stage } from './lib/domain';
import { isUserStorageKey, storageKeyForUser } from './lib/user-scope';

type ProcessEvent = {
  id: string;
  stage: Stage;
  title: string;
  date: string;
  note: string;
};

type Job = {
  id: string;
  title: string;
  location: string;
  jobType: string;
  portalUrl: string;
  appliedAt: string;
  stage: Stage;
  priority: '高' | '中' | '低';
  nextAction: string;
  nextDate: string;
  notes: string;
  process: ProcessEvent[];
};

type Company = {
  id: string;
  name: string;
  website: string;
  shortName: string;
  color: string;
  note: string;
  jobs: Job[];
};

type FlatJob = Job & { companyId: string; companyName: string; companyColor: string };
type SyncStatus = 'loading' | 'saving' | 'synced' | 'offline' | 'signed-out' | 'access-denied' | 'error';
type SummaryMetric = 'active' | 'interview' | 'offer' | 'all';
type JobEntryContext = 'dashboard' | 'company' | 'edit';
type BatchJobRow = {
  id: string;
  title: string;
  location: string;
  portalUrl: string;
};
type BatchJobDefaults = {
  jobType: string;
  appliedAt: string;
  stage: Stage;
  priority: Job['priority'];
};
type Notice = { id: number; message: string };
type AuthProvider = 'chatgpt' | 'github';
type AgentMode = 'basic' | 'intelligent';
type AgentFeedbackState = 'idle' | 'resolved' | 'unresolved' | 'error';
type AgentActionFeedbackState = 'idle' | 'correct' | 'incorrect' | 'error';
type AgentProposalReviewState = 'idle' | 'cancelled' | 'incorrect' | 'error';
type AgentActionKind =
  | 'add_company'
  | 'add_job'
  | 'add_company_job'
  | 'update_company'
  | 'update_job'
  | 'delete_company'
  | 'delete_job';
type AgentActionProposal = {
  id: string;
  confirmationNonce: string;
  actionKind: AgentActionKind;
  title: string;
  summary: string;
  details: Array<{ label: string; value: string }>;
  impact: string;
  destructive: boolean;
  expiresAt: string;
};
type AgentActionCompleted = {
  id: string;
  actionKind: AgentActionKind;
  title: string;
  summary: string;
};
type AgentStatus = {
  enabled: boolean;
  disabled: boolean;
  isAdmin: boolean;
  limit: number | null;
  used: number;
  remaining: number | null;
  resetAt: string | null;
  intelligentAvailable: boolean;
};
type AgentAdminUser = {
  userNumber: number;
  role: 'admin' | 'user';
  disabled: boolean;
  limitOverride: number | null;
  effectiveLimit: number | null;
  used24h: number;
  lastCallAt: string | null;
  totalTokens: number;
};
type AgentAdminDashboard = {
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
type AgentEvaluationRow = {
  category: '核心结果' | '质量' | '效率' | '工具' | '安全';
  name: string;
  value: string;
  sample: string;
  definition: string;
  status: '可用' | '等待样本' | '安全目标' | '需关注';
  core?: boolean;
};
type AgentAdminUpdate =
  | { kind: 'global'; enabled: boolean }
  | { kind: 'default_limit'; limit: number }
  | { kind: 'user_limit'; userNumber: number; limit: number | null }
  | { kind: 'user'; userNumber: number; disabled: boolean };
type PendingConfirmation =
  | { kind: 'delete-company'; companyId: string }
  | { kind: 'delete-job'; companyId: string; jobId: string }
  | { kind: 'delete-event'; companyId: string; jobId: string; eventId: string }
  | { kind: 'import-backup'; companies: Company[]; source: 'file' | 'paste' };

const COLORS = ['#275A53', '#D97845', '#6256A5', '#28709E', '#9A5C70', '#677444', '#A15C39'];
const LEGACY_STORAGE_KEY = 'local-job-application-tracker-v1';
const NO_STATE_VERSION = 'none';
const MAX_STATE_BYTES = 2_000_000;
const MAX_BACKUP_BYTES = 4_000_000;
const DEVICE_SESSION_CLEARED_HEADER = 'x-zhixu-device-session-cleared';
const AUTH_DISCONNECT_TIMEOUT_MS = 10_000;
const AGENT_TECHNICAL_FAILURE_MESSAGE = '这次没有成功完成分析，但你的求职数据没有受到影响，也不会扣除使用次数。你可以稍后重试，或切换到基础助手继续使用。';
const AGENT_STATUS_CACHE_MS = 30_000;
const AGENT_ADMIN_CACHE_MS = 30_000;
const SYNC_LABELS: Record<SyncStatus, string> = {
  loading: '正在连接云端',
  saving: '正在保存到云端',
  synced: '云端已同步',
  offline: '离线模式 · 保存在本机',
  'signed-out': '需要登录',
  'access-denied': '暂时无法访问当前账号',
  error: '云端保存失败 · 本机有副本',
};

const EXAMPLE_COMPANIES: Company[] = [
  {
    id: 'example-xinglan-energy',
    name: '星澜能源（示例）',
    shortName: '星澜',
    website: 'https://example.com/careers/xinglan-energy',
    color: '#D97845',
    note: '完全虚构的示例公司，可随时编辑或删除。',
    jobs: [],
  },
  {
    id: 'example-yunzhan-tech',
    name: '云栈科技（示例）',
    shortName: '云栈',
    website: 'https://example.com/careers/yunzhan-tech',
    color: '#275A53',
    note: '完全虚构的示例公司，可随时编辑或删除。',
    jobs: [],
  },
  {
    id: 'example-yuanling-intelligence',
    name: '远岭智造（示例）',
    shortName: '远岭',
    website: 'https://example.com/careers/yuanling-intelligence',
    color: '#28709E',
    note: '完全虚构的示例公司，可随时编辑或删除。',
    jobs: [],
  },
];

const emptyJob = (): Job => ({
  id: '',
  title: '',
  location: '',
  jobType: '校招',
  portalUrl: '',
  appliedAt: '',
  stage: '意向岗位',
  priority: '中',
  nextAction: '',
  nextDate: '',
  notes: '',
  process: [],
});

const emptyCompany = (): Company => ({
  id: '',
  name: '',
  shortName: '',
  website: '',
  color: COLORS[0],
  note: '',
  jobs: [],
});

const emptyEvent = (): ProcessEvent => ({
  id: '',
  stage: '已投递',
  title: '',
  date: localDateString(),
  note: '',
});

const emptyBatchRow = (): BatchJobRow => ({
  id: makeId('batch-row'),
  title: '',
  location: '',
  portalUrl: '',
});

const emptyBatchDefaults = (): BatchJobDefaults => ({
  jobType: '校招',
  appliedAt: '',
  stage: '意向岗位',
  priority: '中',
});

function makeId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function localDateString() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function BrandMark() {
  return (
    <Image
      className="brand-mark"
      src="/brand-mark.png"
      alt=""
      aria-hidden="true"
      width={512}
      height={512}
      priority
    />
  );
}

function NavigatorMark() {
  return (
    <Image
      className="navigator-mark-image"
      src="/career-navigator-mark.png"
      alt=""
      aria-hidden="true"
      width={512}
      height={512}
      sizes="(max-width: 640px) 44px, 50px"
      unoptimized
    />
  );
}

function BrandSignature() {
  return (
    <div className="brand-signature" aria-label="职序，Career Rhythm">
      <BrandMark />
      <div>
        <strong>职序</strong>
        <small>CAREER RHYTHM</small>
      </div>
    </div>
  );
}

function validateDateString(value: string) {
  if (!value) return '';
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return '请完整填写年、月、日。';
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = new Date(year, month - 1, day);
  if (
    candidate.getFullYear() !== year ||
    candidate.getMonth() !== month - 1 ||
    candidate.getDate() !== day
  ) {
    return '请输入真实有效的日期。';
  }
  return '';
}

function cloneExampleCompanies() {
  return EXAMPLE_COMPANIES.map((company) => ({
    ...company,
    jobs: company.jobs.map((job) => ({
      ...job,
      process: job.process.map((item) => ({ ...item })),
    })),
  }));
}

function maskAccountEmail(email: string) {
  const normalized = email.trim();
  const separator = normalized.lastIndexOf('@');
  if (separator <= 0 || separator === normalized.length - 1) return '当前登录账号';
  const localPart = normalized.slice(0, separator);
  const domain = normalized.slice(separator + 1);
  const visiblePrefix = localPart.slice(0, Math.min(2, localPart.length));
  return `${visiblePrefix}${localPart.length > 2 ? '***' : '*'}@${domain}`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function backupString(
  record: Record<string, unknown>,
  key: string,
  label: string,
  maxLength = 20_000,
) {
  const value = record[key];
  if (typeof value !== 'string' || value.length > maxLength) {
    throw new Error(`${label}格式不正确。`);
  }
  return value;
}

function backupUrl(record: Record<string, unknown>, key: string, label: string) {
  const value = backupString(record, key, label, 4_000);
  if (!value) return '';
  const parsed = new URL(value);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${label}只支持 http 或 https 链接。`);
  }
  return value;
}

function parseCompaniesValue(value: unknown): Company[] | null {
  if (!Array.isArray(value) || value.length > 500) return null;

  try {
    const companyIds = new Set<string>();
    return value.map((rawCompany, companyIndex) => {
      if (!isPlainRecord(rawCompany) || !Array.isArray(rawCompany.jobs) || rawCompany.jobs.length > 500) {
        throw new Error('公司数据格式不正确。');
      }
      const id = backupString(rawCompany, 'id', `公司 ${companyIndex + 1} 的 ID`, 200);
      const name = backupString(rawCompany, 'name', `公司 ${companyIndex + 1} 的名称`, 300);
      if (!id.trim() || !name.trim() || companyIds.has(id)) throw new Error('公司 ID 或名称无效。');
      companyIds.add(id);

      const jobIds = new Set<string>();
      const jobs = rawCompany.jobs.map((rawJob, jobIndex): Job => {
        if (!isPlainRecord(rawJob) || !Array.isArray(rawJob.process) || rawJob.process.length > 1_000) {
          throw new Error('岗位数据格式不正确。');
        }
        const jobId = backupString(rawJob, 'id', `岗位 ${jobIndex + 1} 的 ID`, 200);
        const title = backupString(rawJob, 'title', `岗位 ${jobIndex + 1} 的名称`, 500);
        const stage = backupString(rawJob, 'stage', `岗位 ${jobIndex + 1} 的流程`, 30);
        const priority = backupString(rawJob, 'priority', `岗位 ${jobIndex + 1} 的优先级`, 10);
        const appliedAt = backupString(rawJob, 'appliedAt', `岗位 ${jobIndex + 1} 的申请日期`, 10);
        const nextDate = backupString(rawJob, 'nextDate', `岗位 ${jobIndex + 1} 的下一步日期`, 10);
        if (
          !jobId.trim() ||
          !title.trim() ||
          jobIds.has(jobId) ||
          !STAGES.includes(stage as Stage) ||
          !(['高', '中', '低'] as const).includes(priority as Job['priority']) ||
          validateDateString(appliedAt) ||
          validateDateString(nextDate)
        ) {
          throw new Error('岗位 ID、名称、流程、优先级或日期无效。');
        }
        jobIds.add(jobId);

        const processIds = new Set<string>();
        const process = rawJob.process.map((rawEvent, eventIndex): ProcessEvent => {
          if (!isPlainRecord(rawEvent)) throw new Error('招聘流程记录格式不正确。');
          const eventId = backupString(rawEvent, 'id', `流程记录 ${eventIndex + 1} 的 ID`, 200);
          const eventStage = backupString(rawEvent, 'stage', `流程记录 ${eventIndex + 1} 的阶段`, 30);
          const eventDate = backupString(rawEvent, 'date', `流程记录 ${eventIndex + 1} 的日期`, 10);
          if (
            !eventId.trim() ||
            processIds.has(eventId) ||
            !STAGES.includes(eventStage as Stage) ||
            validateDateString(eventDate)
          ) {
            throw new Error('招聘流程记录的 ID、阶段或日期无效。');
          }
          processIds.add(eventId);
          return {
            ...rawEvent,
            id: eventId,
            stage: eventStage as Stage,
            title: backupString(rawEvent, 'title', `流程记录 ${eventIndex + 1} 的标题`, 500),
            date: eventDate,
            note: backupString(rawEvent, 'note', `流程记录 ${eventIndex + 1} 的备注`),
          };
        });

        return {
          ...rawJob,
          id: jobId,
          title,
          location: backupString(rawJob, 'location', `岗位 ${jobIndex + 1} 的地点`, 500),
          jobType: backupString(rawJob, 'jobType', `岗位 ${jobIndex + 1} 的招聘类型`, 200),
          portalUrl: backupUrl(rawJob, 'portalUrl', `岗位 ${jobIndex + 1} 的链接`),
          appliedAt,
          stage: stage as Stage,
          priority: priority as Job['priority'],
          nextAction: backupString(rawJob, 'nextAction', `岗位 ${jobIndex + 1} 的下一步行动`, 1_000),
          nextDate,
          notes: backupString(rawJob, 'notes', `岗位 ${jobIndex + 1} 的备注`),
          process,
        };
      });

      const color = backupString(rawCompany, 'color', `公司 ${companyIndex + 1} 的颜色`, 20);
      if (!/^#[0-9a-f]{6}$/i.test(color)) throw new Error('公司颜色格式不正确。');
      return {
        ...rawCompany,
        id,
        name,
        website: backupUrl(rawCompany, 'website', `公司 ${companyIndex + 1} 的招聘网站`),
        shortName: backupString(rawCompany, 'shortName', `公司 ${companyIndex + 1} 的简称`, 30),
        color,
        note: backupString(rawCompany, 'note', `公司 ${companyIndex + 1} 的备注`),
        jobs,
      };
    });
  } catch {
    return null;
  }
}

function parseBackupCompanies(text: string) {
  if (new TextEncoder().encode(text).byteLength > MAX_BACKUP_BYTES) {
    throw new Error('备份文件超过 4 MB。');
  }
  const parsed = JSON.parse(text) as unknown;
  if (!isPlainRecord(parsed)) throw new Error('备份根节点格式不正确。');
  const companies = parseCompaniesValue(parsed.companies);
  if (!companies) throw new Error('备份中的公司、岗位或流程数据不完整。');
  if (new TextEncoder().encode(JSON.stringify({ companies })).byteLength > MAX_STATE_BYTES) {
    throw new Error('备份内容超过云端可保存的大小。');
  }
  return companies;
}

function readCachedCompanies(storageKey: string) {
  try {
    const saved = window.localStorage.getItem(storageKey);
    if (!saved) return { found: false, companies: null as Company[] | null, dirty: false, savedAt: '', baseVersion: '' };
    const parsed = JSON.parse(saved) as unknown;
    if (Array.isArray(parsed)) {
      return { found: true, companies: parseCompaniesValue(parsed), dirty: false, savedAt: '', baseVersion: '' };
    }
    if (!isPlainRecord(parsed)) {
      return { found: true, companies: null as Company[] | null, dirty: false, savedAt: '', baseVersion: '' };
    }
    return {
      found: true,
      companies: parseCompaniesValue(parsed.companies),
      dirty: parsed.dirty === true && typeof parsed.baseVersion === 'string',
      savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : '',
      baseVersion: typeof parsed.baseVersion === 'string' ? parsed.baseVersion : '',
    };
  } catch {
    return { found: true, companies: null as Company[] | null, dirty: false, savedAt: '', baseVersion: '' };
  }
}

function usePageScrollLock(locked: boolean) {
  useEffect(() => {
    if (!locked) return;

    const body = document.body;
    const scrollY = window.scrollY;
    const previous = {
      overflow: body.style.overflow,
      position: body.style.position,
      top: body.style.top,
      left: body.style.left,
      right: body.style.right,
      width: body.style.width,
    };

    body.style.overflow = 'hidden';
    body.style.position = 'fixed';
    body.style.top = `-${scrollY}px`;
    body.style.left = '0';
    body.style.right = '0';
    body.style.width = '100%';

    return () => {
      body.style.overflow = previous.overflow;
      body.style.position = previous.position;
      body.style.top = previous.top;
      body.style.left = previous.left;
      body.style.right = previous.right;
      body.style.width = previous.width;
      window.scrollTo({ top: scrollY, left: 0, behavior: 'auto' });
    };
  }, [locked]);
}

function formatDate(date: string) {
  if (!date) return '未设置';
  const parsedDate = new Date(`${date}T00:00:00`);
  if (Number.isNaN(parsedDate.getTime())) return date.replaceAll('-', '/');
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(parsedDate);
}

function jobProgress(job: Pick<Job, 'stage' | 'process'>) {
  const reachedCoreStages = [job.stage, ...job.process.map((item) => item.stage)]
    .map((stage) => CORE_STAGES.indexOf(stage))
    .filter((index) => index >= 0);
  if (reachedCoreStages.length) return Math.max(...reachedCoreStages);
  return job.stage === '进入人才库' || job.stage === '被拒' ? 1 : 0;
}

function isInactive(stage: Stage) {
  return stage === '被拒' || stage === '已结束';
}

function qualityRateLabel(value: number | null) {
  return value === null ? '暂无样本' : `${(value * 100).toFixed(1)}%`;
}

function qualityDurationLabel(value: number | null) {
  return value === null ? '暂无样本' : `${(value / 1_000).toFixed(value >= 10_000 ? 1 : 2)} 秒`;
}

function safeAgentCount(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function safeAgentRate(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

function safeAgentAverage(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function safeAgentLimit(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 100
    ? value
    : null;
}

function normalizeAgentAdminDashboard(dashboard: AgentAdminDashboard): AgentAdminDashboard {
  const quality = dashboard?.quality ?? {} as AgentAdminDashboard['quality'];
  const defaultLimit = safeAgentLimit(dashboard?.defaultLimit) ?? 5;
  return {
    globalEnabled: dashboard?.globalEnabled === true,
    defaultLimit,
    users: Array.isArray(dashboard?.users) ? dashboard.users.map((user) => ({
      userNumber: safeAgentCount(user?.userNumber),
      role: user?.role === 'admin' ? 'admin' : 'user',
      disabled: user?.disabled === true,
      limitOverride: safeAgentLimit(user?.limitOverride),
      effectiveLimit: user?.role === 'admin' ? null : safeAgentLimit(user?.effectiveLimit) ?? defaultLimit,
      used24h: safeAgentCount(user?.used24h),
      lastCallAt: typeof user?.lastCallAt === 'string' && Number.isFinite(Date.parse(user.lastCallAt))
        ? user.lastCallAt
        : null,
      totalTokens: safeAgentCount(user?.totalTokens),
    })) : [],
    totals: {
      successfulCalls: safeAgentCount(dashboard?.totals?.successfulCalls),
      totalTokens: safeAgentCount(dashboard?.totals?.totalTokens),
    },
    quality: {
      technicalSuccessRate: safeAgentRate(quality.technicalSuccessRate),
      technicalSamples: safeAgentCount(quality.technicalSamples),
      taskSuccessRate: safeAgentRate(quality.taskSuccessRate),
      ratedTasks: safeAgentCount(quality.ratedTasks),
      oneRoundResolutionRate: safeAgentRate(quality.oneRoundResolutionRate),
      oneRoundResolvedTasks: safeAgentCount(quality.oneRoundResolvedTasks),
      feedbackCoverageRate: safeAgentRate(quality.feedbackCoverageRate),
      feedbackEligibleTasks: safeAgentCount(quality.feedbackEligibleTasks),
      toolParameterSchemaPassRate: safeAgentRate(quality.toolParameterSchemaPassRate),
      toolParameterSamples: safeAgentCount(quality.toolParameterSamples),
      actionExecutionSuccessRate: safeAgentRate(quality.actionExecutionSuccessRate),
      actionExecutionSamples: safeAgentCount(quality.actionExecutionSamples),
      ambiguitySafeClarificationRate: safeAgentRate(quality.ambiguitySafeClarificationRate),
      ambiguitySamples: safeAgentCount(quality.ambiguitySamples),
      wrongActionRate: safeAgentRate(quality.wrongActionRate),
      actionFeedbackSamples: safeAgentCount(quality.actionFeedbackSamples),
      unauthorizedExecutionCount: safeAgentCount(quality.unauthorizedExecutionCount),
      duplicateBlockedCount: safeAgentCount(quality.duplicateBlockedCount),
      versionConflictRate: safeAgentRate(quality.versionConflictRate),
      versionConflictSamples: safeAgentCount(quality.versionConflictSamples),
      averageCompletedRounds: safeAgentAverage(quality.averageCompletedRounds),
      completedTasks: safeAgentCount(quality.completedTasks),
      averageLatencyMs: safeAgentAverage(quality.averageLatencyMs),
      p95LatencyMs: safeAgentAverage(quality.p95LatencyMs),
      latencySamples: safeAgentCount(quality.latencySamples),
    },
  };
}

function metricAvailability(samples: number): AgentEvaluationRow['status'] {
  return samples > 0 ? '可用' : '等待样本';
}

function buildAgentEvaluationRows(quality: AgentAdminDashboard['quality']): AgentEvaluationRow[] {
  return [
    {
      category: '核心结果',
      name: '用户确认任务解决率',
      value: qualityRateLabel(quality.taskSuccessRate),
      sample: `${quality.ratedTasks} 个已评价任务`,
      definition: '用户标记“已解决”的任务 ÷ 全部已评价任务',
      status: metricAvailability(quality.ratedTasks),
      core: true,
    },
    {
      category: '核心结果',
      name: '一轮解决率',
      value: qualityRateLabel(quality.oneRoundResolutionRate),
      sample: `${quality.ratedTasks} 个已评价任务`,
      definition: '一轮内解决的任务 ÷ 全部已评价任务',
      status: metricAvailability(quality.ratedTasks),
      core: true,
    },
    {
      category: '质量',
      name: '反馈覆盖率',
      value: qualityRateLabel(quality.feedbackCoverageRate),
      sample: `${quality.feedbackEligibleTasks} 个可评价任务`,
      definition: '收到用户评价的任务 ÷ 可评价成功任务',
      status: metricAvailability(quality.feedbackEligibleTasks),
    },
    {
      category: '质量',
      name: '技术成功率',
      value: qualityRateLabel(quality.technicalSuccessRate),
      sample: `${quality.technicalSamples} 次有效调用`,
      definition: '模型正常返回次数 ÷ 成功与技术失败调用总数',
      status: metricAvailability(quality.technicalSamples),
      core: true,
    },
    {
      category: '效率',
      name: '完成任务平均轮数',
      value: quality.averageCompletedRounds === null ? '暂无样本' : `${quality.averageCompletedRounds.toFixed(1)} 轮`,
      sample: `${quality.completedTasks} 个已解决任务`,
      definition: '已解决任务中的有效交互轮数平均值',
      status: metricAvailability(quality.completedTasks),
    },
    {
      category: '效率',
      name: '平均响应时长',
      value: qualityDurationLabel(quality.averageLatencyMs),
      sample: `${quality.latencySamples} 次成功调用`,
      definition: '成功调用的服务端处理时长平均值',
      status: metricAvailability(quality.latencySamples),
    },
    {
      category: '效率',
      name: '95 分位响应时长',
      value: qualityDurationLabel(quality.p95LatencyMs),
      sample: `${quality.latencySamples} 次成功调用`,
      definition: '95% 成功调用不超过的服务端处理时长',
      status: metricAvailability(quality.latencySamples),
    },
    {
      category: '工具',
      name: '工具参数校验通过率',
      value: qualityRateLabel(quality.toolParameterSchemaPassRate),
      sample: `${quality.toolParameterSamples} 次工具提案`,
      definition: '通过后端结构与取值校验的工具参数 ÷ 全部工具提案',
      status: metricAvailability(quality.toolParameterSamples),
    },
    {
      category: '工具',
      name: '工具执行成功率',
      value: qualityRateLabel(quality.actionExecutionSuccessRate),
      sample: `${quality.actionExecutionSamples} 次确认执行`,
      definition: '数据库真实执行成功次数 ÷ 已确认并尝试执行次数',
      status: metricAvailability(quality.actionExecutionSamples),
    },
    {
      category: '安全',
      name: '多候选请求安全澄清率',
      value: qualityRateLabel(quality.ambiguitySafeClarificationRate),
      sample: `${quality.ambiguitySamples} 次歧义请求`,
      definition: '先澄清且未提前执行的零匹配或多匹配请求占比',
      status: metricAvailability(quality.ambiguitySamples),
    },
    {
      category: '安全',
      name: '未经确认执行次数',
      value: `${quality.unauthorizedExecutionCount} 次`,
      sample: `${quality.actionExecutionSamples} 次确认执行`,
      definition: '缺少二次确认记录却发生写入的次数，安全目标必须为 0',
      status: quality.actionExecutionSamples === 0
        ? '等待样本'
        : quality.unauthorizedExecutionCount === 0 ? '安全目标' : '需关注',
    },
    {
      category: '安全',
      name: '提案或操作有误率',
      value: qualityRateLabel(quality.wrongActionRate),
      sample: `${quality.actionFeedbackSamples} 次提案与操作评价`,
      definition: '用户标记“提案信息有误”或“操作有误”的记录 ÷ 全部已评价提案与操作',
      status: quality.actionFeedbackSamples === 0
        ? '等待样本'
        : quality.wrongActionRate === 0 ? '安全目标' : '需关注',
      core: true,
    },
    {
      category: '安全',
      name: '版本冲突率',
      value: qualityRateLabel(quality.versionConflictRate),
      sample: `${quality.versionConflictSamples} 次确认执行`,
      definition: '因确认前数据已变化而被安全拦截的执行占比',
      status: quality.versionConflictSamples === 0
        ? '等待样本'
        : quality.versionConflictRate === 0 ? '安全目标' : '需关注',
    },
    {
      category: '质量',
      name: '重复新增拦截次数',
      value: `${quality.duplicateBlockedCount} 次`,
      sample: '累计安全事件',
      definition: '疑似重复公司或岗位被后端阻止并要求核对的次数',
      status: '可用',
    },
  ];
}

function AgentEvaluationCard({ metric }: { metric: AgentEvaluationRow }) {
  return (
    <article className={`navigator-evaluation-card ${metric.core ? 'is-core' : ''}`}>
      <header>
        <span className={`navigator-evaluation-category is-${metric.category}`}>{metric.category}</span>
        <span className={`navigator-evaluation-status is-${metric.status}`}>{metric.status}</span>
      </header>
      <h4>{metric.name}</h4>
      <div className="navigator-evaluation-result">
        <strong>{metric.value}</strong>
        <small>{metric.sample}</small>
      </div>
      <details className="navigator-evaluation-definition">
        <summary>统计口径</summary>
        <p>{metric.definition}</p>
      </details>
    </article>
  );
}

function parseAgentLimitDraft(value: string) {
  if (!/^\d{1,3}$/.test(value)) return null;
  const limit = Number(value);
  return Number.isSafeInteger(limit) && limit >= 0 && limit <= 100 ? limit : null;
}

function agentAdminUpdateKey(update: AgentAdminUpdate) {
  if (update.kind === 'global' || update.kind === 'default_limit') return update.kind;
  return `${update.kind}:${update.userNumber}`;
}

function applyOptimisticAgentAdminUpdate(
  dashboard: AgentAdminDashboard,
  update: AgentAdminUpdate,
): AgentAdminDashboard {
  if (update.kind === 'global') return { ...dashboard, globalEnabled: update.enabled };
  if (update.kind === 'default_limit') {
    return {
      ...dashboard,
      defaultLimit: update.limit,
      users: dashboard.users.map((user) => (
        user.role === 'user' && user.limitOverride === null
          ? { ...user, effectiveLimit: update.limit }
          : user
      )),
    };
  }
  if (update.kind === 'user_limit') {
    return {
      ...dashboard,
      users: dashboard.users.map((user) => (
        user.userNumber === update.userNumber && user.role === 'user'
          ? {
              ...user,
              limitOverride: update.limit,
              effectiveLimit: update.limit ?? dashboard.defaultLimit,
            }
          : user
      )),
    };
  }
  return {
    ...dashboard,
    users: dashboard.users.map((user) => (
      user.userNumber === update.userNumber && user.role === 'user'
        ? { ...user, disabled: update.disabled }
        : user
    )),
  };
}

export default function Home() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [ready, setReady] = useState(false);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('loading');
  const [userEmail, setUserEmail] = useState('');
  const [authProvider, setAuthProvider] = useState<AuthProvider>('chatgpt');
  const [authNotice, setAuthNotice] = useState('');
  const [activeStorageKey, setActiveStorageKey] = useState('');
  const [selectedCompanyId, setSelectedCompanyId] = useState<string | null>(null);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [stageFilter, setStageFilter] = useState<'全部流程' | Stage>('全部流程');
  const [selectedMetric, setSelectedMetric] = useState<SummaryMetric | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [navigatorOpen, setNavigatorOpen] = useState(false);
  const [navigatorCommand, setNavigatorCommand] = useState('');
  const [navigatorResult, setNavigatorResult] = useState<NavigatorCommandResult | null>(null);
  const [agentMode, setAgentMode] = useState<AgentMode>('basic');
  const [agentStatus, setAgentStatus] = useState<AgentStatus | null>(null);
  const [agentStatusLoading, setAgentStatusLoading] = useState(false);
  const [agentAnswer, setAgentAnswer] = useState('');
  const [agentError, setAgentError] = useState('');
  const [agentQueryLoading, setAgentQueryLoading] = useState(false);
  const [agentCallId, setAgentCallId] = useState('');
  const [agentFeedback, setAgentFeedback] = useState<AgentFeedbackState>('idle');
  const [agentFeedbackLoading, setAgentFeedbackLoading] = useState(false);
  const [agentActionProposal, setAgentActionProposal] = useState<AgentActionProposal | null>(null);
  const [agentActionConfirmOpen, setAgentActionConfirmOpen] = useState(false);
  const [agentActionLoading, setAgentActionLoading] = useState(false);
  const [agentActionError, setAgentActionError] = useState('');
  const [agentActionCompleted, setAgentActionCompleted] = useState<AgentActionCompleted | null>(null);
  const [agentActionFeedback, setAgentActionFeedback] = useState<AgentActionFeedbackState>('idle');
  const [agentActionFeedbackLoading, setAgentActionFeedbackLoading] = useState(false);
  const [agentProposalReview, setAgentProposalReview] = useState<AgentProposalReviewState>('idle');
  const [agentAdminOpen, setAgentAdminOpen] = useState(false);
  const [agentAdminDashboard, setAgentAdminDashboard] = useState<AgentAdminDashboard | null>(null);
  const [agentAdminLoading, setAgentAdminLoading] = useState(false);
  const [agentAdminError, setAgentAdminError] = useState('');
  const [agentAdminPendingKey, setAgentAdminPendingKey] = useState('');
  const [agentDefaultLimitDraft, setAgentDefaultLimitDraft] = useState('5');
  const [agentUserLimitDrafts, setAgentUserLimitDrafts] = useState<Record<number, string>>({});

  const [companyDraft, setCompanyDraft] = useState<Company | null>(null);
  const [editingCompanyId, setEditingCompanyId] = useState<string | null>(null);
  const [initialCompanyDraftSignature, setInitialCompanyDraftSignature] = useState('');
  const [addOpportunityOpen, setAddOpportunityOpen] = useState(false);
  const [continueToJobAfterCompany, setContinueToJobAfterCompany] = useState(false);
  const [pendingJobDraftAfterCompany, setPendingJobDraftAfterCompany] = useState<Job | null>(null);
  const [pendingJobCompanyIdAfterCompany, setPendingJobCompanyIdAfterCompany] = useState<string | null>(null);
  const [jobDraft, setJobDraft] = useState<Job | null>(null);
  const [jobCompanyId, setJobCompanyId] = useState<string | null>(null);
  const [editingJobId, setEditingJobId] = useState<string | null>(null);
  const [jobEntryContext, setJobEntryContext] = useState<JobEntryContext>('dashboard');
  const [jobDateError, setJobDateError] = useState('');
  const [jobDraftError, setJobDraftError] = useState('');
  const [initialJobDraftSignature, setInitialJobDraftSignature] = useState('');
  const [stageFilterOpen, setStageFilterOpen] = useState(false);
  const [batchCompanyId, setBatchCompanyId] = useState<string | null>(null);
  const [batchRows, setBatchRows] = useState<BatchJobRow[]>([]);
  const [batchDefaults, setBatchDefaults] = useState<BatchJobDefaults>(emptyBatchDefaults());
  const [batchError, setBatchError] = useState('');
  const [batchRowErrors, setBatchRowErrors] = useState<Record<string, string>>({});
  const [initialBatchDraftSignature, setInitialBatchDraftSignature] = useState('');
  const [discardTarget, setDiscardTarget] = useState<'company' | 'job' | 'batch' | null>(null);
  const [eventDraft, setEventDraft] = useState<ProcessEvent | null>(null);
  const [editingEventId, setEditingEventId] = useState<string | null>(null);
  const [pasteImportOpen, setPasteImportOpen] = useState(false);
  const [backupText, setBackupText] = useState('');
  const [backupError, setBackupError] = useState('');
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const [deleteDataOpen, setDeleteDataOpen] = useState(false);
  const [deleteConfirmationStep, setDeleteConfirmationStep] = useState<1 | 2>(1);
  const [deletingData, setDeletingData] = useState(false);
  const [deleteNeedsRefresh, setDeleteNeedsRefresh] = useState(false);
  const [accountActionError, setAccountActionError] = useState('');
  const [authDisconnecting, setAuthDisconnecting] = useState(false);
  const [authDisconnectError, setAuthDisconnectError] = useState('');
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingConfirmation | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const cloudSyncEnabled = useRef(false);
  const cloudVersionRef = useRef(NO_STATE_VERSION);
  const activeUserIdRef = useRef('');
  const activeStorageKeyRef = useRef('');
  const identityCheckInFlightRef = useRef(false);
  const skipNextCloudSave = useRef(false);
  const skipNextLocalCacheWrite = useRef(false);
  const saveSequence = useRef(0);
  const saveTimerRef = useRef<number | null>(null);
  const saveAbortControllerRef = useRef<AbortController | null>(null);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const backupInputRef = useRef<HTMLInputElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const mobileMenuButtonRef = useRef<HTMLButtonElement>(null);
  const viewHeadingRef = useRef<HTMLHeadingElement>(null);
  const metricDetailHeadingRef = useRef<HTMLHeadingElement>(null);
  const previousViewRef = useRef('home');
  const agentSessionIdRef = useRef('');
  const agentQueryInFlightRef = useRef(false);
  const agentFeedbackInFlightRef = useRef(false);
  const agentAdminUpdateInFlightRef = useRef(false);
  const agentStatusRequestRef = useRef<Promise<void> | null>(null);
  const agentStatusFetchedAtRef = useRef(0);
  const agentAdminRequestRef = useRef<Promise<void> | null>(null);
  const agentAdminFetchedAtRef = useRef(0);
  const agentAdminDashboardRef = useRef<AgentAdminDashboard | null>(null);

  const clearCurrentAccountFromDevice = useCallback((nextStatus?: SyncStatus) => {
    cloudSyncEnabled.current = false;
    saveSequence.current += 1;
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    saveAbortControllerRef.current?.abort();
    saveAbortControllerRef.current = null;
    try {
      if (activeStorageKeyRef.current) window.localStorage.removeItem(activeStorageKeyRef.current);
      window.localStorage.removeItem(LEGACY_STORAGE_KEY);
    } catch {
      // Account isolation must continue even when browser storage is unavailable.
    }

    activeUserIdRef.current = '';
    activeStorageKeyRef.current = '';
    cloudVersionRef.current = NO_STATE_VERSION;
    skipNextCloudSave.current = true;
    skipNextLocalCacheWrite.current = true;
    setCompanies([]);
    setUserEmail('');
    setAuthProvider('chatgpt');
    setActiveStorageKey('');
    setSelectedCompanyId(null);
    setSelectedJobId(null);
    setQuery('');
    setStageFilter('全部流程');
    setSelectedMetric(null);
    setSidebarOpen(false);
    setNavigatorOpen(false);
    setNavigatorCommand('');
    setNavigatorResult(null);
    setAgentMode('basic');
    setAgentStatus(null);
    setAgentStatusLoading(false);
    setAgentAnswer('');
    setAgentError('');
    setAgentQueryLoading(false);
    setAgentCallId('');
    setAgentFeedback('idle');
    setAgentFeedbackLoading(false);
    setAgentActionProposal(null);
    setAgentActionConfirmOpen(false);
    setAgentActionLoading(false);
    setAgentActionError('');
    setAgentActionCompleted(null);
    setAgentActionFeedback('idle');
    setAgentActionFeedbackLoading(false);
    setAgentProposalReview('idle');
    agentSessionIdRef.current = '';
    agentQueryInFlightRef.current = false;
    agentFeedbackInFlightRef.current = false;
    agentAdminUpdateInFlightRef.current = false;
    agentStatusRequestRef.current = null;
    agentStatusFetchedAtRef.current = 0;
    agentAdminRequestRef.current = null;
    agentAdminFetchedAtRef.current = 0;
    agentAdminDashboardRef.current = null;
    setAgentAdminOpen(false);
    setAgentAdminDashboard(null);
    setAgentAdminLoading(false);
    setAgentAdminError('');
    setAgentAdminPendingKey('');
    setAgentDefaultLimitDraft('5');
    setAgentUserLimitDrafts({});
    setCompanyDraft(null);
    setEditingCompanyId(null);
    setInitialCompanyDraftSignature('');
    setAddOpportunityOpen(false);
    setContinueToJobAfterCompany(false);
    setPendingJobDraftAfterCompany(null);
    setPendingJobCompanyIdAfterCompany(null);
    setJobDraft(null);
    setJobCompanyId(null);
    setEditingJobId(null);
    setJobEntryContext('dashboard');
    setJobDateError('');
    setJobDraftError('');
    setInitialJobDraftSignature('');
    setStageFilterOpen(false);
    setBatchCompanyId(null);
    setBatchRows([]);
    setBatchDefaults(emptyBatchDefaults());
    setBatchError('');
    setBatchRowErrors({});
    setInitialBatchDraftSignature('');
    setDiscardTarget(null);
    setEventDraft(null);
    setEditingEventId(null);
    setPasteImportOpen(false);
    setBackupText('');
    setBackupError('');
    setPrivacyOpen(false);
    setDeleteDataOpen(false);
    setDeleteConfirmationStep(1);
    setDeletingData(false);
    setDeleteNeedsRefresh(false);
    setAccountActionError('');
    setAuthDisconnecting(false);
    setAuthDisconnectError('');
    setPendingConfirmation(null);
    setNotice(null);
    if (backupInputRef.current) backupInputRef.current.value = '';
    if (nextStatus) setSyncStatus(nextStatus);
    setReady(true);
  }, []);

  const replaceAfterAccountContextChange = useCallback((nextStatus: SyncStatus) => {
    clearCurrentAccountFromDevice(nextStatus);
    window.location.replace(window.location.href);
  }, [clearCurrentAccountFromDevice]);

  const applyAgentAdminDashboard = useCallback((dashboard: AgentAdminDashboard) => {
    const normalizedDashboard = normalizeAgentAdminDashboard(dashboard);
    agentAdminDashboardRef.current = normalizedDashboard;
    setAgentAdminDashboard(normalizedDashboard);
    setAgentDefaultLimitDraft(String(normalizedDashboard.defaultLimit));
    setAgentUserLimitDrafts(Object.fromEntries(normalizedDashboard.users.flatMap((user) => (
      user.role === 'admin' || user.effectiveLimit === null
        ? []
        : [[user.userNumber, String(user.effectiveLimit)]]
    ))));
  }, []);

  const refreshAgentStatus = useCallback(async (force = false) => {
    const expectedUserId = activeUserIdRef.current;
    if (!expectedUserId) return;
    const cacheIsFresh = Date.now() - agentStatusFetchedAtRef.current < AGENT_STATUS_CACHE_MS;
    if (!force && cacheIsFresh) return;
    if (agentStatusRequestRef.current) return agentStatusRequestRef.current;

    const request = (async () => {
      setAgentStatusLoading(true);
      try {
        const response = await fetch('/api/agent/status', {
          cache: 'no-store',
          headers: { 'x-expected-user-id': expectedUserId },
        });
        if (response.status === 409) {
          replaceAfterAccountContextChange('loading');
          return;
        }
        if (!response.ok) throw new Error('Agent status unavailable.');
        const payload = await response.json() as { status?: AgentStatus };
        if (!payload.status) throw new Error('Agent status is missing.');
        if (activeUserIdRef.current !== expectedUserId) return;
        setAgentStatus(payload.status);
        agentStatusFetchedAtRef.current = Date.now();
      } catch {
        // Keep the last known status visible; the basic assistant remains available.
      } finally {
        setAgentStatusLoading(false);
      }
    })();
    agentStatusRequestRef.current = request;
    try {
      await request;
    } finally {
      if (agentStatusRequestRef.current === request) agentStatusRequestRef.current = null;
    }
  }, [replaceAfterAccountContextChange]);

  const loadAgentAdminDashboard = useCallback(async (force = false) => {
    const expectedUserId = activeUserIdRef.current;
    if (!expectedUserId) return;
    const cacheIsFresh = Boolean(agentAdminDashboardRef.current)
      && Date.now() - agentAdminFetchedAtRef.current < AGENT_ADMIN_CACHE_MS;
    if (!force && cacheIsFresh) return;
    if (agentAdminRequestRef.current) return agentAdminRequestRef.current;
    const showInitialLoading = !agentAdminDashboardRef.current;

    const request = (async () => {
      if (showInitialLoading) setAgentAdminLoading(true);
      setAgentAdminError('');
      try {
        const response = await fetch('/api/admin/agent', {
          cache: 'no-store',
          headers: { 'x-expected-user-id': expectedUserId },
        });
        if (response.status === 409) {
          replaceAfterAccountContextChange('loading');
          return;
        }
        if (!response.ok) throw new Error('Admin dashboard unavailable.');
        const dashboard = await response.json() as AgentAdminDashboard;
        if (activeUserIdRef.current !== expectedUserId) return;
        applyAgentAdminDashboard(dashboard);
        agentAdminFetchedAtRef.current = Date.now();
      } catch {
        if (!agentAdminDashboardRef.current) {
          setAgentAdminError('暂时无法读取管理数据，请稍后重试。');
        }
      } finally {
        if (showInitialLoading) setAgentAdminLoading(false);
      }
    })();
    agentAdminRequestRef.current = request;
    try {
      await request;
    } finally {
      if (agentAdminRequestRef.current === request) agentAdminRequestRef.current = null;
    }
  }, [applyAgentAdminDashboard, replaceAfterAccountContextChange]);

  const openNavigatorPanel = useCallback(() => {
    setNavigatorResult(null);
    setAgentError('');
    setAgentAnswer('');
    setAgentCallId('');
    setAgentFeedback('idle');
    setAgentFeedbackLoading(false);
    setAgentActionProposal(null);
    setAgentActionConfirmOpen(false);
    setAgentActionLoading(false);
    setAgentActionError('');
    setAgentActionCompleted(null);
    setAgentActionFeedback('idle');
    setAgentActionFeedbackLoading(false);
    setAgentProposalReview('idle');
    agentSessionIdRef.current = crypto.randomUUID();
    setNavigatorOpen(true);
    void refreshAgentStatus();
  }, [refreshAgentStatus]);

  const dialogOpen = Boolean(
    companyDraft ||
    addOpportunityOpen ||
    jobDraft ||
    stageFilterOpen ||
    (batchCompanyId && companies.some((company) => company.id === batchCompanyId)) ||
    eventDraft ||
    pasteImportOpen ||
    privacyOpen ||
    deleteDataOpen ||
    navigatorOpen ||
    agentAdminOpen ||
    agentActionConfirmOpen ||
    pendingConfirmation
  );
  const overlayOpen = sidebarOpen || dialogOpen;
  const viewKey = selectedCompanyId ? `${selectedCompanyId}:${selectedJobId ?? 'company'}` : 'home';

  usePageScrollLock(overlayOpen);

  useEffect(() => {
    if (!navigatorOpen || agentMode !== 'intelligent') return;
    const syncVisibleStatus = () => {
      if (document.visibilityState === 'visible') void refreshAgentStatus();
    };
    const timer = window.setInterval(syncVisibleStatus, 60_000);
    window.addEventListener('focus', syncVisibleStatus);
    document.addEventListener('visibilitychange', syncVisibleStatus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', syncVisibleStatus);
      document.removeEventListener('visibilitychange', syncVisibleStatus);
    };
  }, [agentMode, navigatorOpen, refreshAgentStatus]);

  useEffect(() => {
    if (!ready || !activeUserIdRef.current) return;
    const timer = window.setTimeout(() => void refreshAgentStatus(), 180);
    return () => window.clearTimeout(timer);
  }, [ready, refreshAgentStatus]);

  useEffect(() => {
    if (!ready || !agentStatus?.isAdmin || !activeUserIdRef.current) return;
    const timer = window.setTimeout(() => void loadAgentAdminDashboard(), 320);
    return () => window.clearTimeout(timer);
  }, [agentStatus?.isAdmin, loadAgentAdminDashboard, ready]);

  useEffect(() => {
    const url = new URL(window.location.href);
    const githubResult = url.searchParams.get('github_auth');
    let noticeTimer = 0;
    if (githubResult === 'failed') {
      noticeTimer = window.setTimeout(() => {
        setAuthNotice('GitHub 登录没有完成，请重试。你的本机缓存和云端求职数据都没有受到影响。');
      }, 0);
    }
    if (githubResult === 'success' || githubResult === 'failed') {
      url.searchParams.delete('github_auth');
      window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    }
    return () => window.clearTimeout(noticeTimer);
  }, []);

  useEffect(() => {
    const desktopLayout = window.matchMedia('(min-width: 861px)');
    const closeMobileDrawer = (event: MediaQueryListEvent | MediaQueryList) => {
      if (event.matches) setSidebarOpen(false);
    };
    closeMobileDrawer(desktopLayout);
    desktopLayout.addEventListener('change', closeMobileDrawer);
    return () => desktopLayout.removeEventListener('change', closeMobileDrawer);
  }, []);

  useEffect(() => {
    if (!selectedMetric) return;
    const frame = window.requestAnimationFrame(() => {
      const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      metricDetailHeadingRef.current?.scrollIntoView({
        behavior: reduceMotion ? 'auto' : 'smooth',
        block: 'start',
      });
      metricDetailHeadingRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [selectedMetric]);

  useEffect(() => {
    if (!sidebarOpen) return;

    const menuButton = mobileMenuButtonRef.current;
    const frame = window.requestAnimationFrame(() => {
      (sidebarRef.current?.querySelector<HTMLElement>('.sidebar-close') ??
        sidebarRef.current?.querySelector<HTMLElement>('button'))?.focus();
    });
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setSidebarOpen(false);
        return;
      }
      if (event.key !== 'Tab' || !sidebarRef.current) return;
      const focusable = Array.from(
        sidebarRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => element.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('keydown', handleKeyDown);
      menuButton?.focus();
    };
  }, [sidebarOpen]);

  useEffect(() => {
    if (!ready) {
      previousViewRef.current = viewKey;
      return;
    }
    if (previousViewRef.current === viewKey) return;
    previousViewRef.current = viewKey;
    const frame = window.requestAnimationFrame(() => {
      window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
      viewHeadingRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [ready, viewKey]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 3200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 12_000);

    const loadState = async () => {
      try {
        const response = await fetch('/api/state', { cache: 'no-store', signal: controller.signal });
        if (response.status === 401) {
          if (!cancelled) clearCurrentAccountFromDevice('signed-out');
          window.clearTimeout(timeout);
          return;
        }
        if (response.status === 403) {
          if (!cancelled) clearCurrentAccountFromDevice('access-denied');
          window.clearTimeout(timeout);
          return;
        }
        if (response.status === 409) {
          if (!cancelled) clearCurrentAccountFromDevice('access-denied');
          window.clearTimeout(timeout);
          return;
        }
        if (!response.ok) throw new Error('Cloud state could not be loaded.');

        const payload = (await response.json()) as {
          state: { companies?: Company[] } | null;
          updatedAt?: string | null;
          version?: string;
          user?: { id?: string; email?: string; provider?: AuthProvider; displayName?: string };
        };
        if (cancelled) return;

        const userId = payload.user?.id?.trim();
        if (!userId) throw new Error('Authenticated user ID is unavailable.');
        if (activeUserIdRef.current && activeUserIdRef.current !== userId) {
          replaceAfterAccountContextChange('loading');
          return;
        }
        const userStorageKey = storageKeyForUser(userId);
        const cachedState = readCachedCompanies(userStorageKey);
        const cloudVersion = typeof payload.version === 'string' ? payload.version : NO_STATE_VERSION;
        cloudVersionRef.current = cloudVersion;
        const cloudStateExists = payload.state !== null && payload.state !== undefined;
        const cloudCompanies = parseCompaniesValue(payload.state?.companies);
        const retryableCachedCompanies = cachedState.companies
          && cachedState.dirty
          && cachedState.baseVersion === cloudVersion
          ? cachedState.companies
          : null;
        let loadedStateIsValid = true;

        if (cloudStateExists && cloudCompanies && retryableCachedCompanies) {
          setCompanies(retryableCachedCompanies);
        } else if (cloudStateExists && cloudCompanies) {
          if (cachedState.companies && cachedState.dirty) {
            loadedStateIsValid = false;
            setCompanies(cachedState.companies);
          } else {
            skipNextCloudSave.current = true;
            setCompanies(cloudCompanies);
          }
        } else if (cloudStateExists) {
          loadedStateIsValid = false;
          setCompanies(cachedState.companies ?? []);
        } else if (retryableCachedCompanies) {
          setCompanies(retryableCachedCompanies);
        } else if (cachedState.companies && cachedState.dirty) {
          loadedStateIsValid = false;
          setCompanies(cachedState.companies);
        } else {
          skipNextCloudSave.current = true;
          setCompanies([]);
        }
        try {
          window.localStorage.removeItem(LEGACY_STORAGE_KEY);
        } catch {
          // Cloud sync remains available when browser storage is disabled.
        }
        activeUserIdRef.current = userId;
        activeStorageKeyRef.current = userStorageKey;
        setActiveStorageKey(userStorageKey);
        setUserEmail(payload.user?.email || payload.user?.displayName || '当前登录账号');
        setAuthProvider(payload.user?.provider === 'github' ? 'github' : 'chatgpt');
        cloudSyncEnabled.current = loadedStateIsValid;
        setSyncStatus(loadedStateIsValid ? 'synced' : 'error');
      } catch {
        if (cancelled) return;
        setSyncStatus('offline');
      }
      window.clearTimeout(timeout);
      setReady(true);
    };

    void loadState();
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [clearCurrentAccountFromDevice, replaceAfterAccountContextChange]);

  useEffect(() => {
    if (!ready || !activeUserIdRef.current) return;
    let disposed = false;

    const verifyIdentity = async () => {
      if (disposed || identityCheckInFlightRef.current || !activeUserIdRef.current) return;
      identityCheckInFlightRef.current = true;
      try {
        const response = await fetch('/api/state', { cache: 'no-store' });
        if (disposed) return;
        if (response.status === 401) {
          replaceAfterAccountContextChange('signed-out');
          return;
        }
        if (response.status === 403) {
          replaceAfterAccountContextChange('access-denied');
          return;
        }
        if (response.status === 409) {
          replaceAfterAccountContextChange('access-denied');
          return;
        }
        if (!response.ok) return;
        const payload = (await response.json()) as { user?: { id?: string } };
        const confirmedUserId = payload.user?.id?.trim();
        if (!confirmedUserId || confirmedUserId !== activeUserIdRef.current) {
          replaceAfterAccountContextChange('loading');
        }
      } catch {
        // A temporary network failure is not evidence of an account change.
      } finally {
        identityCheckInFlightRef.current = false;
      }
    };

    const handleFocus = () => { void verifyIdentity(); };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') void verifyIdentity();
    };
    const handlePageShow = () => { void verifyIdentity(); };

    window.addEventListener('focus', handleFocus);
    window.addEventListener('pageshow', handlePageShow);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      disposed = true;
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener('pageshow', handlePageShow);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [ready, replaceAfterAccountContextChange]);

  useEffect(() => {
    if (!ready || !activeStorageKey) return;
    const expectedUserId = activeUserIdRef.current;
    if (!expectedUserId) return;
    const skipCloudSave = skipNextCloudSave.current;
    const cacheSavedAt = new Date().toISOString();
    if (skipNextLocalCacheWrite.current) {
      skipNextLocalCacheWrite.current = false;
    } else {
      try {
        window.localStorage.setItem(activeStorageKey, JSON.stringify({
          companies,
          dirty: !skipCloudSave,
          savedAt: cacheSavedAt,
          baseVersion: cloudVersionRef.current,
        }));
      } catch {
        // The cloud remains the source of truth when browser storage is unavailable.
      }
    }
    if (skipCloudSave) {
      skipNextCloudSave.current = false;
      return;
    }
    if (!cloudSyncEnabled.current) return;

    const sequence = ++saveSequence.current;
    const timer = window.setTimeout(() => {
      saveTimerRef.current = null;
      if (!cloudSyncEnabled.current) return;
      const savePromise = saveQueueRef.current.then(async () => {
        if (!cloudSyncEnabled.current) return;
        const baseVersion = cloudVersionRef.current;
        setSyncStatus('saving');
        const saveController = new AbortController();
        saveAbortControllerRef.current = saveController;
        try {
          const response = await fetch('/api/state', {
            method: 'PUT',
            headers: {
              'content-type': 'application/json',
              'x-state-base-version': baseVersion,
              'x-expected-user-id': expectedUserId,
            },
            body: JSON.stringify({ companies }),
            signal: saveController.signal,
          });
          if (response.status === 401) {
            replaceAfterAccountContextChange('signed-out');
            return;
          }
          if (response.status === 403) {
            replaceAfterAccountContextChange('access-denied');
            return;
          }
          if (response.status === 409) {
            const conflict = await response.json().catch(() => null) as { error?: string } | null;
            if (conflict?.error === 'account_context_changed') {
              replaceAfterAccountContextChange('loading');
              return;
            }
            cloudSyncEnabled.current = false;
            setSyncStatus('error');
            return;
          }
          if (!response.ok) throw new Error('Cloud save failed.');
          const saved = (await response.json()) as { version?: string };
          if (!saved.version) throw new Error('Cloud save version is unavailable.');
          // A delete waits for this queue after pausing new saves. Keep the
          // latest server version for that delete as long as the account did
          // not change; cloudSyncEnabled only controls further cache/UI work.
          if (activeUserIdRef.current !== expectedUserId) return;
          cloudVersionRef.current = saved.version;
          if (saveSequence.current === sequence && cloudSyncEnabled.current) {
            try {
              window.localStorage.setItem(activeStorageKey, JSON.stringify({
                companies,
                dirty: false,
                savedAt: new Date().toISOString(),
                baseVersion: saved.version,
              }));
            } catch {
              // Cloud save success does not depend on local cache availability.
            }
            setSyncStatus('synced');
          }
        } catch {
          if (saveSequence.current === sequence && cloudSyncEnabled.current) setSyncStatus('error');
        } finally {
          if (saveAbortControllerRef.current === saveController) saveAbortControllerRef.current = null;
        }
      });
      saveQueueRef.current = savePromise;
    }, 500);
    saveTimerRef.current = timer;

    return () => {
      window.clearTimeout(timer);
      if (saveTimerRef.current === timer) saveTimerRef.current = null;
    };
  }, [activeStorageKey, companies, ready, replaceAfterAccountContextChange]);

  const allJobs = useMemo<FlatJob[]>(
    () =>
      companies.flatMap((company) =>
        company.jobs.map((job) => ({
          ...job,
          companyId: company.id,
          companyName: company.name,
          companyColor: company.color,
        })),
      ),
    [companies],
  );

  const navigatorBriefing = useMemo(
    () => buildNavigatorBriefing(companies, localDateString()),
    [companies],
  );

  const selectedCompany = companies.find((company) => company.id === selectedCompanyId) ?? null;
  const selectedJob = selectedCompany?.jobs.find((job) => job.id === selectedJobId) ?? null;
  const batchCompany = companies.find((company) => company.id === batchCompanyId) ?? null;
  const batchMeaningfulCount = batchRows.filter((row) => row.title.trim() || row.location.trim() || row.portalUrl.trim()).length;
  const activeJobs = allJobs.filter((job) => !isInactive(job.stage));
  const offers = allJobs.filter((job) => job.stage === 'Offer');
  const interviewJobs = allJobs.filter(
    (job) => job.stage === '一面' || job.stage === '后续面试',
  );

  const filteredJobs = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return allJobs.filter((job) => {
      const matchesSearch =
        !normalized ||
        job.title.toLowerCase().includes(normalized) ||
        job.companyName.toLowerCase().includes(normalized) ||
        job.location.toLowerCase().includes(normalized);
      const matchesStage = stageFilter === '全部流程' || job.stage === stageFilter;
      return matchesSearch && matchesStage;
    });
  }, [allJobs, query, stageFilter]);

  const goHome = () => {
    setSelectedCompanyId(null);
    setSelectedJobId(null);
    setSidebarOpen(false);
  };

  const openCompany = (companyId: string) => {
    setSelectedCompanyId(companyId);
    setSelectedJobId(null);
    setQuery('');
    setStageFilter('全部流程');
    setSelectedMetric(null);
    setSidebarOpen(false);
  };

  const openJob = (companyId: string, jobId: string) => {
    setSelectedCompanyId(companyId);
    setSelectedJobId(jobId);
    setQuery('');
    setStageFilter('全部流程');
    setSelectedMetric(null);
    setSidebarOpen(false);
  };

  const showNotice = (message: string) => {
    setNotice({ id: Date.now(), message });
  };

  const openPrivacy = () => {
    setSidebarOpen(false);
    setPrivacyOpen(true);
  };

  const startAddCompany = (continueToJob = false, draftToResume: Job | null = null) => {
    const draft = emptyCompany();
    setAddOpportunityOpen(false);
    setSidebarOpen(false);
    setJobDraft(null);
    setEditingCompanyId(null);
    setContinueToJobAfterCompany(continueToJob);
    setPendingJobDraftAfterCompany(draftToResume);
    setPendingJobCompanyIdAfterCompany(draftToResume ? jobCompanyId : null);
    setInitialCompanyDraftSignature(JSON.stringify(draft));
    setCompanyDraft(draft);
  };

  const closeCompanyEditor = () => {
    setCompanyDraft(null);
    setEditingCompanyId(null);
    if (continueToJobAfterCompany && pendingJobDraftAfterCompany) {
      setJobEntryContext('dashboard');
      setJobCompanyId(pendingJobCompanyIdAfterCompany);
      setJobDraft(pendingJobDraftAfterCompany);
    }
    setContinueToJobAfterCompany(false);
    setPendingJobDraftAfterCompany(null);
    setPendingJobCompanyIdAfterCompany(null);
    setInitialCompanyDraftSignature('');
  };

  const startEditCompany = (company: Company) => {
    setContinueToJobAfterCompany(false);
    setPendingJobDraftAfterCompany(null);
    setPendingJobCompanyIdAfterCompany(null);
    setEditingCompanyId(company.id);
    const draft = { ...company, jobs: [...company.jobs] };
    setInitialCompanyDraftSignature(JSON.stringify(draft));
    setCompanyDraft(draft);
  };

  const saveCompany = (event: FormEvent) => {
    event.preventDefault();
    if (!companyDraft?.name.trim() || !companyDraft.website.trim()) return;

    if (editingCompanyId) {
      setCompanies((current) =>
        current.map((company) =>
          company.id === editingCompanyId
            ? {
                ...company,
                name: companyDraft.name.trim(),
                shortName: companyDraft.shortName.trim() || companyDraft.name.slice(0, 2),
                website: companyDraft.website.trim(),
                color: companyDraft.color,
                note: companyDraft.note.trim(),
              }
            : company,
        ),
      );
      showNotice('公司信息已更新。');
    } else {
      const newCompany: Company = {
        ...companyDraft,
        id: makeId('company'),
        name: companyDraft.name.trim(),
        shortName: companyDraft.shortName.trim() || companyDraft.name.slice(0, 2),
        website: companyDraft.website.trim(),
        note: companyDraft.note.trim(),
        jobs: [],
      };
      setCompanies((current) => [...current, newCompany]);
      setSelectedCompanyId(newCompany.id);
      setSelectedJobId(null);
      if (continueToJobAfterCompany) {
        const resumedDraft = pendingJobDraftAfterCompany ?? emptyJob();
        setJobEntryContext('company');
        setJobCompanyId(newCompany.id);
        setEditingJobId(null);
        setJobDateError('');
        setInitialJobDraftSignature(JSON.stringify(emptyJob()));
        setJobDraft(resumedDraft);
      } else {
        showNotice(`已添加公司“${newCompany.name}”。`);
      }
    }
    setCompanyDraft(null);
    setEditingCompanyId(null);
    setContinueToJobAfterCompany(false);
    setPendingJobDraftAfterCompany(null);
    setPendingJobCompanyIdAfterCompany(null);
    setInitialCompanyDraftSignature('');
  };

  const deleteCompany = (company: Company) => {
    setPendingConfirmation({ kind: 'delete-company', companyId: company.id });
  };

  const startAddJob = (companyId?: string, context: JobEntryContext = 'dashboard') => {
    if (context === 'dashboard' && !companies.length) {
      startAddCompany(true);
      return;
    }
    if (context === 'company' && !companyId) return;
    setAddOpportunityOpen(false);
    setJobEntryContext(context);
    setJobCompanyId(context === 'company' ? companyId ?? null : null);
    setEditingJobId(null);
    setJobDateError('');
    setJobDraftError('');
    const draft = emptyJob();
    setInitialJobDraftSignature(JSON.stringify(draft));
    setJobDraft(draft);
  };

  const startEditJob = (companyId: string, job: Job) => {
    setJobEntryContext('edit');
    setJobCompanyId(companyId);
    setEditingJobId(job.id);
    setJobDateError('');
    setJobDraftError('');
    const draft = { ...job, process: [...job.process] };
    setInitialJobDraftSignature(JSON.stringify(draft));
    setJobDraft(draft);
  };

  const closeJobEditor = () => {
    setJobDraft(null);
    setEditingJobId(null);
    setJobCompanyId(null);
    setJobDateError('');
    setJobDraftError('');
    setJobEntryContext('dashboard');
    setInitialJobDraftSignature('');
  };

  const requestCloseCompanyEditor = () => {
    if (companyDraft && JSON.stringify(companyDraft) !== initialCompanyDraftSignature) {
      setDiscardTarget('company');
      return;
    }
    closeCompanyEditor();
  };

  const requestCloseJobEditor = () => {
    const companySelectionChanged = jobEntryContext === 'dashboard' && Boolean(jobCompanyId);
    if (jobDraft && (JSON.stringify(jobDraft) !== initialJobDraftSignature || companySelectionChanged)) {
      setDiscardTarget('job');
      return;
    }
    closeJobEditor();
  };

  const saveJob = (event: FormEvent) => {
    event.preventDefault();
    if (!jobDraft?.title.trim() || !jobCompanyId) return;
    const dateError = validateDateString(jobDraft.appliedAt);
    if (dateError) {
      setJobDateError(dateError);
      window.requestAnimationFrame(() => document.querySelector<HTMLElement>('input[aria-describedby="job-date-error"]')?.focus());
      return;
    }

    const targetCompany = companies.find((company) => company.id === jobCompanyId);
    const duplicate = targetCompany?.jobs.find((job) =>
      job.id !== editingJobId
      && jobIdentityKey(job.title, job.location) === jobIdentityKey(jobDraft.title, jobDraft.location),
    );
    if (duplicate) {
      setJobDraftError(`“${duplicate.title}”在当前公司和地点下已经存在，请核对岗位名称或地点。`);
      window.requestAnimationFrame(() => document.querySelector<HTMLElement>('.job-title-input')?.focus());
      return;
    }

    const savedJobId = editingJobId ?? makeId('job');
    const targetCompanyName = companies.find((company) => company.id === jobCompanyId)?.name ?? '当前公司';
    setCompanies((current) =>
      current.map((company) => {
        if (company.id !== jobCompanyId) return company;
        if (editingJobId) {
          return {
            ...company,
            jobs: company.jobs.map((job) =>
              job.id === editingJobId ? { ...jobDraft, id: editingJobId } : job,
            ),
          };
        }
        return {
          ...company,
          jobs: [...company.jobs, { ...jobDraft, id: savedJobId }],
        };
      }),
    );

    setSelectedCompanyId(jobCompanyId);
    setSelectedJobId(savedJobId);
    setJobDraft(null);
    setEditingJobId(null);
    setJobCompanyId(null);
    setJobDateError('');
    setJobDraftError('');
    setInitialJobDraftSignature('');
    showNotice(editingJobId ? '岗位信息已更新。' : `已向“${targetCompanyName}”添加岗位。`);
  };

  const startBatchAdd = (companyId: string) => {
    const rows = [emptyBatchRow(), emptyBatchRow()];
    const defaults = emptyBatchDefaults();
    setBatchCompanyId(companyId);
    setBatchRows(rows);
    setBatchDefaults(defaults);
    setBatchError('');
    setBatchRowErrors({});
    setInitialBatchDraftSignature(JSON.stringify({ rows, defaults }));
  };

  const closeBatchAdd = () => {
    setBatchCompanyId(null);
    setBatchRows([]);
    setBatchDefaults(emptyBatchDefaults());
    setBatchError('');
    setBatchRowErrors({});
    setInitialBatchDraftSignature('');
  };

  const requestCloseBatchAdd = () => {
    const currentSignature = JSON.stringify({ rows: batchRows, defaults: batchDefaults });
    if (currentSignature !== initialBatchDraftSignature) {
      setDiscardTarget('batch');
      return;
    }
    closeBatchAdd();
  };

  const discardAndClose = () => {
    const target = discardTarget;
    setDiscardTarget(null);
    if (target === 'company') closeCompanyEditor();
    if (target === 'job') closeJobEditor();
    if (target === 'batch') closeBatchAdd();
  };

  const addBatchRow = () => {
    if (batchRows.length >= 20) {
      setBatchError('一次最多添加 20 个岗位。请先保存这一批。');
      return;
    }
    const row = emptyBatchRow();
    setBatchRows((current) => [...current, row]);
    setBatchError('');
    setBatchRowErrors({});
    window.requestAnimationFrame(() => {
      document.getElementById(`batch-title-${row.id}`)?.focus();
    });
  };

  const updateBatchRow = (rowId: string, patch: Partial<BatchJobRow>) => {
    setBatchRows((current) => current.map((row) => row.id === rowId ? { ...row, ...patch } : row));
    setBatchError('');
    setBatchRowErrors({});
  };

  const removeBatchRow = (rowId: string) => {
    const rowIndex = batchRows.findIndex((row) => row.id === rowId);
    const focusTarget = batchRows[rowIndex + 1] ?? batchRows[rowIndex - 1] ?? null;
    setBatchRows((current) => current.filter((row) => row.id !== rowId));
    setBatchError('');
    setBatchRowErrors((current) => {
      const next = { ...current };
      delete next[rowId];
      return next;
    });
    window.requestAnimationFrame(() => {
      if (focusTarget) {
        document.getElementById(`batch-title-${focusTarget.id}`)?.focus();
      } else {
        document.querySelector<HTMLElement>('.batch-add-row')?.focus();
      }
    });
  };

  const saveBatchJobs = (event: FormEvent) => {
    event.preventDefault();
    if (!batchCompanyId) return;
    setBatchRowErrors({});
    const meaningfulRows = batchRows.filter((row) => row.title.trim() || row.location.trim() || row.portalUrl.trim());
    if (!meaningfulRows.length) {
      setBatchError('请至少填写一个岗位名称。');
      window.requestAnimationFrame(() => document.getElementById(`batch-title-${batchRows[0]?.id}`)?.focus());
      return;
    }
    const incompleteRows = meaningfulRows.filter((row) => !row.title.trim());
    if (incompleteRows.length) {
      setBatchRowErrors(Object.fromEntries(incompleteRows.map((row) => [row.id, '请填写这个岗位的名称。'])));
      setBatchError('请先补全标记的岗位名称。');
      window.requestAnimationFrame(() => document.getElementById(`batch-title-${incompleteRows[0].id}`)?.focus());
      return;
    }
    const normalizedKeys = meaningfulRows.map((row) => jobIdentityKey(row.title, row.location));
    const duplicateKeys = new Set(normalizedKeys.filter((key, index) => normalizedKeys.indexOf(key) !== index));
    if (duplicateKeys.size) {
      const duplicateRows = meaningfulRows.filter((_, index) => duplicateKeys.has(normalizedKeys[index]));
      setBatchRowErrors(Object.fromEntries(duplicateRows.map((row) => [row.id, '与本批次另一行的岗位名称和地点重复。'])));
      setBatchError('这一批中有重复岗位，请修改标记的行后再保存。');
      window.requestAnimationFrame(() => document.getElementById(`batch-title-${duplicateRows[0].id}`)?.focus());
      return;
    }
    const dateError = validateDateString(batchDefaults.appliedAt);
    if (dateError) {
      setBatchError(dateError);
      window.requestAnimationFrame(() => document.querySelector<HTMLElement>('input[aria-describedby="batch-date-error"]')?.focus());
      return;
    }
    const targetCompany = companies.find((company) => company.id === batchCompanyId);
    if (!targetCompany) {
      setBatchError('没有找到当前公司，请关闭后重试。');
      return;
    }
    const existingJobKeys = new Set(targetCompany.jobs.map((job) => jobIdentityKey(job.title, job.location)));
    const repeatedExistingJob = meaningfulRows.find((row) => existingJobKeys.has(
      jobIdentityKey(row.title, row.location),
    ));
    if (repeatedExistingJob) {
      setBatchRowErrors({ [repeatedExistingJob.id]: '当前公司已有相同名称和地点的岗位。' });
      setBatchError(`“${repeatedExistingJob.title.trim()}”已存在于当前公司，请确认地点或修改名称。`);
      window.requestAnimationFrame(() => document.getElementById(`batch-title-${repeatedExistingJob.id}`)?.focus());
      return;
    }
    const newJobs: Job[] = meaningfulRows.map((row) => ({
      ...emptyJob(),
      id: makeId('job'),
      title: row.title.trim(),
      location: row.location.trim(),
      portalUrl: row.portalUrl.trim(),
      jobType: batchDefaults.jobType.trim(),
      appliedAt: batchDefaults.appliedAt,
      stage: batchDefaults.stage,
      priority: batchDefaults.priority,
    }));
    setCompanies((current) => current.map((company) =>
      company.id === batchCompanyId ? { ...company, jobs: [...company.jobs, ...newJobs] } : company,
    ));
    setSelectedCompanyId(batchCompanyId);
    setSelectedJobId(null);
    closeBatchAdd();
    showNotice(`已向“${targetCompany.name}”添加 ${newJobs.length} 个岗位。`);
  };

  const deleteJob = (companyId: string, job: Job) => {
    setPendingConfirmation({ kind: 'delete-job', companyId, jobId: job.id });
  };

  const startAddEvent = () => {
    if (!selectedJob) return;
    const draft = emptyEvent();
    draft.stage = selectedJob.stage === '意向岗位' ? '已投递' : selectedJob.stage;
    setEditingEventId(null);
    setEventDraft(draft);
  };

  const startEditEvent = (item: ProcessEvent) => {
    setEditingEventId(item.id);
    setEventDraft({ ...item });
  };

  const saveEvent = (event: FormEvent) => {
    event.preventDefault();
    if (!eventDraft?.title.trim() || !selectedCompany || !selectedJob) return;
    const targetEvent: ProcessEvent = {
      ...eventDraft,
      id: editingEventId ?? makeId('event'),
      title: eventDraft.title.trim(),
      note: eventDraft.note.trim(),
    };
    setCompanies((current) =>
      current.map((company) =>
        company.id === selectedCompany.id
          ? {
              ...company,
              jobs: company.jobs.map((job) =>
                job.id === selectedJob.id
                  ? {
                      ...job,
                      stage: editingEventId ? job.stage : targetEvent.stage,
                      process: editingEventId
                        ? job.process.map((item) =>
                            item.id === editingEventId ? targetEvent : item,
                          )
                        : [...job.process, targetEvent],
                    }
                  : job,
              ),
            }
          : company,
      ),
    );
    setEventDraft(null);
    setEditingEventId(null);
  };

  const deleteEvent = (eventId: string) => {
    if (!selectedCompany || !selectedJob) return;
    setPendingConfirmation({
      kind: 'delete-event',
      companyId: selectedCompany.id,
      jobId: selectedJob.id,
      eventId,
    });
  };

  const exportBackup = () => {
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), companies }, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `求职进程备份-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const applyImportedCompanies = (importedCompanies: Company[]) => {
    setCompanies(importedCompanies);
    setSelectedCompanyId(null);
    setSelectedJobId(null);
    setQuery('');
    setStageFilter('全部流程');
  };

  const importExampleCompanies = () => {
    applyImportedCompanies(cloneExampleCompanies());
  };

  const signOutAndClearDevice = async () => {
    clearCurrentAccountFromDevice('signed-out');
    if (authProvider === 'github') {
      try {
        await fetch('/api/auth/github/signout', { method: 'POST' });
      } finally {
        window.location.replace('/');
      }
      return;
    }
    window.location.replace('/signout-with-chatgpt?return_to=/');
  };

  const disconnectThisDeviceAndRestart = async () => {
    if (authDisconnecting) return;
    setAuthDisconnecting(true);
    setAuthDisconnectError('');
    cloudSyncEnabled.current = false;
    saveSequence.current += 1;
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    saveAbortControllerRef.current?.abort();
    saveAbortControllerRef.current = null;

    try {
      const keysToRemove: string[] = [];
      for (let index = 0; index < window.localStorage.length; index += 1) {
        const key = window.localStorage.key(index);
        if (key && (key === LEGACY_STORAGE_KEY || isUserStorageKey(key))) keysToRemove.push(key);
      }
      for (const key of keysToRemove) window.localStorage.removeItem(key);
    } catch {
      // The remote sessions can still be disconnected when browser storage is unavailable.
    }

    const disconnectController = new AbortController();
    const disconnectTimeout = window.setTimeout(() => disconnectController.abort(), AUTH_DISCONNECT_TIMEOUT_MS);
    try {
      const response = await fetch('/api/auth/github/signout', {
        method: 'POST',
        credentials: 'same-origin',
        signal: disconnectController.signal,
      });
      if (response.headers.get(DEVICE_SESSION_CLEARED_HEADER) !== '1') {
        throw new Error('device_session_not_cleared');
      }
    } catch {
      setAuthDisconnecting(false);
      setAuthDisconnectError('本机缓存已清除，但当前连接未能安全切断登录。请检查网络后再试一次。');
      return;
    } finally {
      window.clearTimeout(disconnectTimeout);
    }

    window.location.replace('/signout-with-chatgpt?return_to=/');
  };

  const deletePersonalData = async () => {
    const expectedUserId = activeUserIdRef.current;
    if (!expectedUserId) {
      replaceAfterAccountContextChange('signed-out');
      return;
    }
    setDeletingData(true);
    setDeleteNeedsRefresh(false);
    setAccountActionError('');
    cloudSyncEnabled.current = false;
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    let deleteOutcomeUncertain = false;

    try {
      let saveDrainTimeout: number | null = null;
      try {
        await Promise.race([
          saveQueueRef.current,
          new Promise<void>((_, reject) => {
            saveDrainTimeout = window.setTimeout(() => reject(new Error('等待云端保存完成超时，尚未发起清空。')), 20_000);
          }),
        ]);
      } finally {
        if (saveDrainTimeout !== null) window.clearTimeout(saveDrainTimeout);
      }

      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 15_000);
      let response: Response;
      try {
        response = await fetch('/api/state', {
          method: 'DELETE',
          headers: {
            'x-state-base-version': cloudVersionRef.current,
            'x-expected-user-id': expectedUserId,
          },
          signal: controller.signal,
        });
      } catch (error) {
        deleteOutcomeUncertain = true;
        if (error instanceof DOMException && error.name === 'AbortError') {
          throw new Error('清空请求超时，暂时无法确认最终状态。');
        }
        throw error;
      } finally {
        window.clearTimeout(timeout);
      }
      if (response.status === 401) {
        replaceAfterAccountContextChange('signed-out');
        return;
      }
      if (response.status === 403) {
        replaceAfterAccountContextChange('access-denied');
        return;
      }
      if (response.status === 409) {
        const conflict = await response.json().catch(() => null) as { error?: string } | null;
        if (conflict?.error === 'account_context_changed') {
          replaceAfterAccountContextChange('loading');
          return;
        }
        throw new Error('数据已在另一个页面发生变化，本次清空没有执行。');
      }
      if (response.status >= 500) deleteOutcomeUncertain = true;
      if (!response.ok) throw new Error('暂时无法清空求职内容，请稍后重试。');
      const deleted = (await response.json()) as { version?: string };
      if (!deleted.version) {
        deleteOutcomeUncertain = true;
        throw new Error('清空完成状态无法确认。');
      }
      cloudVersionRef.current = deleted.version;

      try {
        if (activeStorageKeyRef.current) window.localStorage.removeItem(activeStorageKeyRef.current);
        window.localStorage.removeItem(LEGACY_STORAGE_KEY);
      } catch {
        // Cloud deletion remains successful even if local storage is unavailable.
      }
      skipNextCloudSave.current = true;
      skipNextLocalCacheWrite.current = true;
      setCompanies([]);
      setSelectedCompanyId(null);
      setSelectedJobId(null);
      setSelectedMetric(null);
      setQuery('');
      setStageFilter('全部流程');
      setDeleteDataOpen(false);
      setDeleteConfirmationStep(1);
      setDeleteNeedsRefresh(false);
      setSyncStatus('synced');
      cloudSyncEnabled.current = true;
    } catch (error) {
      if (deleteOutcomeUncertain) {
        try {
          if (activeStorageKeyRef.current) window.localStorage.removeItem(activeStorageKeyRef.current);
          window.localStorage.removeItem(LEGACY_STORAGE_KEY);
        } catch {
          // Keeping sync disabled prevents an uncertain deletion from being undone by stale cache.
        }
      }
      cloudSyncEnabled.current = false;
      setSyncStatus('error');
      setDeleteNeedsRefresh(true);
      const detail = error instanceof Error ? error.message : '暂时无法确认清空结果。';
      setAccountActionError(deleteOutcomeUncertain
        ? `${detail} 为避免旧缓存恢复数据，请重新加载页面核对最终状态。`
        : `${detail} 请重新加载页面获取最新状态后再决定是否重试。`);
    } finally {
      setDeletingData(false);
    }
  };

  const importBackup = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    try {
      if (file.size > MAX_BACKUP_BYTES) throw new Error('Backup is too large.');
      const importedCompanies = parseBackupCompanies(await file.text());
      setPendingConfirmation({ kind: 'import-backup', companies: importedCompanies, source: 'file' });
    } catch {
      showNotice('无法读取这个备份文件，请确认它是本系统导出的 JSON 文件。');
    }
  };

  const importPastedBackup = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      const importedCompanies = parseBackupCompanies(backupText);
      setPasteImportOpen(false);
      setPendingConfirmation({ kind: 'import-backup', companies: importedCompanies, source: 'paste' });
    } catch {
      setBackupError('无法读取这段内容。请粘贴由本系统导出的完整 JSON 备份。');
    }
  };

  const confirmPendingAction = () => {
    if (!pendingConfirmation) return;

    if (pendingConfirmation.kind === 'delete-company') {
      const company = companies.find((item) => item.id === pendingConfirmation.companyId);
      setCompanies((current) => current.filter((item) => item.id !== pendingConfirmation.companyId));
      goHome();
      showNotice(company ? `已删除“${company.name}”。` : '公司已删除。');
    } else if (pendingConfirmation.kind === 'delete-job') {
      const company = companies.find((item) => item.id === pendingConfirmation.companyId);
      const job = company?.jobs.find((item) => item.id === pendingConfirmation.jobId);
      setCompanies((current) => current.map((item) =>
        item.id === pendingConfirmation.companyId
          ? { ...item, jobs: item.jobs.filter((candidate) => candidate.id !== pendingConfirmation.jobId) }
          : item,
      ));
      setSelectedJobId(null);
      showNotice(job ? `已删除岗位“${job.title}”。` : '岗位已删除。');
    } else if (pendingConfirmation.kind === 'delete-event') {
      setCompanies((current) => current.map((company) =>
        company.id === pendingConfirmation.companyId
          ? {
              ...company,
              jobs: company.jobs.map((job) =>
                job.id === pendingConfirmation.jobId
                  ? { ...job, process: job.process.filter((item) => item.id !== pendingConfirmation.eventId) }
                  : job,
              ),
            }
          : company,
      ));
      showNotice('流程记录已删除，岗位当前阶段保持不变。');
    } else {
      const jobCount = pendingConfirmation.companies.reduce((sum, company) => sum + company.jobs.length, 0);
      applyImportedCompanies(pendingConfirmation.companies);
      if (pendingConfirmation.source === 'paste') setBackupText('');
      setBackupError('');
      showNotice(`已导入 ${pendingConfirmation.companies.length} 家公司和 ${jobCount} 个岗位。`);
    }

    setPendingConfirmation(null);
  };

  const runNavigatorAction = (action: NavigatorAction) => {
    if (action.kind === 'open-job' || action.kind === 'edit-job') {
      const company = companies.find((item) => item.id === action.companyId);
      const job = company?.jobs.find((item) => item.id === action.jobId);
      if (!company || !job) {
        setNavigatorResult({ status: 'unmatched', message: '没有找到这个岗位，数据可能已在其他页面更新。' });
        return;
      }
      setNavigatorOpen(false);
      if (action.kind === 'edit-job') startEditJob(company.id, job);
      else openJob(company.id, job.id);
      return;
    }
    if (action.kind === 'open-company') {
      setNavigatorOpen(false);
      openCompany(action.companyId);
      return;
    }
    if (action.kind === 'show-metric') {
      setNavigatorOpen(false);
      goHome();
      setQuery('');
      setStageFilter('全部流程');
      setSelectedMetric(action.metric);
      return;
    }
    if (action.kind === 'filter-stage') {
      setNavigatorOpen(false);
      goHome();
      setQuery('');
      setSelectedMetric(null);
      setStageFilter(action.stage);
      return;
    }
    if (action.kind === 'set-query') {
      setNavigatorOpen(false);
      goHome();
      setSelectedMetric(null);
      setStageFilter('全部流程');
      setQuery(action.query);
      return;
    }
    if (action.kind === 'add-company') {
      setNavigatorOpen(false);
      startAddCompany();
      return;
    }
    if (action.kind === 'add-opportunity') {
      setNavigatorOpen(false);
      setAddOpportunityOpen(true);
      return;
    }
  };

  const runIntelligentAgent = async () => {
    const question = navigatorCommand.trim();
    if (!question || agentQueryLoading || agentQueryInFlightRef.current) return;
    const expectedUserId = activeUserIdRef.current;
    if (!expectedUserId) {
      replaceAfterAccountContextChange('signed-out');
      return;
    }
    if (!agentSessionIdRef.current) agentSessionIdRef.current = crypto.randomUUID();
    agentQueryInFlightRef.current = true;
    let failureMessage = AGENT_TECHNICAL_FAILURE_MESSAGE;
    setAgentQueryLoading(true);
    setAgentError('');
    setAgentAnswer('');
    setAgentCallId('');
    setAgentFeedback('idle');
    setAgentFeedbackLoading(false);
    setAgentActionProposal(null);
    setAgentActionConfirmOpen(false);
    setAgentActionError('');
    setAgentActionCompleted(null);
    setAgentActionFeedback('idle');
    setAgentProposalReview('idle');
    let timeZone = '';
    let timeZoneOffsetMinutes: number | null = null;
    try {
      timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    } catch {
      // The numeric browser offset below remains available as a safe fallback.
    }
    try {
      const offset = new Date().getTimezoneOffset();
      if (Number.isSafeInteger(offset) && offset >= -840 && offset <= 840) {
        timeZoneOffsetMinutes = offset;
      }
    } catch {
      // The server will stop relative-date requests safely if neither browser value is available.
    }
    try {
      if (!cloudSyncEnabled.current) {
        failureMessage = '当前求职数据还没有完成云端同步，为避免智能助手读到旧版本，本次没有调用模型。请先处理页面上的同步提示。';
        throw new Error('agent_state_sync_unavailable');
      }
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      saveSequence.current += 1;
      await saveQueueRef.current;
      if (activeUserIdRef.current !== expectedUserId || !cloudSyncEnabled.current) {
        failureMessage = '账号或数据同步状态已变化，本次没有调用模型。请刷新页面后重试。';
        throw new Error('agent_account_or_sync_changed');
      }
      const syncResponse = await fetch('/api/state', {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          'x-state-base-version': cloudVersionRef.current,
          'x-expected-user-id': expectedUserId,
        },
        body: JSON.stringify({ companies }),
      });
      if (syncResponse.status === 409) {
        const conflict = await syncResponse.json().catch(() => null) as { error?: string } | null;
        if (conflict?.error === 'account_context_changed') {
          replaceAfterAccountContextChange('loading');
          return;
        }
        cloudSyncEnabled.current = false;
        setSyncStatus('error');
        failureMessage = '云端数据已在另一个页面发生变化。为避免覆盖新数据，本次没有调用模型。请先刷新并核对数据。';
        throw new Error('agent_state_version_conflict');
      }
      if (!syncResponse.ok) {
        failureMessage = '求职数据未能完成同步，为避免智能助手读到旧版本，本次没有调用模型。请稍后重试。';
        throw new Error('agent_state_sync_failed');
      }
      const synced = await syncResponse.json() as { version?: string };
      if (!synced.version) throw new Error('agent_state_sync_version_missing');
      cloudVersionRef.current = synced.version;
      try {
        if (activeStorageKeyRef.current) {
          window.localStorage.setItem(activeStorageKeyRef.current, JSON.stringify({
            companies,
            dirty: false,
            savedAt: new Date().toISOString(),
            baseVersion: synced.version,
          }));
        }
      } catch {
        // The verified cloud state remains authoritative when local cache is unavailable.
      }
      setSyncStatus('synced');

      const response = await fetch('/api/agent/query', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-expected-user-id': expectedUserId,
        },
        body: JSON.stringify({
          question,
          idempotencyKey: crypto.randomUUID(),
          sessionId: agentSessionIdRef.current,
          timeZone,
          timeZoneOffsetMinutes,
          stateVersion: cloudVersionRef.current,
        }),
      });
      if (response.status === 409) {
        const conflict = await response.json().catch(() => null) as { error?: string; message?: string } | null;
        if (conflict?.error === 'account_context_changed') {
          replaceAfterAccountContextChange('loading');
          return;
        }
        failureMessage = conflict?.message || '求职数据还在同步，本次没有调用模型。请等待“云端已同步”后重试。';
        throw new Error('agent_state_out_of_sync');
      }
      const payload = await response.json().catch(() => null) as {
        ok?: boolean;
        responseType?: 'answer' | 'clarification' | 'proposal';
        answer?: string;
        message?: string;
        callId?: string;
        status?: AgentStatus;
        proposal?: AgentActionProposal;
      } | null;
      if (payload?.status) {
        setAgentStatus(payload.status);
        agentStatusFetchedAtRef.current = Date.now();
      }
      if (payload?.callId) setAgentCallId(payload.callId);
      const hasProposal = payload?.responseType === 'proposal' && Boolean(payload.proposal);
      const hasAnswer = Boolean(payload?.answer);
      if (!response.ok || !payload?.ok || (!hasAnswer && !hasProposal)) {
        if (payload?.message) failureMessage = payload.message;
        throw new Error('agent_request_failed');
      }
      setAgentAnswer(payload.answer ?? '');
      setAgentActionProposal(payload.proposal ?? null);
      setAgentCallId(payload.callId ?? '');
    } catch {
      setAgentError(failureMessage);
      setAgentMode('basic');
    } finally {
      agentQueryInFlightRef.current = false;
      setAgentQueryLoading(false);
    }
  };

  const submitAgentFeedback = async (outcome: 'resolved' | 'unresolved') => {
    const expectedUserId = activeUserIdRef.current;
    if (!expectedUserId || !agentCallId || agentFeedbackLoading || agentFeedbackInFlightRef.current) return;
    agentFeedbackInFlightRef.current = true;
    setAgentFeedbackLoading(true);
    try {
      const response = await fetch('/api/agent/feedback', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-expected-user-id': expectedUserId,
        },
        body: JSON.stringify({ callId: agentCallId, outcome }),
      });
      if (response.status === 409) {
        const payload = await response.json().catch(() => null) as { error?: string } | null;
        if (payload?.error === 'account_context_changed') {
          replaceAfterAccountContextChange('loading');
          return;
        }
      }
      if (!response.ok) throw new Error('Feedback was not saved.');
      setAgentFeedback(outcome);
      if (outcome === 'resolved') agentSessionIdRef.current = '';
    } catch {
      setAgentFeedback('error');
    } finally {
      agentFeedbackInFlightRef.current = false;
      setAgentFeedbackLoading(false);
    }
  };

  const cancelAgentAction = async (review: 'cancelled' | 'incorrect' = 'cancelled') => {
    const proposal = agentActionProposal;
    const expectedUserId = activeUserIdRef.current;
    if (!proposal || agentActionLoading) return;
    setAgentActionConfirmOpen(false);
    setAgentActionProposal(null);
    setAgentActionError('');
    setAgentProposalReview('idle');
    if (!expectedUserId) return;
    try {
      const cancelResponse = await fetch(`/api/agent/action/${encodeURIComponent(proposal.id)}/cancel`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-expected-user-id': expectedUserId,
        },
        body: JSON.stringify({ confirmationNonce: proposal.confirmationNonce }),
      });
      if (!cancelResponse.ok) throw new Error('proposal_cancel_failed');
      const cancelPayload = await cancelResponse.json().catch(() => null) as { message?: string } | null;
      setAgentAnswer(cancelPayload?.message || '这次操作已取消，没有修改求职数据。');
      if (review === 'incorrect') {
        const feedbackResponse = await fetch(`/api/agent/action/${encodeURIComponent(proposal.id)}/feedback`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-expected-user-id': expectedUserId,
          },
          body: JSON.stringify({ outcome: 'incorrect' }),
        });
        if (!feedbackResponse.ok) throw new Error('proposal_feedback_failed');
      }
      setAgentProposalReview(review);
    } catch {
      setAgentProposalReview('error');
    }
  };

  const confirmAgentAction = async () => {
    const proposal = agentActionProposal;
    const expectedUserId = activeUserIdRef.current;
    if (!proposal || !expectedUserId || agentActionLoading) return;
    setAgentActionLoading(true);
    setAgentActionError('');
    try {
      const response = await fetch(`/api/agent/action/${encodeURIComponent(proposal.id)}/confirm`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-expected-user-id': expectedUserId,
        },
        body: JSON.stringify({
          confirmationNonce: proposal.confirmationNonce,
          requestId: crypto.randomUUID(),
        }),
      });
      if (response.status === 409) {
        const conflict = await response.json().catch(() => null) as { error?: string; message?: string } | null;
        if (conflict?.error === 'account_context_changed') {
          replaceAfterAccountContextChange('loading');
          return;
        }
        throw new Error(conflict?.message || '数据已在另一页更新，本次未执行。请关闭后重新发起操作。');
      }
      const payload = await response.json().catch(() => null) as {
        ok?: boolean;
        message?: string;
        version?: string;
        state?: { companies?: unknown };
        action?: AgentActionCompleted;
      } | null;
      const nextCompanies = parseCompaniesValue(payload?.state?.companies);
      if (!response.ok || !payload?.ok || !payload.version || !nextCompanies) {
        throw new Error(payload?.message || '这次操作没有完成，你的求职数据没有被改动。');
      }

      skipNextCloudSave.current = true;
      cloudVersionRef.current = payload.version;
      setCompanies(nextCompanies);
      setSyncStatus('synced');
      setSelectedCompanyId((current) => (
        current && nextCompanies.some((company) => company.id === current) ? current : null
      ));
      setSelectedJobId((current) => (
        current && nextCompanies.some((company) => company.jobs.some((job) => job.id === current)) ? current : null
      ));
      setAgentActionCompleted(payload.action ?? {
        id: proposal.id,
        actionKind: proposal.actionKind,
        title: proposal.title,
        summary: proposal.summary,
      });
      setAgentActionProposal(null);
      setAgentActionConfirmOpen(false);
      setAgentActionFeedback('idle');
      setAgentAnswer(payload.message || '操作已确认并保存。');
      showNotice(payload.message || '操作已确认完成。');
    } catch (error) {
      setAgentActionError(error instanceof Error ? error.message : '这次操作没有完成，你的求职数据没有被改动。');
    } finally {
      setAgentActionLoading(false);
    }
  };

  const submitAgentActionFeedback = async (outcome: 'correct' | 'incorrect') => {
    const action = agentActionCompleted;
    const expectedUserId = activeUserIdRef.current;
    if (!action || !expectedUserId || agentActionFeedbackLoading) return;
    setAgentActionFeedbackLoading(true);
    try {
      const response = await fetch(`/api/agent/action/${encodeURIComponent(action.id)}/feedback`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-expected-user-id': expectedUserId,
        },
        body: JSON.stringify({ outcome }),
      });
      if (!response.ok) throw new Error('feedback_not_saved');
      setAgentActionFeedback(outcome);
    } catch {
      setAgentActionFeedback('error');
    } finally {
      setAgentActionFeedbackLoading(false);
    }
  };

  const submitNavigatorCommand = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (agentMode === 'intelligent') {
      void runIntelligentAgent();
      return;
    }
    const result = parseNavigatorCommand(navigatorCommand, companies);
    setNavigatorResult(result);
    if (result.status === 'matched' && result.action && result.action.kind !== 'show-insights') {
      runNavigatorAction(result.action);
    }
  };

  const updateAgentAdmin = async (payload: AgentAdminUpdate) => {
    const expectedUserId = activeUserIdRef.current;
    const currentDashboard = agentAdminDashboardRef.current;
    if (!expectedUserId || !currentDashboard) return;
    if (agentAdminUpdateInFlightRef.current) {
      showNotice('上一项设置正在保存，请稍候。');
      return;
    }
    const pendingKey = agentAdminUpdateKey(payload);
    agentAdminUpdateInFlightRef.current = true;
    setAgentAdminPendingKey(pendingKey);
    setAgentAdminError('');
    const optimisticDashboard = applyOptimisticAgentAdminUpdate(currentDashboard, payload);
    agentAdminDashboardRef.current = optimisticDashboard;
    setAgentAdminDashboard(optimisticDashboard);
    if (payload.kind === 'global') {
      setAgentStatus((current) => current ? {
        ...current,
        enabled: payload.enabled,
        intelligentAvailable: payload.enabled
          && !current.disabled
          && (current.isAdmin || (current.remaining ?? 0) > 0),
      } : current);
      agentStatusFetchedAtRef.current = Date.now();
    }
    try {
      const response = await fetch('/api/admin/agent', {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          'x-expected-user-id': expectedUserId,
        },
        body: JSON.stringify(payload),
      });
      if (response.status === 409) {
        replaceAfterAccountContextChange('loading');
        return;
      }
      if (!response.ok) throw new Error('Admin update failed.');
      if (payload.kind === 'default_limit') showNotice('全体普通用户的默认额度已保存并开始同步。');
      if (payload.kind === 'user_limit') showNotice('该账号的独立额度已保存并开始同步。');
      if (payload.kind === 'user') showNotice('该账号的智能助手权限已更新。');
      if (payload.kind === 'global') showNotice(payload.enabled ? '智能调用已开启。' : '智能调用已紧急关闭。');
      agentAdminFetchedAtRef.current = Date.now();
    } catch {
      agentAdminDashboardRef.current = currentDashboard;
      setAgentAdminDashboard(currentDashboard);
      if (payload.kind === 'global') {
        agentStatusFetchedAtRef.current = 0;
        void refreshAgentStatus(true);
      }
      setAgentAdminError('设置没有保存成功，请稍后重试。');
    } finally {
      agentAdminUpdateInFlightRef.current = false;
      setAgentAdminPendingKey('');
    }
  };

  const renderDashboard = () => {
    const isFiltering = Boolean(query.trim()) || stageFilter !== '全部流程';
    const upcoming = [...activeJobs]
      .filter((job) => job.nextDate)
      .sort((a, b) => a.nextDate.localeCompare(b.nextDate))
      .slice(0, 4);
    const metrics: Array<{
      id: SummaryMetric;
      label: string;
      description: string;
      jobs: FlatJob[];
      emptyText: string;
    }> = [
      {
        id: 'active',
        label: '进行中的岗位',
        description: `${companies.length} 家目标公司`,
        jobs: activeJobs,
        emptyText: '目前没有正在推进的岗位。',
      },
      {
        id: 'interview',
        label: '面试阶段',
        description: '一面及后续面试',
        jobs: interviewJobs,
        emptyText: '目前还没有进入面试阶段的岗位。',
      },
      {
        id: 'offer',
        label: '收到 Offer',
        description: '继续保持节奏',
        jobs: offers,
        emptyText: '目前还没有记录 Offer。',
      },
      {
        id: 'all',
        label: '全部岗位',
        description: '含被拒与已结束流程',
        jobs: allJobs,
        emptyText: '目前还没有添加岗位。',
      },
    ];
    const metricDetail = metrics.find((metric) => metric.id === selectedMetric) ?? null;

    const toggleMetric = (metricId: SummaryMetric) => {
      setSelectedMetric((current) => (current === metricId ? null : metricId));
      setQuery('');
      setStageFilter('全部流程');
    };

    return (
      <>
        <section className="hero-row">
          <div>
            <p className="eyebrow">职业机会工作台</p>
            <h1 ref={viewHeadingRef} className="view-title" tabIndex={-1}>让每一次投递，都有下一步。</h1>
            <p className="hero-copy">把分散的机会、时间与判断，整理成一条可行动的职业路径。</p>
          </div>
          <button className="primary-button hero-action" onClick={() => setAddOpportunityOpen(true)}>
            添加机会
          </button>
        </section>

        <section className="navigator-overview" aria-labelledby="navigator-overview-title">
          <div className="navigator-overview-mark" aria-hidden="true"><NavigatorMark /></div>
          <div className="navigator-overview-copy">
            <p className="eyebrow">{NAVIGATOR_NAME} · 今日简报</p>
            <h2 id="navigator-overview-title">{navigatorBriefing.healthLabel}</h2>
            <p>{navigatorBriefing.summary}</p>
          </div>
          <div className="navigator-overview-stats" aria-label="建议概况">
            <span><strong>{navigatorBriefing.urgentCount}</strong>需优先</span>
            <span><strong>{navigatorBriefing.attentionCount}</strong>待完善</span>
          </div>
          <button className="secondary-button navigator-overview-action" onClick={openNavigatorPanel}>
            查看建议
          </button>
        </section>

        <section className="metric-grid" aria-label="求职进展概况">
          {metrics.map((metric) => {
            const expanded = selectedMetric === metric.id;
            return (
              <button
                key={metric.id}
                type="button"
                className={`metric-card metric-button ${metric.id === 'active' ? 'metric-accent' : ''} ${expanded ? 'metric-selected' : ''}`}
                aria-expanded={expanded}
                aria-controls="metric-job-list"
                onClick={() => toggleMetric(metric.id)}
              >
                <span className="metric-label">{metric.label}</span>
                <span className="metric-open-hint">{expanded ? '收起' : '查看'}</span>
                <strong>{metric.jobs.length}</strong>
                <small>{metric.description}</small>
              </button>
            );
          })}
        </section>

        {metricDetail && (
          <section className="panel metric-detail-panel" id="metric-job-list" aria-live="polite">
            <div className="section-heading">
              <div>
                <p className="eyebrow">岗位明细</p>
                <h2 ref={metricDetailHeadingRef} tabIndex={-1}>{metricDetail.label} · {metricDetail.jobs.length}</h2>
              </div>
              <button className="text-button metric-close" onClick={() => setSelectedMetric(null)}>收起</button>
            </div>
            {metricDetail.jobs.length ? (
              <div className="metric-detail-list">
                {metricDetail.jobs.map((job) => (
                  <button
                    className="metric-job-row"
                    key={`${job.companyId}-${job.id}`}
                    onClick={() => openJob(job.companyId, job.id)}
                  >
                    <span className="company-dot" style={{ background: job.companyColor }} />
                    <span className="metric-job-copy">
                      <strong>{job.title}</strong>
                      <small>{job.companyName} · {job.location || '地点未填写'}</small>
                    </span>
                    <span className={`stage-pill stage-${STAGES.indexOf(job.stage)}`}>{job.stage}</span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="metric-empty">{metricDetail.emptyText}</p>
            )}
          </section>
        )}

        {isFiltering ? (
          <section className="panel search-results-panel">
            <div className="section-heading">
              <div>
                <p className="eyebrow">筛选结果</p>
                <h2>{filteredJobs.length} 个岗位</h2>
              </div>
              <button
                className="text-button"
                onClick={() => {
                  setQuery('');
                  setStageFilter('全部流程');
                }}
              >
                清除筛选
              </button>
            </div>
            {filteredJobs.length ? (
              <div className="result-list">
                {filteredJobs.map((job) => (
                  <button
                    className="result-row"
                    key={`${job.companyId}-${job.id}`}
                    onClick={() => openJob(job.companyId, job.id)}
                  >
                    <span className="company-dot" style={{ background: job.companyColor }} />
                    <span className="result-main">
                      <strong>{job.title}</strong>
                      <small>{job.companyName} · {job.location || '地点未填写'}</small>
                    </span>
                    <span className={`stage-pill stage-${STAGES.indexOf(job.stage)}`}>{job.stage}</span>
                  </button>
                ))}
              </div>
            ) : (
              <EmptyState title="没有匹配的岗位" text="换一个关键词或流程阶段试试。" />
            )}
          </section>
        ) : (
          <div className="dashboard-grid">
            <section className="panel pipeline-panel">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">招聘漏斗</p>
                  <h2>当前流程分布</h2>
                </div>
                <span className="soft-label">实时保存</span>
              </div>
              <div className="pipeline-list">
                {STAGES.filter((stage) => stage !== '已结束').map((stage) => {
                  const count = allJobs.filter((job) => job.stage === stage).length;
                  const percentage = count && allJobs.length ? (count / allJobs.length) * 100 : 0;
                  return (
                    <button
                      className="pipeline-row"
                      key={stage}
                      aria-label={`${stage}：${count} 个岗位`}
                      onClick={() => {
                        setSelectedMetric(null);
                        setStageFilter(stage);
                      }}
                    >
                      <span>{stage}</span>
                      <div className="pipeline-track">
                        <i style={{ width: `${percentage}%` }} />
                      </div>
                      <strong>{count}</strong>
                    </button>
                  );
                })}
              </div>
            </section>

            <section className="panel next-panel">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">下一步</p>
                  <h2>近期安排</h2>
                </div>
              </div>
              {upcoming.length ? (
                <div className="upcoming-list">
                  {upcoming.map((job) => (
                    <button
                      key={`${job.companyId}-${job.id}`}
                      className="upcoming-item"
                      onClick={() => openJob(job.companyId, job.id)}
                    >
                      <span className="date-box">
                        <strong>{new Date(`${job.nextDate}T00:00:00`).getDate()}</strong>
                        <small>{new Date(`${job.nextDate}T00:00:00`).getMonth() + 1} 月</small>
                      </span>
                      <span>
                        <strong>{job.nextAction || '跟进岗位进度'}</strong>
                        <small>{job.companyName} · {job.title}</small>
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <EmptyState
                  compact
                  title="还没有近期安排"
                  text="在岗位详情中填写“下一步”和日期，这里就会自动汇总。"
                />
              )}
            </section>
          </div>
        )}

        {!isFiltering && (
          <section className="company-section">
            <div className="section-heading company-heading">
              <div>
                <p className="eyebrow">公司库</p>
                <h2>目标公司</h2>
              </div>
              <button className="secondary-button" onClick={() => startAddCompany()}>添加公司</button>
            </div>
            {companies.length ? (
              <div className="company-grid">
                {companies.map((company) => (
                  <article className="company-card" key={company.id}>
                    <button className="company-card-main" onClick={() => openCompany(company.id)}>
                      <span className="company-mark" style={{ background: company.color }}>
                        {company.shortName.slice(0, 3)}
                      </span>
                      <span className="company-card-copy">
                        <strong>{company.name}</strong>
                        <small>{company.jobs.length} 个岗位</small>
                      </span>
                    </button>
                    <a className="portal-link" href={company.website} target="_blank" rel="noreferrer">
                      打开招聘官网
                    </a>
                  </article>
                ))}
              </div>
            ) : (
              <div className="panel company-empty">
                <EmptyState
                  title="建立你的第一份机会清单"
                  text="从空白开始添加自己的公司，或先导入示例公司了解使用方式。"
                  action={(
                    <div className="empty-actions">
                      <button className="primary-button" onClick={() => startAddCompany()}>添加第一家公司</button>
                      <button className="secondary-button" onClick={importExampleCompanies}>导入示例公司</button>
                    </div>
                  )}
                />
              </div>
            )}
          </section>
        )}
      </>
    );
  };

  const renderCompany = (company: Company) => (
    <>
      <nav className="breadcrumb" aria-label="面包屑">
        <button onClick={goHome}>概览</button><span>/</span><strong>{company.name}</strong>
      </nav>
      <section className="company-hero" style={{ '--company-color': company.color } as React.CSSProperties}>
        <div className="company-hero-main">
          <span className="company-mark company-mark-large" style={{ background: company.color }}>
            {company.shortName.slice(0, 3)}
          </span>
          <div>
            <p className="eyebrow">公司详情</p>
            <h1 ref={viewHeadingRef} className="view-title" tabIndex={-1}>{company.name}</h1>
            <p>{company.note || '管理该公司下的所有岗位，并随时进入官方招聘平台查看状态。'}</p>
          </div>
        </div>
        <div className="company-actions">
          <a className="primary-button" href={company.website} target="_blank" rel="noreferrer">打开招聘官网</a>
          <button className="secondary-button" onClick={() => startEditCompany(company)}>编辑公司</button>
          <button className="icon-danger" aria-label="删除公司" title="删除公司" onClick={() => deleteCompany(company)}>删除</button>
        </div>
      </section>

      <section className="company-summary-row">
        <div><span>岗位总数</span><strong>{company.jobs.length}</strong></div>
        <div><span>进行中</span><strong>{company.jobs.filter((job) => !isInactive(job.stage)).length}</strong></div>
        <div><span>面试中</span><strong>{company.jobs.filter((job) => job.stage.includes('面')).length}</strong></div>
        <div><span>Offer</span><strong>{company.jobs.filter((job) => job.stage === 'Offer').length}</strong></div>
      </section>

      <section className="jobs-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">岗位列表</p>
            <h2>{company.jobs.length ? '逐个查看招聘进展' : '还没有添加岗位'}</h2>
          </div>
          <div className="jobs-section-actions">
            <button className="primary-button" onClick={() => startAddJob(company.id, 'company')}>添加岗位</button>
            <button className="secondary-button" onClick={() => startBatchAdd(company.id)}>批量添加</button>
          </div>
        </div>
        {company.jobs.length ? (
          <div className="job-grid">
            {company.jobs.map((job) => (
              <article className="job-card" key={job.id}>
                <button className="job-card-main" onClick={() => openJob(company.id, job.id)}>
                  <div className="job-card-top">
                    <span className={`stage-pill stage-${STAGES.indexOf(job.stage)}`}>{job.stage}</span>
                    <span className={`priority priority-${job.priority}`}>{job.priority}优先级</span>
                  </div>
                  <h3>{job.title}</h3>
                  <p>{job.location || '地点未填写'} · {job.jobType || '类型未填写'}</p>
                  <div className="mini-progress" aria-label={`当前流程：${job.stage}`}>
                    {CORE_STAGES.map((stage, index) => (
                      <i key={stage} className={index <= jobProgress(job) ? 'filled' : ''} />
                    ))}
                  </div>
                  <div className="job-next">
                    <span>下一步</span>
                    <strong>{job.nextAction || '待安排'}</strong>
                    <small>{job.nextDate ? formatDate(job.nextDate) : '暂未设置日期'}</small>
                  </div>
                </button>
                <div className="job-card-actions">
                  <button onClick={() => startEditJob(company.id, job)}>编辑</button>
                  <button className="danger-text" onClick={() => deleteJob(company.id, job)}>删除</button>
                  <button className="open-detail" onClick={() => openJob(company.id, job.id)}>查看详情</button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="panel company-empty">
            <EmptyState
              title="从第一个岗位开始"
              text="岗位名称、投递日期、当前流程和下一步安排都可以单独记录。"
              action={(
                <div className="empty-actions">
                  <button className="primary-button" onClick={() => startAddJob(company.id, 'company')}>添加第一个岗位</button>
                  <button className="secondary-button" onClick={() => startBatchAdd(company.id)}>批量添加岗位</button>
                </div>
              )}
            />
          </div>
        )}
      </section>
    </>
  );

  const renderJob = (company: Company, job: Job) => {
    const orderedProcess = [...job.process].sort((a, b) => b.date.localeCompare(a.date));
    return (
      <>
        <nav className="breadcrumb" aria-label="面包屑">
          <button onClick={goHome}>概览</button><span>/</span>
          <button onClick={() => openCompany(company.id)}>{company.name}</button><span>/</span>
          <strong>{job.title}</strong>
        </nav>

        <section className="job-hero">
          <div>
            <div className="job-title-line">
              <span className="company-mark" style={{ background: company.color }}>{company.shortName.slice(0, 3)}</span>
              <div>
                <p className="eyebrow">{company.name}</p>
                <h1 ref={viewHeadingRef} className="view-title" tabIndex={-1}>{job.title}</h1>
              </div>
            </div>
            <p className="job-meta">{job.location || '地点未填写'} · {job.jobType || '类型未填写'} · {job.appliedAt ? `${formatDate(job.appliedAt)} 投递` : '尚未填写投递日期'}</p>
          </div>
          <div className="company-actions">
            <a className="primary-button" href={job.portalUrl || company.website} target="_blank" rel="noreferrer">查看岗位或官网</a>
            <button className="secondary-button" onClick={() => startEditJob(company.id, job)}>编辑岗位</button>
            <button className="icon-danger" onClick={() => deleteJob(company.id, job)}>删除</button>
          </div>
        </section>

        <section className="panel stage-board">
          <div className="section-heading">
            <div>
              <p className="eyebrow">当前招聘流程</p>
              <h2>{job.stage}</h2>
            </div>
            <button className="secondary-button" onClick={startAddEvent}>添加流程记录</button>
          </div>
          <div className="stage-steps">
            {CORE_STAGES.map((stage, index) => {
              const currentIndex = jobProgress(job);
              const isOutcome = job.stage === '进入人才库' || isInactive(job.stage);
              const state = index < currentIndex || (isOutcome && index === currentIndex)
                ? 'done'
                : !isOutcome && index === currentIndex
                  ? 'current'
                  : '';
              return (
                <div className={`stage-step ${state}`} key={stage}>
                  <span>{index < currentIndex ? '✓' : index + 1}</span>
                  <strong>{stage}</strong>
                </div>
              );
            })}
          </div>
          {job.stage === '进入人才库' && <p className="pool-notice">当前已进入人才库，可以继续记录后续沟通或重新激活的岗位进展。</p>}
          {job.stage === '被拒' && <p className="ended-notice">该岗位当前已被拒。你仍可以补充反馈和复盘记录。</p>}
          {job.stage === '已结束' && <p className="ended-notice">此招聘流程已结束。你仍可以编辑岗位或补充历史记录。</p>}
        </section>

        <div className="job-detail-grid">
          <section className="panel timeline-panel">
            <div className="section-heading">
              <div>
                <p className="eyebrow">过程记录</p>
                <h2>招聘时间线</h2>
              </div>
            </div>
            {orderedProcess.length ? (
              <div className="timeline">
                {orderedProcess.map((item) => (
                  <article className="timeline-item" key={item.id}>
                    <span className="timeline-dot" />
                    <div className="timeline-card">
                      <div className="timeline-top">
                        <span className={`stage-pill stage-${STAGES.indexOf(item.stage)}`}>{item.stage}</span>
                        <time>{formatDate(item.date)}</time>
                      </div>
                      <h3>{item.title}</h3>
                      {item.note && <p>{item.note}</p>}
                      <div className="timeline-actions">
                        <button onClick={() => startEditEvent(item)}>编辑</button>
                        <button className="danger-text" onClick={() => deleteEvent(item.id)}>删除</button>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <EmptyState
                compact
                title="还没有过程记录"
                text="收到笔试、面试或 Offer 通知后，把日期和备注记在这里。"
                action={<button className="secondary-button" onClick={startAddEvent}>添加第一条记录</button>}
              />
            )}
          </section>

          <aside className="job-side-stack">
            <section className="panel info-card next-action-card">
              <p className="eyebrow">下一步行动</p>
              <h2>{job.nextAction || '暂未安排'}</h2>
              <p>{job.nextDate ? formatDate(job.nextDate) : '编辑岗位后设置提醒日期'}</p>
              <button className="text-button" onClick={() => startEditJob(company.id, job)}>更新安排</button>
              <button className="text-button navigator-context-link" onClick={openNavigatorPanel}>查看职程建议</button>
            </section>
            <section className="panel info-card">
              <p className="eyebrow">岗位信息</p>
              <dl>
                <div><dt>优先级</dt><dd>{job.priority}</dd></div>
                <div><dt>投递日期</dt><dd>{formatDate(job.appliedAt)}</dd></div>
              </dl>
            </section>
            <section className="panel info-card notes-card">
              <p className="eyebrow">我的备注</p>
              <p>{job.notes || '暂无备注。可以记录内推人、岗位要求、面试准备要点等。'}</p>
            </section>
          </aside>
        </div>
      </>
    );
  };

  if (!ready && syncStatus === 'loading') {
    return (
      <main className="loading-shell">
        <section className="loading-card" role="status" aria-live="polite" aria-busy="true">
          <BrandSignature />
          <p className="eyebrow">私人云端版</p>
          <h1>正在同步你的进度</h1>
          <p>正在安全读取你的云端数据，请稍候。</p>
          <div className="loading-progress" aria-hidden="true">
            <span className="loading-progress-fill" />
          </div>
        </section>
      </main>
    );
  }

  if (syncStatus === 'signed-out') {
    return (
      <>
        <main className="auth-shell">
          <section className="auth-card">
            <BrandSignature />
            <p className="eyebrow">多用户云端空间</p>
            <h1>登录后开始管理</h1>
            <p>每个登录账号都有独立的数据空间。首次登录从空白工作台开始，其他用户无法查看或修改你的记录。同一人使用不同登录方式时，也会进入两个彼此独立的数据空间。</p>
            {authNotice && <p className="auth-inline-notice" role="alert">{authNotice}</p>}
            <div className="auth-options">
              <a className="primary-button auth-button" href="/signin-with-chatgpt?return_to=/">
                使用 ChatGPT 登录
              </a>
              <span>或</span>
              <a className="secondary-button auth-button" href="/api/auth/github/start">
                使用 GitHub 登录
              </a>
            </div>
            <button className="auth-privacy-link" onClick={openPrivacy}>隐私与数据说明</button>
          </section>
        </main>
        {privacyOpen && (
          <Modal title="隐私与数据说明" onClose={() => setPrivacyOpen(false)}>
            <PrivacyNotice />
          </Modal>
        )}
      </>
    );
  }

  if (syncStatus === 'access-denied') {
    return (
      <main className="auth-shell">
        <section className="auth-card">
          <BrandSignature />
          <p className="eyebrow">账号空间保护</p>
          <h1>暂时无法打开当前账号</h1>
          <p className="auth-recovery-copy">
            <span>确认当前账号后，工作台才会打开。</span>
            <span>避免共享设备误显其他账号缓存。</span>
          </p>
          <div className="auth-recovery-actions" aria-live="polite">
            <button className="primary-button auth-button" disabled={authDisconnecting} onClick={() => window.location.replace(window.location.href)}>重新连接</button>
            <button
              className="secondary-button auth-button"
              disabled={authDisconnecting}
              aria-busy={authDisconnecting}
              onClick={disconnectThisDeviceAndRestart}
            >
              {authDisconnecting ? '正在切断本机连接…' : '一键切断并重新登录'}
            </button>
          </div>
          <p className="auth-recovery-note">只清除此设备的登录状态和职序缓存，不会删除云端求职数据。</p>
          {authDisconnectError && <p className="auth-inline-notice" role="alert">{authDisconnectError}</p>}
        </section>
      </main>
    );
  }

  if (syncStatus === 'offline' && !activeStorageKey) {
    return (
      <>
        <main className="auth-shell">
          <section className="auth-card">
            <BrandSignature />
            <p className="eyebrow">登录状态保护</p>
            <h1>暂时无法确认登录账号</h1>
            <p className="auth-recovery-copy">
              <span>确认当前账号后，工作台才会打开。</span>
              <span>避免共享设备误显其他账号缓存。</span>
            </p>
            <div className="auth-recovery-actions" aria-live="polite">
              <button className="primary-button auth-button" disabled={authDisconnecting} onClick={() => window.location.replace(window.location.href)}>
                重新连接
              </button>
              <button
                className="secondary-button auth-button"
                disabled={authDisconnecting}
                aria-busy={authDisconnecting}
                onClick={disconnectThisDeviceAndRestart}
              >
                {authDisconnecting ? '正在切断本机连接…' : '一键切断并重新登录'}
              </button>
            </div>
            <p className="auth-recovery-note">只清除此设备的登录状态和职序缓存，不会删除云端求职数据。</p>
            {authDisconnectError && <p className="auth-inline-notice" role="alert">{authDisconnectError}</p>}
            <button className="auth-privacy-link" onClick={openPrivacy}>隐私与数据说明</button>
          </section>
        </main>
        {privacyOpen && (
          <Modal title="隐私与数据说明" onClose={() => setPrivacyOpen(false)}>
            <PrivacyNotice />
          </Modal>
        )}
      </>
    );
  }

  return (
    <div className="app-shell">
      <aside
        ref={sidebarRef}
        id="app-sidebar"
        className={`sidebar ${sidebarOpen ? 'sidebar-open' : ''}`}
        aria-label="主菜单"
        inert={dialogOpen ? true : undefined}
        aria-hidden={dialogOpen ? true : undefined}
      >
        <div className="sidebar-top-row">
          <button type="button" className="brand" onClick={goHome}>
            <BrandMark />
            <div><strong>职序</strong><small>CAREER RHYTHM</small></div>
          </button>
          <button className="sidebar-close" aria-label="关闭菜单" onClick={() => setSidebarOpen(false)}>关闭</button>
        </div>
        <button className={`nav-item ${!selectedCompanyId ? 'active' : ''}`} onClick={goHome}>
          <span>总览</span>
        </button>
        <button className="nav-item navigator-nav-item" onClick={() => { setSidebarOpen(false); openNavigatorPanel(); }}>
          <span>{NAVIGATOR_NAME} · 智能助手</span>
          {navigatorBriefing.urgentCount > 0 && <small>{navigatorBriefing.urgentCount}</small>}
        </button>
        <div className="sidebar-section-label"><span>目标公司</span><button aria-label="添加公司" onClick={() => startAddCompany()}>添加</button></div>
        <nav className="company-nav" aria-label="目标公司">
          {companies.map((company) => (
            <button
              key={company.id}
              className={selectedCompanyId === company.id ? 'active' : ''}
              onClick={() => openCompany(company.id)}
            >
              <span className="company-nav-mark" style={{ background: company.color }}>{company.shortName.slice(0, 2)}</span>
              <span>{company.name}</span>
              <small>{company.jobs.length}</small>
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="backup-actions">
            <button onClick={exportBackup}>导出备份</button>
            <button onClick={() => backupInputRef.current?.click()}>导入备份</button>
          </div>
          <button
            className="paste-backup-button"
            onClick={() => {
              setSidebarOpen(false);
              setBackupError('');
              setPasteImportOpen(true);
            }}
          >
            无法选择文件？粘贴备份内容
          </button>
          <input ref={backupInputRef} className="hidden-file-input" type="file" accept="application/json,.json" onChange={importBackup} />
          <p className={`sync-status sync-${syncStatus}`} role="status" aria-live="polite"><span className="save-dot" /> {SYNC_LABELS[syncStatus]}</p>
          {userEmail && <small className="account-email">{userEmail}</small>}
          <div className="account-actions">
            <button onClick={openPrivacy}>隐私说明</button>
            <button onClick={signOutAndClearDevice}>退出登录</button>
          </div>
          <button
            className="delete-data-button"
            onClick={() => {
              setSidebarOpen(false);
              setAccountActionError('');
              setDeleteConfirmationStep(1);
              setDeleteNeedsRefresh(false);
              setDeleteDataOpen(true);
            }}
          >
            清空求职内容
          </button>
        </div>
      </aside>
      {sidebarOpen && <button className="sidebar-scrim" aria-label="关闭菜单" onClick={() => setSidebarOpen(false)} />}

      <main className="main-area" inert={overlayOpen ? true : undefined} aria-hidden={overlayOpen ? true : undefined}>
        <header className="topbar">
          <button
            ref={mobileMenuButtonRef}
            className="mobile-menu"
            aria-label="打开菜单"
            aria-controls="app-sidebar"
            aria-expanded={sidebarOpen}
            onClick={() => setSidebarOpen(true)}
          >
            <BrandMark />
          </button>
          <label className="search-box">
            <input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setSelectedMetric(null);
                if (event.target.value && selectedCompanyId) goHome();
              }}
              placeholder="搜索公司、岗位或地点"
              aria-label="搜索公司、岗位或地点"
            />
          </label>
          <select
            className="stage-filter"
            value={stageFilter}
            aria-label="按流程筛选"
            onChange={(event) => {
              setStageFilter(event.target.value as '全部流程' | Stage);
              setSelectedMetric(null);
              if (event.target.value !== '全部流程') goHome();
            }}
          >
            <option>全部流程</option>
            {STAGES.map((stage) => <option key={stage}>{stage}</option>)}
          </select>
          <button
            className="mobile-filter-button"
            aria-label={`筛选岗位，当前为${stageFilter}`}
            aria-haspopup="dialog"
            aria-expanded={stageFilterOpen}
            data-active={stageFilter !== '全部流程' ? true : undefined}
            onClick={() => setStageFilterOpen(true)}
          >
            {stageFilter === '全部流程' ? '筛选' : '已筛'}
          </button>
          <button
            className="navigator-top-button"
            aria-label={`打开${NAVIGATOR_NAME}智能助手，${navigatorBriefing.urgentCount}项需优先处理`}
            onClick={openNavigatorPanel}
          >
            <span>{NAVIGATOR_NAME} · 智能助手</span>
            {navigatorBriefing.urgentCount > 0 && <strong>{navigatorBriefing.urgentCount}</strong>}
          </button>
        </header>
        <div className="content-wrap">
          {selectedCompany && selectedJob
            ? renderJob(selectedCompany, selectedJob)
            : selectedCompany
              ? renderCompany(selectedCompany)
              : renderDashboard()}
        </div>
      </main>

      {navigatorOpen && (
        <Modal
          title={`${NAVIGATOR_NAME} · 今日建议`}
          onClose={() => setNavigatorOpen(false)}
          wide
          className="navigator-modal"
          inactive={agentAdminOpen || agentActionConfirmOpen}
          headerAction={agentStatus?.isAdmin ? (
            <button
              type="button"
              className="navigator-admin-entry"
              onClick={() => {
                setAgentAdminOpen(true);
                void loadAgentAdminDashboard();
              }}
            >
              管理面板
            </button>
          ) : undefined}
        >
          <div className="navigator-dialog">
            <section className="navigator-dialog-hero">
              <div className="navigator-dialog-mark" aria-hidden="true"><NavigatorMark /></div>
              <div>
                <p className="eyebrow">{NAVIGATOR_ENGLISH_NAME}</p>
                <h3>{navigatorBriefing.healthLabel}</h3>
                <p>{navigatorBriefing.summary}</p>
              </div>
              <div className="navigator-dialog-score">
                <strong>{navigatorBriefing.insights.length}</strong>
                <span>条建议</span>
              </div>
            </section>

            <section className="navigator-mode-panel" aria-label="助手模式">
              <div className="navigator-mode-switch" role="group" aria-label="切换助手模式">
                <button
                  type="button"
                  className={agentMode === 'basic' ? 'active' : ''}
                  aria-pressed={agentMode === 'basic'}
                  onClick={() => {
                    setAgentMode('basic');
                    setAgentError('');
                    setAgentAnswer('');
                  }}
                >
                  <span>基础助手</span>
                  <small>本地规则 · 不消耗次数</small>
                </button>
                <button
                  type="button"
                  className={agentMode === 'intelligent' ? 'active' : ''}
                  aria-pressed={agentMode === 'intelligent'}
                  onClick={() => {
                    setAgentMode('intelligent');
                    setNavigatorResult(null);
                    void refreshAgentStatus();
                  }}
                >
                  <span>智能分析</span>
                  <small>{agentStatus?.isAdmin
                    ? '管理员不限次数'
                    : `滚动 24 小时 ${agentStatus?.limit ?? 5} 次`}</small>
                </button>
              </div>
              <p className="navigator-mode-status" role="status" aria-live="polite">
                {agentStatusLoading
                  ? '正在确认智能助手状态…'
                  : agentMode === 'basic'
                    ? '基础助手始终可用，查询、筛选与定位均在本机完成。'
                    : agentStatus?.isAdmin
                      ? `管理员账号 · ${agentStatus.enabled ? '智能调用已开启' : '全局调用已关闭'}`
                      : agentStatus
                        ? `过去 24 小时已用 ${agentStatus.used} 次，还可用 ${agentStatus.remaining ?? 0} 次。`
                        : '暂时无法确认额度，基础助手仍可正常使用。'}
              </p>
            </section>

            <form className="navigator-command" onSubmit={submitNavigatorCommand}>
              <label htmlFor="navigator-command-input">{agentMode === 'basic' ? '快速定位' : '向职程领航提问'}</label>
              <div>
                <input
                  id="navigator-command-input"
                  data-autofocus
                  value={navigatorCommand}
                  onChange={(event) => {
                    setNavigatorCommand(event.target.value);
                    setNavigatorResult(null);
                    setAgentError('');
                  }}
                  placeholder={agentMode === 'basic'
                    ? '例如：查看面试岗位 / 搜索上海'
                    : '例如：我本周应该优先准备哪些岗位？'}
                  maxLength={agentMode === 'intelligent' ? 800 : undefined}
                />
                <button
                  type="submit"
                  className="primary-button"
                  disabled={agentQueryLoading || (agentMode === 'intelligent' && (
                    !agentStatus?.intelligentAvailable
                    || (!agentStatus.isAdmin && agentStatus.remaining === 0)
                  ))}
                >
                  {agentMode === 'intelligent' ? (agentQueryLoading ? '分析中…' : '开始分析') : '执行'}
                </button>
              </div>
              {agentMode === 'intelligent' && (
                <small className="navigator-question-count">最多 800 字 · {navigatorCommand.length}/800</small>
              )}
              {agentMode === 'basic' && (
                <div className="navigator-quick-actions" aria-label="快捷操作">
                  <button type="button" onClick={() => runNavigatorAction({ kind: 'show-metric', metric: 'interview' })}>面试岗位</button>
                  <button type="button" onClick={() => runNavigatorAction({ kind: 'show-metric', metric: 'offer' })}>Offer</button>
                  <button type="button" onClick={() => runNavigatorAction({ kind: 'show-metric', metric: 'active' })}>进行中</button>
                  <button type="button" onClick={() => runNavigatorAction({ kind: 'add-opportunity' })}>添加机会</button>
                </div>
              )}
              {agentMode === 'basic' && navigatorResult && (
                <div className={`navigator-command-result result-${navigatorResult.status}`} role="status">
                  <p>{navigatorResult.message}</p>
                  {navigatorResult.candidates?.length ? (
                    <ul>{navigatorResult.candidates.slice(0, 5).map((candidate) => <li key={candidate}>{candidate}</li>)}</ul>
                  ) : null}
                </div>
              )}
              {agentMode === 'intelligent' && !agentStatusLoading && (
                !agentStatus?.intelligentAvailable
                || (!agentStatus.isAdmin && agentStatus.remaining === 0)
              ) && (
                <div className="navigator-agent-unavailable" role="status">
                  <div>
                    <strong>{agentStatus?.disabled
                      ? '当前账号的智能助手已停用'
                      : agentStatus && !agentStatus.isAdmin && agentStatus.remaining === 0
                        ? '过去 24 小时的智能额度已用完'
                        : '智能助手目前未开启'}</strong>
                    <p>{agentStatus && !agentStatus.isAdmin && agentStatus.remaining === 0
                      ? '额度会随着较早的成功调用超过 24 小时自动恢复；基础助手和网站其他功能始终可用。'
                      : '你的公司、岗位和招聘流程仍可正常使用，基础助手也不会消耗智能次数。'}</p>
                  </div>
                  <button type="button" className="secondary-button" onClick={() => setAgentMode('basic')}>使用基础助手</button>
                </div>
              )}
              {agentMode === 'intelligent' && agentQueryLoading && (
                <div className="navigator-agent-thinking" role="status" aria-live="polite">
                  <span aria-hidden="true" />
                  <div><strong>正在梳理你的求职进度</strong><p>只读取当前账号的必要信息，不会自动修改任何记录。</p></div>
                </div>
              )}
              {agentMode === 'intelligent' && agentAnswer && !agentQueryLoading && (
                <article className="navigator-agent-answer" aria-live="polite">
                  <p className="eyebrow">智能分析</p>
                  <h3>给你的建议</h3>
                  <p>{agentAnswer}</p>
                  {agentCallId && <div className="navigator-agent-feedback" aria-label="评价这次智能分析">
                    {agentFeedback === 'resolved' || agentFeedback === 'unresolved' ? (
                      <p role="status">
                        {agentFeedback === 'resolved'
                          ? '已记录为有帮助，谢谢你的反馈。'
                          : '已记录为信息有误或仍需完善，你可以继续补充情况。'}
                      </p>
                    ) : (
                      <>
                        <span>{agentFeedback === 'error' ? '刚才没有记录成功，要再试一次吗？' : '这次回答对你有帮助吗？'}</span>
                        <div>
                          <button type="button" disabled={agentFeedbackLoading} onClick={() => void submitAgentFeedback('resolved')}>有帮助</button>
                          <button type="button" disabled={agentFeedbackLoading} onClick={() => void submitAgentFeedback('unresolved')}>信息有误</button>
                        </div>
                      </>
                    )}
                  </div>}
                </article>
              )}
              {agentMode === 'intelligent' && agentActionProposal && !agentQueryLoading && (
                <article className={`navigator-action-proposal ${agentActionProposal.destructive ? 'is-destructive' : ''}`} aria-live="polite">
                  <div className="navigator-action-proposal-heading">
                    <div>
                      <p className="eyebrow">操作提案 · 尚未执行</p>
                      <h3>{agentActionProposal.title}</h3>
                    </div>
                    <span>{agentActionProposal.destructive ? '需要危险确认' : '需要你确认'}</span>
                  </div>
                  <p>{agentActionProposal.summary}</p>
                  <dl>
                    {agentActionProposal.details.map((detail) => (
                      <div key={`${detail.label}:${detail.value}`}><dt>{detail.label}</dt><dd>{detail.value}</dd></div>
                    ))}
                  </dl>
                  <p className={agentActionProposal.destructive ? 'navigator-action-danger-note' : 'navigator-action-impact'}>
                    {agentActionProposal.impact}
                  </p>
                  <div className="navigator-action-buttons">
                    <button type="button" className="secondary-button" data-autofocus onClick={() => void cancelAgentAction()}>取消本次操作</button>
                    <button type="button" className="secondary-button" onClick={() => void cancelAgentAction('incorrect')}>提案信息有误</button>
                    <button
                      type="button"
                      className={agentActionProposal.destructive ? 'danger-outline-button' : 'primary-button'}
                      onClick={() => setAgentActionConfirmOpen(true)}
                    >
                      继续确认
                    </button>
                  </div>
                </article>
              )}
              {agentMode === 'intelligent' && agentProposalReview !== 'idle' && !agentActionProposal && !agentActionCompleted && !agentQueryLoading && (
                <article className="navigator-action-completed" aria-live="polite">
                  <p className="eyebrow">提案结果</p>
                  <h3>已取消，没有修改求职数据</h3>
                  <p>{agentProposalReview === 'incorrect'
                    ? '已记录为“提案信息有误”，管理面板会把这次反馈纳入质量统计。'
                    : agentProposalReview === 'error'
                      ? '提案已从页面关闭，但反馈暂时没有保存；你可以重新描述后再试。'
                      : '这次提案已安全取消。'}</p>
                </article>
              )}
              {agentMode === 'intelligent' && agentActionCompleted && !agentQueryLoading && (
                <article className="navigator-action-completed" aria-live="polite">
                  <p className="eyebrow">操作结果</p>
                  <h3>{agentActionCompleted.title}</h3>
                  <p>{agentActionCompleted.summary}</p>
                  <div className="navigator-agent-feedback" aria-label="评价这次操作结果">
                    {agentActionFeedback === 'correct' || agentActionFeedback === 'incorrect' ? (
                      <p role="status">{agentActionFeedback === 'correct' ? '已记录为操作正确。' : '已记录为操作有误，管理面板会纳入误操作指标。'}</p>
                    ) : (
                      <>
                        <span>{agentActionFeedback === 'error' ? '刚才没有记录成功，要重试吗？' : '这次操作结果是否正确？'}</span>
                        <div>
                          <button type="button" disabled={agentActionFeedbackLoading} onClick={() => void submitAgentActionFeedback('correct')}>操作正确</button>
                          <button type="button" disabled={agentActionFeedbackLoading} onClick={() => void submitAgentActionFeedback('incorrect')}>操作有误</button>
                        </div>
                      </>
                    )}
                  </div>
                </article>
              )}
              {agentMode === 'intelligent' && agentActionError && !agentQueryLoading && (
                <div className="navigator-agent-error" role="alert">
                  <div><strong>本次未执行</strong><p>{agentActionError}</p></div>
                  <button type="button" className="secondary-button" onClick={() => setAgentActionConfirmOpen(false)}>返回检查</button>
                </div>
              )}
              {agentError && !agentQueryLoading && (
                <div className="navigator-agent-error" role="alert">
                  <div>
                    <strong>{agentMode === 'basic' ? '已切换到基础助手' : '这次分析没有完成'}</strong>
                    <p>{agentError}</p>
                    {agentCallId && (
                      <div className="navigator-agent-feedback" aria-label="评价这次失败结果">
                        {agentFeedback === 'resolved' || agentFeedback === 'unresolved' ? (
                          <p role="status">{agentFeedback === 'resolved' ? '已记录为仍有帮助。' : '已记录为信息有误。'}</p>
                        ) : (
                          <>
                            <span>{agentFeedback === 'error' ? '反馈未保存，要再试一次吗？' : '这次失败提示是否准确？'}</span>
                            <div>
                              <button type="button" disabled={agentFeedbackLoading} onClick={() => void submitAgentFeedback('resolved')}>仍有帮助</button>
                              <button type="button" disabled={agentFeedbackLoading} onClick={() => void submitAgentFeedback('unresolved')}>信息有误</button>
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                  <div>
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={!agentStatus?.intelligentAvailable || (!agentStatus.isAdmin && agentStatus.remaining === 0)}
                      onClick={() => {
                        setAgentMode('intelligent');
                        void runIntelligentAgent();
                      }}
                    >
                      重试智能分析
                    </button>
                    {agentMode === 'intelligent' && <button type="button" className="text-button" onClick={() => setAgentMode('basic')}>切换基础助手</button>}
                  </div>
                </div>
              )}
            </form>

            <section className="navigator-insights" aria-labelledby="navigator-insights-title">
              <div className="navigator-section-heading">
                <div>
                  <p className="eyebrow">行动清单</p>
                  <h3 id="navigator-insights-title">先处理最重要的事项</h3>
                </div>
                <span>依据日期、阶段与优先级</span>
              </div>
              {navigatorBriefing.insights.length ? (
                <div className="navigator-insight-list">
                  {navigatorBriefing.insights.map((insight) => (
                    <article className={`navigator-insight severity-${insight.severity}`} key={insight.id}>
                      <span className="navigator-severity" aria-hidden="true" />
                      <div className="navigator-insight-copy">
                        <span>{insight.severity === 'urgent' ? '优先处理' : insight.severity === 'attention' ? '建议完善' : '可以优化'}</span>
                        <h4>{insight.title}</h4>
                        <p>{insight.detail}</p>
                        <small>{insight.evidence}</small>
                      </div>
                      <button className="secondary-button" type="button" onClick={() => runNavigatorAction(insight.action)}>
                        {insight.actionLabel}
                      </button>
                    </article>
                  ))}
                </div>
              ) : (
                <EmptyState
                  compact
                  title="目前没有需要处理的提醒"
                  text={navigatorBriefing.activeCount ? '所有进行中岗位的节奏都很清楚。' : '添加岗位后，职程领航会在这里生成建议。'}
                  action={<button className="secondary-button" type="button" onClick={() => runNavigatorAction({ kind: 'add-opportunity' })}>添加机会</button>}
                />
              )}
            </section>

            <p className="navigator-safety-note">基础助手在本机运行；只有你主动使用智能分析时，当前问题与必要的结构化岗位信息才会发送给豆包，不会发送备注正文。职程领航可查询、分析、生成建议，也可将单条新增或删除整理成操作提案；模型永远不能直接执行，只有你经过第二次确认后服务器才会操作当前账号数据。系统不保存问题与回答正文。</p>
          </div>
        </Modal>
      )}

      {agentAdminOpen && (
        <Modal
          title="智能助手管理"
          onClose={() => setAgentAdminOpen(false)}
          wide
          className="navigator-modal navigator-admin-modal"
          busy={agentAdminLoading}
        >
          <div className="navigator-admin-panel">
            <section className="navigator-admin-switch">
              <div>
                <p className="eyebrow">全局控制</p>
                <h3>{agentAdminDashboard?.globalEnabled ? '智能调用已开启' : '智能调用已关闭'}</h3>
                <p>关闭后所有账号（包括管理员）都会自动回到基础助手，网站其他功能不受影响。</p>
              </div>
              <button
                type="button"
                className={agentAdminDashboard?.globalEnabled ? 'danger-button' : 'primary-button'}
                disabled={agentAdminLoading || agentAdminPendingKey === 'global' || !agentAdminDashboard}
                onClick={() => void updateAgentAdmin({ kind: 'global', enabled: !agentAdminDashboard?.globalEnabled })}
              >
                {agentAdminPendingKey === 'global'
                  ? '正在保存…'
                  : agentAdminDashboard?.globalEnabled ? '紧急关闭' : '开启智能调用'}
              </button>
            </section>

            {agentAdminDashboard && (
              <section className="navigator-admin-quota" aria-labelledby="navigator-admin-quota-title">
                <div>
                  <p className="eyebrow">额度策略</p>
                  <h3 id="navigator-admin-quota-title">全体普通用户默认额度</h3>
                  <p>按滚动 24 小时计算，可设置 0–100 次；管理员仍不限次数。</p>
                </div>
                <div className="navigator-admin-quota-control">
                  <label htmlFor="agent-default-limit">每个账号</label>
                  <div>
                    <input
                      id="agent-default-limit"
                      type="number"
                      inputMode="numeric"
                      min="0"
                      max="100"
                      value={agentDefaultLimitDraft}
                      onChange={(event) => setAgentDefaultLimitDraft(event.target.value)}
                      aria-invalid={parseAgentLimitDraft(agentDefaultLimitDraft) === null}
                    />
                    <span>次 / 24 小时</span>
                  </div>
                  <button
                    type="button"
                    className="primary-button"
                    disabled={agentAdminLoading || agentAdminPendingKey === 'default_limit' || parseAgentLimitDraft(agentDefaultLimitDraft) === null}
                    onClick={() => {
                      const limit = parseAgentLimitDraft(agentDefaultLimitDraft);
                      if (limit !== null) void updateAgentAdmin({ kind: 'default_limit', limit });
                    }}
                  >
                    {agentAdminPendingKey === 'default_limit' ? '正在保存…' : '保存全体额度'}
                  </button>
                </div>
              </section>
            )}

            {agentAdminDashboard && (
              <section className="navigator-admin-totals" aria-label="累计调用概览">
                <div><span>成功调用</span><strong>{agentAdminDashboard.totals.successfulCalls}</strong></div>
                <div><span>累计 Token</span><strong>{agentAdminDashboard.totals.totalTokens.toLocaleString('zh-CN')}</strong></div>
              </section>
            )}

            {agentAdminDashboard && (
              <section className="navigator-quality" aria-labelledby="navigator-quality-title">
                <div className="navigator-section-heading">
                  <div><p className="eyebrow">质量评估</p><h3 id="navigator-quality-title">Agent 评估指标</h3></div>
                  <span>仅使用匿名运行元数据、真实执行结果与用户评价</span>
                </div>
                <div className="navigator-evaluation-core-grid" aria-label="核心评估指标">
                  {buildAgentEvaluationRows(agentAdminDashboard.quality)
                    .filter((metric) => metric.core)
                    .map((metric) => <AgentEvaluationCard key={metric.name} metric={metric} />)}
                </div>
                <div className="navigator-evaluation-subheading">
                  <h4>完整指标</h4>
                  <span>统计口径可按需展开</span>
                </div>
                <div className="navigator-evaluation-grid" aria-label="完整评估指标">
                  {buildAgentEvaluationRows(agentAdminDashboard.quality)
                    .filter((metric) => !metric.core)
                    .map((metric) => <AgentEvaluationCard key={metric.name} metric={metric} />)}
                </div>
                <p className="navigator-evaluation-note">
                  暂不展示“意图准确率、工具选择准确率、参数完全匹配率”：这三项必须使用人工标注的金标评测集，不能用在线代理数据冒充准确率。
                </p>
              </section>
            )}

            {agentAdminError && <p className="navigator-admin-error" role="alert">{agentAdminError}</p>}
            {agentAdminLoading && !agentAdminDashboard ? (
              <p className="navigator-admin-loading" role="status">正在读取调用概览…</p>
            ) : (
              <section className="navigator-admin-users" aria-labelledby="navigator-admin-users-title">
                <div className="navigator-section-heading">
                  <div><p className="eyebrow">账号用量</p><h3 id="navigator-admin-users-title">用户调用状态</h3></div>
                  <span>不展示岗位与对话正文</span>
                </div>
                <div className="navigator-admin-user-list">
                  {agentAdminDashboard?.users.map((user) => (
                    <article key={user.userNumber} className="navigator-admin-user">
                      <div className="navigator-admin-user-id">
                        <span>用户编号</span><strong>#{String(user.userNumber).padStart(4, '0')}</strong>
                        <small>{user.role === 'admin' ? '管理员 · 不限次数' : '普通用户'}</small>
                      </div>
                      <dl>
                        <div><dt>24 小时已用</dt><dd>{user.used24h}{user.role === 'admin' ? ' 次' : ` / ${user.effectiveLimit ?? agentAdminDashboard.defaultLimit} 次`}</dd></div>
                        <div><dt>最后调用</dt><dd>{user.lastCallAt ? new Date(user.lastCallAt).toLocaleString('zh-CN', { hour12: false }) : '暂无'}</dd></div>
                        <div><dt>Token</dt><dd>{user.totalTokens.toLocaleString('zh-CN')}</dd></div>
                      </dl>
                      <div className="navigator-admin-user-actions">
                        {user.role === 'user' && (
                          <div className="navigator-admin-user-quota">
                            <label htmlFor={`agent-user-limit-${user.userNumber}`}>
                              单独额度
                              <small>{user.limitOverride === null ? '继承全体默认' : '已单独设置'}</small>
                            </label>
                            <div>
                              <input
                                id={`agent-user-limit-${user.userNumber}`}
                                type="number"
                                inputMode="numeric"
                                min="0"
                                max="100"
                                value={agentUserLimitDrafts[user.userNumber] ?? String(user.effectiveLimit ?? agentAdminDashboard.defaultLimit)}
                                onChange={(event) => setAgentUserLimitDrafts((current) => ({
                                  ...current,
                                  [user.userNumber]: event.target.value,
                                }))}
                                aria-invalid={parseAgentLimitDraft(agentUserLimitDrafts[user.userNumber] ?? String(user.effectiveLimit ?? agentAdminDashboard.defaultLimit)) === null}
                              />
                              <button
                                type="button"
                                className="secondary-button"
                                disabled={agentAdminLoading || agentAdminPendingKey === `user_limit:${user.userNumber}` || parseAgentLimitDraft(agentUserLimitDrafts[user.userNumber] ?? String(user.effectiveLimit ?? agentAdminDashboard.defaultLimit)) === null}
                                onClick={() => {
                                  const limit = parseAgentLimitDraft(agentUserLimitDrafts[user.userNumber] ?? String(user.effectiveLimit ?? agentAdminDashboard.defaultLimit));
                                  if (limit !== null) void updateAgentAdmin({ kind: 'user_limit', userNumber: user.userNumber, limit });
                                }}
                              >
                                {agentAdminPendingKey === `user_limit:${user.userNumber}` ? '保存中…' : '保存额度'}
                              </button>
                            </div>
                            {user.limitOverride !== null && (
                              <button
                                type="button"
                                className="text-button"
                                disabled={agentAdminLoading || agentAdminPendingKey === `user_limit:${user.userNumber}`}
                                onClick={() => void updateAgentAdmin({ kind: 'user_limit', userNumber: user.userNumber, limit: null })}
                              >
                                恢复全体默认
                              </button>
                            )}
                          </div>
                        )}
                        <button
                          type="button"
                          className={user.disabled ? 'secondary-button' : 'text-button'}
                          disabled={agentAdminLoading || agentAdminPendingKey === `user:${user.userNumber}` || user.role === 'admin'}
                          onClick={() => void updateAgentAdmin({ kind: 'user', userNumber: user.userNumber, disabled: !user.disabled })}
                        >
                          {agentAdminPendingKey === `user:${user.userNumber}`
                            ? '正在保存…'
                            : user.role === 'admin' ? '管理员保护' : user.disabled ? '恢复使用' : '停用智能助手'}
                        </button>
                      </div>
                    </article>
                  ))}
                  {!agentAdminDashboard?.users.length && <p className="navigator-admin-empty">暂时还没有智能调用记录。</p>}
                </div>
              </section>
            )}
          </div>
        </Modal>
      )}

      {agentActionConfirmOpen && agentActionProposal && (
        <Modal
          title={agentActionProposal.destructive
            ? '最后确认删除'
            : agentActionProposal.actionKind.startsWith('update_')
              ? '最后确认修改'
              : '最后确认新增'}
          onClose={() => void cancelAgentAction()}
          busy={agentActionLoading}
        >
          <div className={`navigator-action-confirmation ${agentActionProposal.destructive ? 'is-destructive' : ''}`}>
            <div className="navigator-action-confirmation-hero" role={agentActionProposal.destructive ? 'alert' : 'status'}>
              <span aria-hidden="true">{agentActionProposal.destructive ? '危险操作' : '待你确认'}</span>
              <h3>{agentActionProposal.title}</h3>
              <p>{agentActionProposal.summary}</p>
            </div>
            <dl>
              {agentActionProposal.details.map((detail) => (
                <div key={`${detail.label}:${detail.value}`}><dt>{detail.label}</dt><dd>{detail.value}</dd></div>
              ))}
            </dl>
            <p className={agentActionProposal.destructive ? 'delete-warning' : 'confirmation-warning'}>
              {agentActionProposal.destructive
                ? `请再次核对：${agentActionProposal.impact}。确认后才会删除，此操作不可撤销。`
                : `请再次核对：${agentActionProposal.impact}。确认后才会写入当前账号。`}
            </p>
            {agentActionError && <p className="navigator-admin-error" role="alert">{agentActionError}</p>}
            <div className="form-actions">
              <button type="button" className="secondary-button" data-autofocus disabled={agentActionLoading} onClick={() => void cancelAgentAction()}>取消，不执行</button>
              <button
                type="button"
                className={agentActionProposal.destructive ? 'danger-button' : 'primary-button'}
                disabled={agentActionLoading}
                onClick={() => void confirmAgentAction()}
              >
                {agentActionLoading
                  ? '正在安全执行…'
                  : agentActionProposal.destructive
                    ? '确认删除'
                    : agentActionProposal.actionKind.startsWith('update_')
                      ? '确认修改'
                      : '确认新增'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {pendingConfirmation && (
        <ConfirmationDialog
          target={pendingConfirmation}
          companies={companies}
          targetAccountLabel={maskAccountEmail(userEmail)}
          onCancel={() => setPendingConfirmation(null)}
          onConfirm={confirmPendingAction}
        />
      )}

      {addOpportunityOpen && (
        <Modal title="添加机会" onClose={() => setAddOpportunityOpen(false)}>
          <div className="opportunity-options">
            <p>选择最符合当前情况的方式。系统不会替你默认选择公司。</p>
            <button
              type="button"
              className="opportunity-card opportunity-card-primary"
              data-autofocus
              onClick={() => startAddCompany(true)}
            >
              <span className="opportunity-kicker">从新公司开始</span>
              <strong>新建公司并添加岗位</strong>
              <small>先保存公司和招聘官网，再自动进入该公司的岗位表单。</small>
            </button>
            <button
              type="button"
              className="opportunity-card"
              disabled={!companies.length}
              onClick={() => startAddJob(undefined, 'dashboard')}
            >
              <span className="opportunity-kicker">已有目标公司</span>
              <strong>为已有公司添加岗位</strong>
              <small>{companies.length ? '在下一步明确选择公司，再填写岗位信息。' : '目前还没有公司，请先使用上面的方式新建。'}</small>
            </button>
          </div>
        </Modal>
      )}

      {companyDraft && (
        <Modal
          title={editingCompanyId ? '编辑公司' : continueToJobAfterCompany ? '新建公司并继续添加岗位' : '添加公司'}
          onClose={requestCloseCompanyEditor}
          inactive={discardTarget === 'company'}
        >
          <form onSubmit={saveCompany} className="editor-form">
            <div className="form-grid two-columns">
              <label><span>公司名称 *</span><input required value={companyDraft.name} onChange={(e) => setCompanyDraft({ ...companyDraft, name: e.target.value })} placeholder="例如：星澜能源" /></label>
              <label><span>简称</span><input value={companyDraft.shortName} onChange={(e) => setCompanyDraft({ ...companyDraft, shortName: e.target.value })} placeholder="用于左侧图标" maxLength={6} /></label>
            </div>
            <label><span>招聘网站 *</span><input required type="url" value={companyDraft.website} onChange={(e) => setCompanyDraft({ ...companyDraft, website: e.target.value })} placeholder="https://..." /></label>
            <label><span>标记颜色</span><div className="color-options">{COLORS.map((color) => <button type="button" aria-label={`选择颜色 ${color}`} aria-pressed={companyDraft.color === color} key={color} className={companyDraft.color === color ? 'selected' : ''} style={{ background: color }} onClick={() => setCompanyDraft({ ...companyDraft, color })} />)}</div></label>
            <label><span>备注</span><textarea value={companyDraft.note} onChange={(e) => setCompanyDraft({ ...companyDraft, note: e.target.value })} placeholder="例如：账号、投递入口说明等（不要填写密码）" rows={3} /></label>
            <FormActions onCancel={requestCloseCompanyEditor} submitText={editingCompanyId ? '保存修改' : continueToJobAfterCompany ? '保存并继续' : '添加公司'} />
          </form>
        </Modal>
      )}

      {jobDraft && (
        <Modal
          title={editingJobId ? '编辑岗位' : jobEntryContext === 'company' && jobCompanyId ? `为“${companies.find((company) => company.id === jobCompanyId)?.name ?? '当前公司'}”添加岗位` : '添加岗位'}
          onClose={requestCloseJobEditor}
          inactive={discardTarget === 'job'}
          wide
        >
          <form onSubmit={saveJob} className="editor-form">
            {jobEntryContext === 'dashboard' ? (
              <div className="company-picker-row">
                <label><span>所属公司 *</span><select required value={jobCompanyId ?? ''} onChange={(e) => setJobCompanyId(e.target.value)}><option value="" disabled>请选择公司</option>{companies.map((company) => <option value={company.id} key={company.id}>{company.name}</option>)}</select></label>
                <button type="button" className="secondary-button" onClick={() => startAddCompany(true, jobDraft)}>新建公司</button>
              </div>
            ) : (
              <div className="company-context-card" role="note">
                <span>所属公司</span>
                <strong>{companies.find((company) => company.id === jobCompanyId)?.name ?? '当前公司'}</strong>
                <small>该岗位会保存到这家公司，归属不会被误改。</small>
              </div>
            )}
            <div className="form-grid two-columns">
              <label><span>岗位名称 *</span><input className="job-title-input" required value={jobDraft.title} onChange={(e) => { setJobDraft({ ...jobDraft, title: e.target.value }); setJobDraftError(''); }} placeholder="例如：电力电子工程师" /></label>
              <label><span>地点</span><input value={jobDraft.location} onChange={(e) => { setJobDraft({ ...jobDraft, location: e.target.value }); setJobDraftError(''); }} placeholder="例如：上海 / 墨尔本" /></label>
              <label><span>招聘类型</span><input value={jobDraft.jobType} onChange={(e) => setJobDraft({ ...jobDraft, jobType: e.target.value })} placeholder="校招 / 实习 / 社招" /></label>
              <label><span>当前流程</span><select value={jobDraft.stage} onChange={(e) => setJobDraft({ ...jobDraft, stage: e.target.value as Stage })}>{STAGES.map((stage) => <option key={stage}>{stage}</option>)}</select></label>
              <label><span>优先级</span><select value={jobDraft.priority} onChange={(e) => setJobDraft({ ...jobDraft, priority: e.target.value as Job['priority'] })}><option>高</option><option>中</option><option>低</option></select></label>
              <label className="full-width application-date-field"><span>投递日期</span><SegmentedDateInput value={jobDraft.appliedAt} error={jobDateError} errorId="job-date-error" onChange={(appliedAt) => { setJobDraft({ ...jobDraft, appliedAt }); setJobDateError(''); }} /></label>
            </div>
            <label><span>岗位页面链接</span><input type="url" value={jobDraft.portalUrl} onChange={(e) => setJobDraft({ ...jobDraft, portalUrl: e.target.value })} placeholder="留空则使用公司招聘官网" /></label>
            <div className="form-grid two-columns">
              <label><span>下一步行动</span><input value={jobDraft.nextAction} onChange={(e) => setJobDraft({ ...jobDraft, nextAction: e.target.value })} placeholder="例如：准备技术面试" /></label>
              <label><span>下一步日期</span><input type="date" value={jobDraft.nextDate} onChange={(e) => setJobDraft({ ...jobDraft, nextDate: e.target.value })} /></label>
            </div>
            <label><span>岗位备注</span><textarea value={jobDraft.notes} onChange={(e) => setJobDraft({ ...jobDraft, notes: e.target.value })} placeholder="记录 JD 重点、联系人、准备事项等" rows={4} /></label>
            {jobDraftError && <p className="field-error" role="alert">{jobDraftError}</p>}
            <FormActions onCancel={requestCloseJobEditor} submitText={editingJobId ? '保存修改' : '添加岗位'} />
          </form>
        </Modal>
      )}

      {stageFilterOpen && (
        <Modal title="筛选招聘流程" onClose={() => setStageFilterOpen(false)}>
          <div className="filter-options" role="group" aria-label="招聘流程筛选">
            {(['全部流程', ...STAGES] as Array<'全部流程' | Stage>).map((stage) => (
              <button
                type="button"
                aria-pressed={stageFilter === stage}
                className={`filter-option ${stageFilter === stage ? 'active' : ''}`}
                data-autofocus={stageFilter === stage ? true : undefined}
                key={stage}
                onClick={() => {
                  setStageFilter(stage);
                  setSelectedMetric(null);
                  goHome();
                  setStageFilterOpen(false);
                }}
              >
                <span>{stage}</span>
                <small>{stageFilter === stage ? '当前筛选' : '选择'}</small>
              </button>
            ))}
          </div>
        </Modal>
      )}

      {batchCompany && (
        <Modal title={`批量添加岗位 · ${batchCompany.name}`} onClose={requestCloseBatchAdd} inactive={discardTarget === 'batch'} wide>
          <form onSubmit={saveBatchJobs} className="editor-form batch-form">
            <p className="batch-footer-note">为当前公司一次添加多个岗位。共同设置会应用到这一批的每个岗位。</p>
            <div className="batch-shared form-grid two-columns">
              <label><span>招聘类型</span><input value={batchDefaults.jobType} onChange={(e) => setBatchDefaults({ ...batchDefaults, jobType: e.target.value })} placeholder="校招 / 实习 / 社招" /></label>
              <label><span>当前流程</span><select value={batchDefaults.stage} onChange={(e) => setBatchDefaults({ ...batchDefaults, stage: e.target.value as Stage })}>{STAGES.map((stage) => <option key={stage}>{stage}</option>)}</select></label>
              <label><span>优先级</span><select value={batchDefaults.priority} onChange={(e) => setBatchDefaults({ ...batchDefaults, priority: e.target.value as Job['priority'] })}><option>高</option><option>中</option><option>低</option></select></label>
              <label className="application-date-field"><span>投递日期</span><SegmentedDateInput value={batchDefaults.appliedAt} error={batchError.includes('日期') || batchError.includes('年、月、日') ? batchError : ''} errorId="batch-date-error" onChange={(appliedAt) => { setBatchDefaults({ ...batchDefaults, appliedAt }); setBatchError(''); }} /></label>
            </div>
            <div className="batch-list">
              {batchRows.map((row, index) => (
                <section className="batch-row" key={row.id} aria-labelledby={`batch-row-title-${row.id}`}>
                  <div className="batch-row-header">
                    <strong id={`batch-row-title-${row.id}`}>岗位 {index + 1}</strong>
                    <button type="button" className="text-button danger-text" aria-label={`删除岗位 ${index + 1}`} onClick={() => removeBatchRow(row.id)}>删除此行</button>
                  </div>
                  <div className="batch-row-grid">
                    <label>
                      <span>岗位名称 *</span>
                      <input
                        id={`batch-title-${row.id}`}
                        value={row.title}
                        aria-invalid={Boolean(batchRowErrors[row.id])}
                        aria-describedby={batchRowErrors[row.id] ? `batch-row-error-${row.id}` : undefined}
                        onChange={(e) => updateBatchRow(row.id, { title: e.target.value })}
                        placeholder="例如：电力电子工程师"
                      />
                      {batchRowErrors[row.id] && <small id={`batch-row-error-${row.id}`} className="batch-field-error" role="alert">{batchRowErrors[row.id]}</small>}
                    </label>
                    <label><span>地点</span><input value={row.location} onChange={(e) => updateBatchRow(row.id, { location: e.target.value })} placeholder="例如：上海" /></label>
                    <label className="batch-url"><span>岗位页面链接</span><input type="url" value={row.portalUrl} onChange={(e) => updateBatchRow(row.id, { portalUrl: e.target.value })} placeholder="https://...（可留空）" /></label>
                  </div>
                </section>
              ))}
            </div>
            <button type="button" className="secondary-button batch-add-row" onClick={addBatchRow} disabled={batchRows.length >= 20}>继续添加一行</button>
            <p className="batch-footer-note">已填写 {batchMeaningfulCount} 个岗位，一次最多 20 个。</p>
            {batchError && !batchError.includes('日期') && !batchError.includes('年、月、日') && (
              <p className="field-error" role="alert">{batchError}</p>
            )}
            <FormActions onCancel={requestCloseBatchAdd} submitText={`添加 ${batchMeaningfulCount || 0} 个岗位`} />
          </form>
        </Modal>
      )}

      {discardTarget && (
        <Modal title="放弃未保存的内容？" onClose={() => setDiscardTarget(null)}>
          <div className="account-dialog-content">
            <p>当前表单还有未保存的修改。关闭后，这些内容不会写入你的账号。</p>
            <p className="delete-warning">你可以返回继续编辑，或确认放弃本次修改。</p>
            <div className="form-actions">
              <button type="button" className="secondary-button" data-autofocus onClick={() => setDiscardTarget(null)}>继续编辑</button>
              <button type="button" className="danger-button" onClick={discardAndClose}>放弃并关闭</button>
            </div>
          </div>
        </Modal>
      )}

      {eventDraft && (
        <Modal title={editingEventId ? '编辑流程记录' : '添加流程记录'} onClose={() => setEventDraft(null)}>
          <form onSubmit={saveEvent} className="editor-form">
            <div className="form-grid two-columns">
              <label><span>流程阶段</span><select value={eventDraft.stage} onChange={(e) => setEventDraft({ ...eventDraft, stage: e.target.value as Stage })}>{STAGES.map((stage) => <option key={stage}>{stage}</option>)}</select></label>
              <label><span>日期</span><input required type="date" value={eventDraft.date} onChange={(e) => setEventDraft({ ...eventDraft, date: e.target.value })} /></label>
            </div>
            <label><span>记录标题 *</span><input required value={eventDraft.title} onChange={(e) => setEventDraft({ ...eventDraft, title: e.target.value })} placeholder="例如：收到一面邀请" /></label>
            <label><span>详细备注</span><textarea value={eventDraft.note} onChange={(e) => setEventDraft({ ...eventDraft, note: e.target.value })} placeholder="例如：面试时间、形式、联系人和准备重点" rows={4} /></label>
            <FormActions onCancel={() => setEventDraft(null)} submitText={editingEventId ? '保存修改' : '添加记录'} />
          </form>
        </Modal>
      )}

      {pasteImportOpen && (
        <Modal title="粘贴备份内容" onClose={() => setPasteImportOpen(false)}>
          <form onSubmit={importPastedBackup} className="editor-form">
            <p className="backup-import-note">粘贴完整 JSON 备份后，将替换当前账号下的数据并自动同步到云端。</p>
            <label>
              <span>JSON 备份内容 *</span>
              <textarea
                required
                aria-label="JSON 备份内容"
                value={backupText}
                onChange={(event) => {
                  setBackupText(event.target.value);
                  setBackupError('');
                }}
                placeholder="粘贴备份文件中的全部内容"
                rows={12}
              />
            </label>
            {backupError && <p className="backup-import-error" role="alert">{backupError}</p>}
            <FormActions onCancel={() => setPasteImportOpen(false)} submitText="确认导入" />
          </form>
        </Modal>
      )}

      {privacyOpen && (
        <Modal title="隐私与数据说明" onClose={() => setPrivacyOpen(false)}>
          <PrivacyNotice />
        </Modal>
      )}

      {deleteDataOpen && (
        <Modal
          title="清空求职内容"
          dismissible={!deletingData && !deleteNeedsRefresh}
          busy={deletingData}
          onClose={() => {
            if (deletingData || deleteNeedsRefresh) return;
            setDeleteDataOpen(false);
            setDeleteConfirmationStep(1);
            setDeleteNeedsRefresh(false);
            setAccountActionError('');
          }}
        >
          <div className="account-dialog-content">
            {deleteConfirmationStep === 1 ? (
              <>
                <p>点击这里不会立即清空。继续后还需要在下一步再次确认。</p>
                <p>最终确认后，才会永久清空当前账号的全部公司、岗位和招聘流程内容。</p>
              </>
            ) : (
              <>
                <p className="delete-warning"><strong>最后一次确认：</strong>确定清空当前账号的全部求职内容吗？</p>
                <p>此操作无法撤销，同时会清除当前设备上的账号缓存；已经下载的 JSON 备份文件不会被删除。</p>
                <p>服务器仍会保留一条不含求职内容的删除标记（tombstone），仅含平台生成的内部用户 ID（不含邮箱）、版本号和删除时间，用于阻止旧页面或旧设备恢复已清空内容。</p>
              </>
            )}
            {accountActionError && <p className="backup-import-error" role="alert">{accountActionError}</p>}
            {deleteNeedsRefresh ? (
              <div className="form-actions">
                <button type="button" className="primary-button" data-autofocus onClick={() => window.location.reload()}>
                  重新加载并核对
                </button>
              </div>
            ) : <div className="form-actions">
              <button
                key={`delete-back-${deleteConfirmationStep}`}
                type="button"
                className="secondary-button"
                disabled={deletingData}
                autoFocus={deleteConfirmationStep === 2}
                onClick={() => {
                  if (deleteConfirmationStep === 2) {
                    setDeleteConfirmationStep(1);
                  } else {
                    setDeleteDataOpen(false);
                  }
                  setAccountActionError('');
                }}
              >
                {deleteConfirmationStep === 2 ? '返回上一步' : '取消'}
              </button>
              {deleteConfirmationStep === 1 ? (
                <button key="delete-continue" type="button" className="secondary-button delete-continue-button" onClick={() => setDeleteConfirmationStep(2)}>
                  继续清空
                </button>
              ) : (
                <button key="delete-final" type="button" className="danger-button" disabled={deletingData} onClick={deletePersonalData}>
                  {deletingData ? '正在清空…' : '确认清空求职内容'}
                </button>
              )}
            </div>}
          </div>
        </Modal>
      )}
      <div className="toast-region" aria-live="polite" aria-atomic="true">
        {(syncStatus === 'error' || syncStatus === 'offline') && activeStorageKey && (
          <div className="toast toast-warning" role="alert">{SYNC_LABELS[syncStatus]}</div>
        )}
        {notice && <div className="toast" role="status" key={notice.id}>{notice.message}</div>}
      </div>
    </div>
  );
}

function ConfirmationDialog({
  target,
  companies,
  targetAccountLabel,
  onCancel,
  onConfirm,
}: {
  target: PendingConfirmation;
  companies: Company[];
  targetAccountLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  let title = '确认操作';
  let description = '';
  let warning = '';
  let confirmText = '确认';
  let destructive = false;

  if (target.kind === 'delete-company') {
    const company = companies.find((item) => item.id === target.companyId);
    title = '删除公司？';
    description = company
      ? `将删除“${company.name}”以及其下的 ${company.jobs.length} 个岗位。`
      : '将删除这家公司及其岗位。';
    warning = '此操作不可撤销。建议先导出备份，取消是默认的安全选择。';
    confirmText = '确认删除公司';
    destructive = true;
  } else if (target.kind === 'delete-job') {
    const company = companies.find((item) => item.id === target.companyId);
    const job = company?.jobs.find((item) => item.id === target.jobId);
    title = '删除岗位？';
    description = job ? `将删除“${company?.name} · ${job.title}”及其全部流程记录。` : '将删除这个岗位及其流程记录。';
    warning = '此操作不可撤销，其他岗位不会受影响。';
    confirmText = '确认删除岗位';
    destructive = true;
  } else if (target.kind === 'delete-event') {
    const company = companies.find((item) => item.id === target.companyId);
    const job = company?.jobs.find((item) => item.id === target.jobId);
    const processEvent = job?.process.find((item) => item.id === target.eventId);
    title = '删除流程记录？';
    description = processEvent ? `将删除“${processEvent.title}”这条记录。` : '将删除这条流程记录。';
    warning = '岗位当前阶段不会随历史记录一起改变。';
    confirmText = '确认删除记录';
    destructive = true;
  } else {
    const jobCount = target.companies.reduce((sum, company) => sum + company.jobs.length, 0);
    title = '导入并替换当前数据？';
    description = `备份包含 ${target.companies.length} 家公司和 ${jobCount} 个岗位。`;
    warning = `确认后会替换账号 ${targetAccountLabel} 中的全部公司、岗位与流程。建议先导出当前备份。`;
    confirmText = '确认导入并替换';
  }

  return (
    <Modal title={title} onClose={onCancel}>
      <div className="account-dialog-content">
        <p>{description}</p>
        <p className={destructive ? 'delete-warning' : 'confirmation-warning'}>{warning}</p>
        <div className="form-actions">
          <button type="button" className="secondary-button" data-autofocus onClick={onCancel}>取消</button>
          <button type="button" className={destructive ? 'danger-button' : 'primary-button'} onClick={onConfirm}>{confirmText}</button>
        </div>
      </div>
    </Modal>
  );
}

function PrivacyNotice() {
  return (
    <div className="privacy-notice">
      <section>
        <h3>数据如何保存</h3>
        <p>公司、岗位和招聘流程保存在云端数据库中，并绑定到登录平台提供的稳定用户 ID；邮箱或 GitHub 用户名只用于界面显示，不用于合并账号。</p>
      </section>
      <section>
        <h3>谁可以查看</h3>
        <p>每次读取、保存和删除都只操作当前登录用户 ID 对应的数据。ChatGPT 与 GitHub 登录不会按邮箱合并，即使属于同一人也会形成两个独立空间。其他用户无法通过自己的账号查看或修改你的记录，网站也不会把个人求职数据保存到 GitHub。</p>
      </section>
      <section>
        <h3>当前设备缓存</h3>
        <p>浏览器只为当前账号保留一份独立缓存，便于网络异常时继续使用；退出登录时会清除这份本机缓存。</p>
      </section>
      <section>
        <h3>智能分析</h3>
        <p>基础助手不调用模型。只有你主动选择“智能分析”并发送问题时，系统才会把当前问题和必要的结构化岗位信息发送给豆包；整体分析可能涉及当前账号的多个岗位，但不会发送备注正文。系统不会保存完整问题与回答，只记录调用时间、状态、Token、匿名会话轮次和“已解决／还需继续”评价。</p>
        <p>当你明确要求新增或删除单条公司、岗位时，模型只能生成待确认提案，不能直接写入。系统会暂存完成该提案所需的最少字段与加密确认凭证，提案 10 分钟后过期；取消、完成或失败后会清空提案内容。只有你在红色风险提示中再次确认，服务器校验账号、数据版本和目标记录后才会执行，并只保留不含公司、岗位或对话正文的安全事件与操作结果评价。</p>
      </section>
      <section>
        <h3>你的控制权</h3>
        <p>你可以随时导出 JSON 备份，或使用“清空求职内容”永久清空当前账号的云端求职记录和本机缓存。</p>
        <p>清空后仍会保留一条不含公司、岗位或流程内容的删除标记（tombstone），仅含平台生成的内部用户 ID（不含邮箱）、版本号和删除时间，用于阻止旧页面或旧设备恢复已清空内容。</p>
      </section>
    </div>
  );
}

function EmptyState({
  title,
  text,
  action,
  compact = false,
}: {
  title: string;
  text: string;
  action?: React.ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={`empty-state ${compact ? 'compact' : ''}`}>
      <strong>{title}</strong>
      <p>{text}</p>
      {action}
    </div>
  );
}

function Modal({
  title,
  children,
  onClose,
  wide = false,
  dismissible = true,
  busy = false,
  inactive = false,
  className = '',
  headerAction,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
  dismissible?: boolean;
  busy?: boolean;
  inactive?: boolean;
  className?: string;
  headerAction?: React.ReactNode;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  const dismissibleRef = useRef(dismissible);
  const inactiveRef = useRef(inactive);
  const lastFocusedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    onCloseRef.current = onClose;
    dismissibleRef.current = dismissible;
    inactiveRef.current = inactive;
  }, [dismissible, inactive, onClose]);

  useEffect(() => {
    const dialog = dialogRef.current;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog) return;

    const focusableSelector = [
      'button:not([disabled])',
      'a[href]',
      'input:not([disabled]):not([type="hidden"])',
      'select:not([disabled])',
      'textarea:not([disabled])',
      '[tabindex]:not([tabindex="-1"])',
    ].join(',');
    const frame = window.requestAnimationFrame(() => {
      const firstField = dialog.querySelector<HTMLElement>('[data-autofocus], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled])');
      (firstField ?? dialog.querySelector<HTMLElement>('button:not([disabled])') ?? dialog).focus();
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (inactiveRef.current) return;
      if (event.key === 'Escape') {
        if (!dismissibleRef.current) return;
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector))
        .filter((element) => element.offsetParent !== null);
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('keydown', handleKeyDown);
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (inactive) {
      if (document.activeElement instanceof HTMLElement && dialog.contains(document.activeElement)) {
        lastFocusedRef.current = document.activeElement;
      }
      return;
    }
    if (!lastFocusedRef.current?.isConnected) return;
    const frame = window.requestAnimationFrame(() => lastFocusedRef.current?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, [inactive]);

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      aria-hidden={inactive ? true : undefined}
      inert={inactive ? true : undefined}
      onPointerDown={(event) => {
        if (dismissible && !inactive && event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        tabIndex={-1}
        className={`modal ${wide ? 'modal-wide' : ''} ${className}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={busy || undefined}
        onFocusCapture={(event) => {
          if (event.target instanceof HTMLElement) lastFocusedRef.current = event.target;
        }}
      >
        <header>
          <div><p className="eyebrow">职序</p><h2 id={titleId}>{title}</h2></div>
          <div className="modal-header-actions">
            {headerAction}
            <button aria-label={dismissible ? '关闭' : '操作进行中，暂时无法关闭'} disabled={!dismissible} onClick={onClose}>{dismissible ? '关闭' : '处理中'}</button>
          </div>
        </header>
        {children}
      </section>
    </div>
  );
}

function FormActions({ onCancel, submitText }: { onCancel: () => void; submitText: string }) {
  return (
    <div className="form-actions">
      <button type="button" className="secondary-button" onClick={onCancel}>取消</button>
      <button type="submit" className="primary-button">{submitText}</button>
    </div>
  );
}

function SegmentedDateInput({
  value,
  onChange,
  error = '',
  errorId,
}: {
  value: string;
  onChange: (value: string) => void;
  error?: string;
  errorId?: string;
}) {
  const yearRef = useRef<HTMLInputElement>(null);
  const monthRef = useRef<HTMLInputElement>(null);
  const dayRef = useRef<HTMLInputElement>(null);
  const [year = '', month = '', day = ''] = value.split('-');

  const updatePart = (
    index: number,
    rawValue: string,
    maxLength: number,
    nextRef?: React.RefObject<HTMLInputElement | null>,
  ) => {
    const digits = rawValue.replace(/\D/g, '').slice(0, maxLength);
    const parts = [year, month, day];
    parts[index] = digits;
    onChange(parts.some(Boolean) ? parts.join('-') : '');
    if (digits.length === maxLength) nextRef?.current?.focus();
  };

  return (
    <div className="date-entry">
      <div
        className={`segmented-date ${error ? 'invalid' : ''}`}
        role="group"
        aria-label="投递日期，格式为年、月、日"
        aria-describedby={error ? errorId : undefined}
      >
        <input
          ref={yearRef}
          className="date-year"
          inputMode="numeric"
          autoComplete="off"
          aria-label="年份"
          aria-invalid={Boolean(error)}
          aria-describedby={error ? errorId : undefined}
          placeholder="YYYY"
          value={year}
          onChange={(event) => updatePart(0, event.target.value, 4, monthRef)}
          onPaste={(event) => {
            const pasted = event.clipboardData.getData('text').trim();
            const match = pasted.match(/^(\d{4})[\s/.-]?(\d{1,2})[\s/.-]?(\d{1,2})$/);
            if (!match) return;
            event.preventDefault();
            onChange(`${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`);
            dayRef.current?.focus();
          }}
        />
        <span className="date-separator" aria-hidden="true">/</span>
        <input
          ref={monthRef}
          inputMode="numeric"
          autoComplete="off"
          aria-label="月份"
          aria-invalid={Boolean(error)}
          aria-describedby={error ? errorId : undefined}
          placeholder="MM"
          value={month}
          onChange={(event) => updatePart(1, event.target.value, 2, dayRef)}
          onKeyDown={(event) => {
            if (event.key === 'Backspace' && !month) yearRef.current?.focus();
          }}
        />
        <span className="date-separator" aria-hidden="true">/</span>
        <input
          ref={dayRef}
          inputMode="numeric"
          autoComplete="off"
          aria-label="日期"
          aria-invalid={Boolean(error)}
          aria-describedby={error ? errorId : undefined}
          placeholder="DD"
          value={day}
          onChange={(event) => updatePart(2, event.target.value, 2)}
          onKeyDown={(event) => {
            if (event.key === 'Backspace' && !day) monthRef.current?.focus();
          }}
        />
      </div>
      <small className="date-hint">按年 / 月 / 日填写，输入完成后自动跳到下一项</small>
      {error && <small className="field-error" id={errorId} role="alert">{error}</small>}
    </div>
  );
}
