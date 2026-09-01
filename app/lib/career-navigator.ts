import { isInactiveStage, type Stage } from './domain.ts';

export const NAVIGATOR_NAME = '职程领航';
export const NAVIGATOR_ENGLISH_NAME = 'Career Pipeline Navigator';

export type NavigatorSeverity = 'urgent' | 'attention' | 'info';
export type NavigatorCategory = 'overdue' | 'upcoming' | 'stale' | 'incomplete' | 'momentum';

export type NavigatorJob = {
  id: string;
  title: string;
  location: string;
  appliedAt: string;
  stage: Stage;
  priority: '高' | '中' | '低';
  nextAction: string;
  nextDate: string;
  process: Array<{ date: string }>;
};

export type NavigatorCompany = {
  id: string;
  name: string;
  shortName: string;
  jobs: NavigatorJob[];
};

export type NavigatorAction =
  | { kind: 'open-job'; companyId: string; jobId: string }
  | { kind: 'edit-job'; companyId: string; jobId: string }
  | { kind: 'open-company'; companyId: string }
  | { kind: 'show-metric'; metric: 'active' | 'interview' | 'offer' | 'all' }
  | { kind: 'filter-stage'; stage: Stage }
  | { kind: 'set-query'; query: string }
  | { kind: 'add-company' }
  | { kind: 'add-opportunity' }
  | { kind: 'show-insights' };

export type NavigatorInsight = {
  id: string;
  severity: NavigatorSeverity;
  category: NavigatorCategory;
  title: string;
  detail: string;
  evidence: string;
  actionLabel: string;
  action: NavigatorAction;
  companyId: string;
  companyName: string;
  jobId: string;
  jobTitle: string;
  sortDate: string;
};

export type NavigatorBriefing = {
  insights: NavigatorInsight[];
  urgentCount: number;
  attentionCount: number;
  activeCount: number;
  healthLabel: string;
  summary: string;
};

export type NavigatorCommandResult = {
  status: 'matched' | 'ambiguous' | 'safe-refusal' | 'unmatched';
  message: string;
  action?: NavigatorAction;
  candidates?: string[];
};

type FlatNavigatorJob = NavigatorJob & { companyId: string; companyName: string };

