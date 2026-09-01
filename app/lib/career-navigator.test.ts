import assert from 'node:assert/strict';
import test from 'node:test';
import { buildNavigatorBriefing, parseNavigatorCommand, type NavigatorCompany } from './career-navigator.ts';

const companies: NavigatorCompany[] = [{
  id: 'company-a',
  name: '星河能源',
  shortName: '星河',
  jobs: [
    {
      id: 'job-a',
      title: '电力电子工程师',
      location: '上海',
      appliedAt: '2026-08-01',
      stage: '已投递',
      priority: '高',
      nextAction: '邮件跟进',
      nextDate: '2026-08-28',
      process: [{ date: '2026-08-01' }],
    },
    {
      id: 'job-b',
      title: '储能产品工程师',
      location: '深圳',
      appliedAt: '2026-08-27',
      stage: '一面',
      priority: '中',
      nextAction: '准备面试',
      nextDate: '2026-08-31',
      process: [{ date: '2026-08-27' }],
    },
  ],
}];

test('逾期和近期安排按紧急程度生成', () => {
  const briefing = buildNavigatorBriefing(companies, '2026-08-30');
  assert.equal(briefing.urgentCount, 2);
  assert.equal(briefing.urgentCount + briefing.attentionCount, briefing.insights.length);
  assert.equal(briefing.insights[0].category, 'overdue');
  assert.equal(briefing.insights[1].category, 'upcoming');
});

test('待完善统计包含 info 级建议并覆盖全部可见建议', () => {
  const incomplete: NavigatorCompany[] = [{
    id: 'company-example',
    name: '远岭智造',
    shortName: '远岭',
    jobs: [{
      id: 'job-example',
      title: '产品工程师',
      location: '',
      appliedAt: '',
      stage: '意向岗位',
      priority: '低',
      nextAction: '',
      nextDate: '',
      process: [],
    }],
  }];
  const briefing = buildNavigatorBriefing(incomplete, '2026-08-30');

  assert.equal(briefing.insights.length, 1);
  assert.equal(briefing.insights[0].severity, 'info');
  assert.equal(briefing.attentionCount, 1);
  assert.equal(briefing.urgentCount + briefing.attentionCount, briefing.insights.length);
});

test('被拒岗位不会生成普通提醒', () => {
  const rejected = structuredClone(companies);
  rejected[0].jobs[0].stage = '被拒';
  const briefing = buildNavigatorBriefing(rejected, '2026-08-30');
  assert.equal(briefing.insights.some((item) => item.jobId === 'job-a'), false);
});

test('写入和删除类自然语言被安全拒绝', () => {
  const result = parseNavigatorCommand('把星河能源删除', companies);
  assert.equal(result.status, 'safe-refusal');
  assert.equal(result.action, undefined);
});

test('面试查询返回只读概况动作', () => {
  const result = parseNavigatorCommand('查看面试岗位', companies);
  assert.deepEqual(result.action, { kind: 'show-metric', metric: 'interview' });
});

test('精确公司名称可以打开公司', () => {
  const result = parseNavigatorCommand('打开星河能源', companies);
  assert.deepEqual(result.action, { kind: 'open-company', companyId: 'company-a' });
});

test('精确岗位名称可以打开岗位', () => {
  const result = parseNavigatorCommand('查看储能产品工程师', companies);
  assert.deepEqual(result.action, { kind: 'open-job', companyId: 'company-a', jobId: 'job-b' });
});

test('自由搜索只设置筛选词，不修改数据', () => {
  const result = parseNavigatorCommand('搜索上海', companies);
  assert.deepEqual(result.action, { kind: 'set-query', query: '上海' });
});

test('无法识别的命令不猜测', () => {
  const result = parseNavigatorCommand('帮我决定人生方向', companies);
  assert.equal(result.status, 'unmatched');
  assert.equal(result.action, undefined);
});
