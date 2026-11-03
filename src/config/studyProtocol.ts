export const STUDY_PROTOCOL_VERSION = 'ACS-LOCAL-1.0';

/**
 * This text was supplied by the product owner for the current study.
 * Consent is collected as a separate, explicit workflow record by the app;
 * the model must not infer consent from clinical data.
 */
export const STUDY_PROTOCOL_CRITERIA = [
  '研究对象：急性冠脉综合征患者。',
  '纳入标准：',
  '1. 年龄 >= 18 周岁，男女不限。',
  '2. 根据《2023 ESC 急性冠脉综合征管理指南》符合急性心肌梗死诊断标准：典型胸痛持续 >= 20 分钟；心电图表现为 STEMI 或 NSTEMI；血清高敏肌钙蛋白至少一次超过参考值上限第 99 百分位数并伴有动态变化。',
  '3. 发病时间 < 24 小时就诊，拟进行 PCI 治疗。',
  '4. 患者或其监护人签署知情同意书。此项由 App 的独立同意环节记录，不由 AI 推断。',
  '排除标准：',
  '1. 存在 PCI 治疗禁忌症。',
  '2. 对麝香保心丸过敏、无法耐受，或存在其他无法完成试验药物用药的情况。',
  '3. 妊娠、准备妊娠或哺乳期妇女。',
  '4. 近 3 个月内参与其他临床研究。',
  '5. 研究者认为不适合进入本研究。',
  '资料未知、缺失或证据矛盾必须输出 MISSING_INFO，不能推断为符合。',
].join('\n');

