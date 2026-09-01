export const STAGES = [
  '意向岗位',
  '已投递',
  '测评/笔试',
  '一面',
  '后续面试',
  'Offer',
  '进入人才库',
  '被拒',
  '已结束',
] as const;

export type Stage = (typeof STAGES)[number];

export const CORE_STAGES: readonly Stage[] = STAGES.slice(0, 6);

export function isInactiveStage(stage: Stage) {
  return stage === '被拒' || stage === '已结束';
}

export function normalizeIdentityPart(value: string) {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, ' ');
}

export function jobIdentityKey(title: string, location: string) {
  return `${normalizeIdentityPart(title)}::${normalizeIdentityPart(location)}`;
}