const DAY_MS = 86_400_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function validIsoDate(value: string) {
  if (!ISO_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function daysBetween(from: string, to: string) {
  if (!validIsoDate(from) || !validIsoDate(to)) return null;
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

function addDays(value: string, amount: number) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function latestActivity(job: NavigatorJob) {
  return [job.appliedAt, ...job.process.map((item) => item.date)]
    .filter(validIsoDate)
    .sort((a, b) => b.localeCompare(a))[0] ?? '';
}

function staleThreshold(stage: Stage) {
  if (stage === '进入人才库') return 30;
  if (stage === '一面' || stage === '后续面试') return 5;
  if (stage === '已投递') return 7;
  return 14;
}

function flattenCompanies(companies: NavigatorCompany[]): FlatNavigatorJob[] {
  return companies.flatMap((company) => company.jobs.map((job) => ({
    ...job,
    companyId: company.id,
    companyName: company.name,
  })));
}

function insightBase(job: FlatNavigatorJob) {
  return {
    companyId: job.companyId,
    companyName: job.companyName,
    jobId: job.id,
    jobTitle: job.title,
  };
}

export function buildNavigatorBriefing(
  companies: NavigatorCompany[],
  today: string,
): NavigatorBriefing {
  const jobs = flattenCompanies(companies);
  const activeJobs = jobs.filter((job) => !isInactiveStage(job.stage));
  const insights: NavigatorInsight[] = [];
  const soonLimit = addDays(today, 3);

  for (const job of activeJobs) {
    const base = insightBase(job);
    const isOverdue = validIsoDate(job.nextDate) && job.nextDate < today;
    const isUpcoming = validIsoDate(job.nextDate) && job.nextDate >= today && job.nextDate <= soonLimit;

    if (isOverdue) {
      const overdueDays = Math.abs(daysBetween(job.nextDate, today) ?? 0);
      insights.push({
        ...base,
        id: `overdue:${job.companyId}:${job.id}`,
        severity: 'urgent',
        category: 'overdue',
        title: `${job.nextAction.trim() || '下一步行动'}已逾期 ${overdueDays} 天`,
        detail: `${job.companyName} · ${job.title}`,
        evidence: `计划日期为 ${job.nextDate}，当前阶段是“${job.stage}”。`,
        actionLabel: '更新安排',
        action: { kind: 'edit-job', companyId: job.companyId, jobId: job.id },
        sortDate: job.nextDate,
      });
    } else if (isUpcoming) {
      const days = daysBetween(today, job.nextDate) ?? 0;
      insights.push({
        ...base,
        id: `upcoming:${job.companyId}:${job.id}`,
        severity: days <= 1 ? 'urgent' : 'attention',
        category: 'upcoming',
        title: days === 0 ? '今天有一项安排' : days === 1 ? '明天有一项安排' : `${days} 天后有一项安排`,
        detail: `${job.nextAction.trim() || '跟进岗位进度'} · ${job.companyName}`,
        evidence: `${job.title}，计划日期为 ${job.nextDate}。`,
        actionLabel: '查看岗位',
        action: { kind: 'open-job', companyId: job.companyId, jobId: job.id },
        sortDate: job.nextDate,
      });
    }

    if (!job.nextAction.trim() || !validIsoDate(job.nextDate)) {
      const missing = [!job.nextAction.trim() ? '下一步' : '', !validIsoDate(job.nextDate) ? '日期' : '']
        .filter(Boolean)
        .join('和');
      insights.push({
        ...base,
        id: `incomplete:${job.companyId}:${job.id}`,
        severity: job.priority === '高' ? 'attention' : 'info',
        category: 'incomplete',
        title: `还没有设置${missing}`,
        detail: `${job.companyName} · ${job.title}`,
        evidence: `这是${job.priority}优先级岗位，当前阶段是“${job.stage}”。`,
        actionLabel: '补充安排',
        action: { kind: 'edit-job', companyId: job.companyId, jobId: job.id },
        sortDate: '9999-12-31',
      });
    }

    const activity = latestActivity(job);
    const inactiveDays = activity ? daysBetween(activity, today) : null;
    const threshold = staleThreshold(job.stage);
    if (!isOverdue && inactiveDays !== null && inactiveDays >= threshold) {
      insights.push({
        ...base,
        id: `stale:${job.companyId}:${job.id}`,
        severity: job.priority === '高' ? 'attention' : 'info',
        category: 'stale',
        title: `${inactiveDays} 天没有记录新进展`,
        detail: `${job.companyName} · ${job.title}`,
        evidence: `“${job.stage}”阶段建议在 ${threshold} 天内复查一次。`,
        actionLabel: '查看并跟进',
        action: { kind: 'open-job', companyId: job.companyId, jobId: job.id },
        sortDate: activity,
      });
    }

    if (job.stage !== '意向岗位' && !validIsoDate(job.appliedAt)) {
      insights.push({
        ...base,
        id: `applied-date:${job.companyId}:${job.id}`,
        severity: 'info',
        category: 'incomplete',
        title: '申请日期还未补全',
        detail: `${job.companyName} · ${job.title}`,
        evidence: `当前已经进入“${job.stage}”，补全日期后时间线会更准确。`,
        actionLabel: '补充日期',
        action: { kind: 'edit-job', companyId: job.companyId, jobId: job.id },
        sortDate: '9999-12-31',
      });
    }
  }

  const severityOrder: Record<NavigatorSeverity, number> = { urgent: 0, attention: 1, info: 2 };
  insights.sort((a, b) =>
    severityOrder[a.severity] - severityOrder[b.severity]
    || a.sortDate.localeCompare(b.sortDate)
    || a.companyName.localeCompare(b.companyName, 'zh-CN'),
  );

  const seenJobs = new Set<string>();
  const focusedInsights = insights.filter((item) => {
    const key = `${item.companyId}:${item.jobId}`;
    if (seenJobs.has(key)) return false;
    seenJobs.add(key);
    return true;
  });

  const urgentCount = focusedInsights.filter((item) => item.severity === 'urgent').length;
  const attentionCount = focusedInsights.length - urgentCount;
  const healthLabel = urgentCount ? '需要优先处理' : attentionCount ? '有事项待完善' : '节奏清晰';
  const summary = !activeJobs.length
    ? '添加岗位后，我会根据日期、阶段和下一步安排生成建议。'
    : urgentCount
      ? `发现 ${urgentCount} 项需要尽快处理的安排。`
      : attentionCount
        ? `当前没有逾期，另有 ${attentionCount} 项值得完善。`
        : '当前没有紧急事项，可以按计划继续推进。';

  return { insights: focusedInsights, urgentCount, attentionCount, activeCount: activeJobs.length, healthLabel, summary };
}

function normalizeCommand(value: string) {
  return value.trim().toLocaleLowerCase().replace(/[，。！？、,.!?]/g, ' ').replace(/\s+/g, ' ');
}

export function parseNavigatorCommand(
  input: string,
  companies: NavigatorCompany[],
): NavigatorCommandResult {
  const normalized = normalizeCommand(input);
  if (!normalized) return { status: 'unmatched', message: '输入一个目标，例如“查看面试岗位”或“打开星澜能源”。' };

  if (/(删除|清空|覆盖|改成|设为|推进到|退回)/.test(normalized)) {
    return {
      status: 'safe-refusal',
      message: '为避免误改，我不会直接执行这类写入。请先打开对应岗位，在表单中核对后保存。',
    };
  }

  if (/(今日|今天|建议|待办|逾期|近期)/.test(normalized)) {
    return { status: 'matched', message: '已定位到今日建议。', action: { kind: 'show-insights' } };
  }
  if (/(面试)/.test(normalized)) {
    return { status: 'matched', message: '已显示一面及后续面试岗位。', action: { kind: 'show-metric', metric: 'interview' } };
  }
  if (/(offer|录用)/i.test(normalized)) {
    return { status: 'matched', message: '已显示 Offer 岗位。', action: { kind: 'show-metric', metric: 'offer' } };
  }
  if (/(进行中|推进中)/.test(normalized)) {
    return { status: 'matched', message: '已显示进行中的岗位。', action: { kind: 'show-metric', metric: 'active' } };
  }
  if (/(全部岗位|所有岗位)/.test(normalized)) {
    return { status: 'matched', message: '已显示全部岗位。', action: { kind: 'show-metric', metric: 'all' } };
  }

  const stageMatch = (['意向岗位', '已投递', '测评/笔试', '一面', '后续面试', '进入人才库', '被拒', '已结束'] as Stage[])
    .find((stage) => normalized.includes(stage.toLocaleLowerCase()));
  if (stageMatch) {
    return { status: 'matched', message: `已按“${stageMatch}”筛选。`, action: { kind: 'filter-stage', stage: stageMatch } };
  }

  if (normalized === '添加公司' || normalized === '新建公司') {
    return { status: 'matched', message: '已打开公司表单。', action: { kind: 'add-company' } };
  }
  if (normalized === '添加岗位' || normalized === '添加机会' || normalized === '新建岗位') {
    return { status: 'matched', message: '已打开添加机会。', action: { kind: 'add-opportunity' } };
  }

  const searchMatch = normalized.match(/^(?:搜索|查找)\s*(.+)$/);
  if (searchMatch?.[1]) {
    return { status: 'matched', message: `已搜索“${searchMatch[1]}”。`, action: { kind: 'set-query', query: searchMatch[1] } };
  }

  const targetMatch = normalized.match(/^(?:打开|查看|进入)\s*(.+)$/);
  if (targetMatch?.[1]) {
    const target = targetMatch[1];
    const jobMatches = flattenCompanies(companies).filter((job) =>
      normalizeCommand(job.title).includes(target)
      || target.includes(normalizeCommand(job.title)),
    );
    const companyMatches = companies.filter((company) => {
      const names = [company.name, company.shortName].map(normalizeCommand).filter(Boolean);
      return names.some((name) => name.includes(target) || target.includes(name));
    });

    if (jobMatches.length === 1) {
      const job = jobMatches[0];
      return {
        status: 'matched',
        message: `已打开“${job.companyName} · ${job.title}”。`,
        action: { kind: 'open-job', companyId: job.companyId, jobId: job.id },
      };
    }
    if (!jobMatches.length && companyMatches.length === 1) {
      return {
        status: 'matched',
        message: `已打开“${companyMatches[0].name}”。`,
        action: { kind: 'open-company', companyId: companyMatches[0].id },
      };
    }
    const candidates = [
      ...jobMatches.map((job) => `${job.companyName} · ${job.title}`),
      ...companyMatches.map((company) => company.name),
    ];
    if (candidates.length > 1) {
      return { status: 'ambiguous', message: '找到多个可能目标，请输入更完整的公司或岗位名称。', candidates };
    }
  }

  return {
    status: 'unmatched',
    message: '暂时没有识别这句话。可以试试“查看面试岗位”“搜索上海”或“打开公司名”。',
  };
}
