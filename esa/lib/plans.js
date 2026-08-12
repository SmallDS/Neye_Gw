import { AppError, sanitizeText } from './core.js';

const PLAN_CONFIG_KEY = 'v2_config_plans';

export const DEFAULT_PLAN_CONFIG = Object.freeze({
  configVersion: 1,
  salesEnabled: true,
  updatedAt: null,
  plans: Object.freeze({
    monthly: Object.freeze({
      id: 'monthly',
      name: '月付订阅',
      description: '一个自然月的 NEye 订阅服务',
      subject: 'NEye 月付订阅',
      priceFen: 990,
      periodUnit: 'month',
      periodCount: 1,
      enabled: true,
      recommended: false,
      timeoutMinutes: 30,
      version: 1,
    }),
    annual: Object.freeze({
      id: 'annual',
      name: '年付订阅',
      description: '一个自然年的 NEye 订阅服务',
      subject: 'NEye 年付订阅',
      priceFen: 9999,
      periodUnit: 'year',
      periodCount: 1,
      enabled: true,
      recommended: true,
      timeoutMinutes: 30,
      version: 1,
    }),
  }),
});

function cloneDefaultConfig() {
  return JSON.parse(JSON.stringify(DEFAULT_PLAN_CONFIG));
}

export async function getPlanConfig(store) {
  const stored = await store.getJson(PLAN_CONFIG_KEY);
  if (!stored || !stored.plans) return cloneDefaultConfig();
  return stored;
}

export function publicPlanConfig(config) {
  return {
    salesEnabled: config.salesEnabled === true,
    configVersion: config.configVersion,
    updatedAt: config.updatedAt,
    plans: Object.values(config.plans).map((plan) => ({
      id: plan.id,
      name: plan.name,
      description: plan.description,
      priceFen: plan.priceFen,
      periodUnit: plan.periodUnit,
      periodCount: plan.periodCount,
      enabled: plan.enabled === true,
      recommended: plan.recommended === true,
      version: plan.version,
    })),
  };
}

function validatePlan(input, previous) {
  const id = String(input.id || '');
  if (!['monthly', 'annual'].includes(id)) {
    throw new AppError(400, 'INVALID_PLAN', '订阅套餐无效。');
  }
  const expectedUnit = id === 'monthly' ? 'month' : 'year';
  const priceFen = Number(input.priceFen);
  const timeoutMinutes = Number(input.timeoutMinutes);
  if (!Number.isSafeInteger(priceFen) || priceFen < 1 || priceFen > 10000000000) {
    throw new AppError(400, 'INVALID_PLAN_PRICE', '套餐价格必须是有效的整数分金额。');
  }
  if (!Number.isSafeInteger(timeoutMinutes) || timeoutMinutes < 5 || timeoutMinutes > 1440) {
    throw new AppError(400, 'INVALID_PLAN_TIMEOUT', '待支付超时时间应在 5 到 1440 分钟之间。');
  }
  const name = sanitizeText(input.name, 40);
  const description = sanitizeText(input.description, 160);
  if (!name || !description) {
    throw new AppError(400, 'INVALID_PLAN_COPY', '套餐名称和说明不能为空。');
  }
  const changed = !previous
    || previous.name !== name
    || previous.description !== description
    || previous.priceFen !== priceFen
    || previous.enabled !== Boolean(input.enabled)
    || previous.recommended !== Boolean(input.recommended)
    || previous.timeoutMinutes !== timeoutMinutes;
  return {
    id,
    name,
    description,
    subject: ('NEye ' + name).slice(0, 128),
    priceFen,
    periodUnit: expectedUnit,
    periodCount: 1,
    enabled: Boolean(input.enabled),
    recommended: Boolean(input.recommended),
    timeoutMinutes,
    version: changed ? Number(previous?.version || 0) + 1 : previous.version,
  };
}

export async function updatePlanConfig(store, input) {
  if (!Array.isArray(input.plans) || input.plans.length !== 2) {
    throw new AppError(400, 'INVALID_PLAN_CONFIG', '请同时提交月付和年付套餐。');
  }
  const current = await getPlanConfig(store);
  const nextPlans = {};
  for (const planInput of input.plans) {
    const id = String(planInput.id || '');
    if (nextPlans[id]) throw new AppError(400, 'DUPLICATE_PLAN', '套餐配置存在重复项。');
    nextPlans[id] = validatePlan(planInput, current.plans[id]);
  }
  if (!nextPlans.monthly || !nextPlans.annual) {
    throw new AppError(400, 'INVALID_PLAN_CONFIG', '请同时提交月付和年付套餐。');
  }
  const recommended = Object.values(nextPlans).filter((plan) => plan.enabled && plan.recommended);
  if (recommended.length > 1) {
    throw new AppError(400, 'MULTIPLE_RECOMMENDED_PLANS', '最多只能推荐一个已启用套餐。');
  }
  const salesEnabled = Boolean(input.salesEnabled);
  if (salesEnabled && !Object.values(nextPlans).some((plan) => plan.enabled)) {
    throw new AppError(400, 'NO_ENABLED_PLAN', '开启销售前至少需要启用一个套餐。');
  }
  const changed = salesEnabled !== current.salesEnabled
    || Object.values(nextPlans).some((plan) => plan.version !== current.plans[plan.id].version);
  const next = {
    configVersion: changed ? Number(current.configVersion || 0) + 1 : current.configVersion,
    salesEnabled,
    updatedAt: changed ? new Date().toISOString() : current.updatedAt,
    plans: nextPlans,
  };
  await store.putJson(PLAN_CONFIG_KEY, next);
  if (changed) {
    await Promise.all(Object.values(nextPlans).map((plan) => (
      store.putJson('v2_plan_version_' + plan.id + '_' + plan.version, plan)
    )));
  }
  return next;
}

export function planSnapshot(plan) {
  return {
    id: plan.id,
    name: plan.name,
    description: plan.description,
    subject: plan.subject,
    priceFen: plan.priceFen,
    periodUnit: plan.periodUnit,
    periodCount: plan.periodCount,
    timeoutMinutes: plan.timeoutMinutes,
    version: plan.version,
  };
}