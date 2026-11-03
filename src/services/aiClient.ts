import { getAiSettings } from './settings';
import { bytesToBase64, encryptedImageMimeType, readEncryptedImage } from '../storage/secureFiles';
import { STUDY_PROTOCOL_CRITERIA, STUDY_PROTOCOL_VERSION } from '../config/studyProtocol';
import type { AiResult, Screening } from '../types';

export class AiConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiConfigurationError';
  }
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part && typeof part === 'object' && 'text' in part) {
          return String((part as { text: unknown }).text);
        }
        return '';
      })
      .join('\n');
  }
  throw new Error('AI 响应缺少文本内容。');
}

function parseJsonObject(text: string): unknown {
  const fence = String.fromCharCode(96).repeat(3);
  let clean = text.trim();
  if (clean.startsWith(fence)) {
    clean = clean.slice(fence.length).replace(/^json\s*/i, '');
    if (clean.endsWith(fence)) clean = clean.slice(0, -fence.length);
  }
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('AI 响应不是有效 JSON。');
  return JSON.parse(clean.slice(start, end + 1)) as unknown;
}

function validateAiResult(value: unknown): AiResult {
  if (!value || typeof value !== 'object') throw new Error('AI 返回结果格式错误。');
  const result = value as Record<string, unknown>;
  const verdict = result.verdict;
  if (!['ELIGIBLE', 'MISSING_INFO', 'INELIGIBLE'].includes(String(verdict))) {
    throw new Error('AI 返回了未知资格结论。');
  }
  const asStringArray = (input: unknown): string[] =>
    Array.isArray(input) ? input.map((item) => String(item)) : [];
  const evidence = Array.isArray(result.evidence)
    ? result.evidence.map((item) => {
        const entry = (item ?? {}) as Record<string, unknown>;
        return {
          criterion: String(entry.criterion ?? ''),
          finding: String(entry.finding ?? ''),
          source: String(entry.source ?? ''),
        };
      })
    : [];
  const confidence =
    typeof result.confidence === 'number' &&
    Number.isFinite(result.confidence) &&
    result.confidence >= 0 &&
    result.confidence <= 1
      ? result.confidence
      : undefined;
  return {
    verdict: verdict as AiResult['verdict'],
    summary: String(result.summary ?? ''),
    reasons: asStringArray(result.reasons),
    missing_fields: asStringArray(result.missing_fields),
    evidence,
    confidence,
  };
}

export async function analyzeEligibility(screening: Screening): Promise<AiResult> {
  if (!STUDY_PROTOCOL_CRITERIA.trim()) {
    throw new AiConfigurationError('研究方案资格标准尚未配置，暂不能执行 AI 审核。');
  }
  if (!screening.ecgPath) throw new AiConfigurationError('请先上传心电图。');
  const settings = await getAiSettings();
  if (!settings.apiKey.trim()) throw new AiConfigurationError('请先在“我的”页面填写 AI API Key。');
  if (!settings.model.trim()) throw new AiConfigurationError('AI 模型名称不能为空。');

  const imageBytes = await readEncryptedImage(screening.ecgPath);
  if (imageBytes.length > 20 * 1024 * 1024) {
    throw new AiConfigurationError('心电图图片过大，请选择 20 MB 以内的图片。');
  }
  const imageData = await bytesToBase64(imageBytes);
  const mimeType = encryptedImageMimeType(screening.ecgPath);
  const baseUrl = settings.baseUrl.replace(/\/+$/, '');
  const endpoint = baseUrl.endsWith('/v1')
    ? baseUrl + '/chat/completions'
    : baseUrl + '/v1/chat/completions';

  const systemPrompt = [
    '你是临床研究的资格预筛辅助系统。严格根据下列研究方案评估，不得补造阈值或事实。',
    '研究方案版本：' + STUDY_PROTOCOL_VERSION,
    STUDY_PROTOCOL_CRITERIA,
    '同意状态由 App 独立记录，不要从图片或临床字段推断患者是否同意。',
    '每项标准须基于输入证据评估。缺失、矛盾、心电图无法辨认或证据不足时 verdict 必须为 MISSING_INFO。',
    '只有存在明确证据满足全部临床纳入条件且未命中任何排除条件时才可输出 ELIGIBLE。',
    '存在明确排除条件或明确未满足的纳入条件时输出 INELIGIBLE。',
    '只输出一个 JSON 对象，不要 Markdown，字段为 verdict、summary、reasons、missing_fields、evidence、confidence。',
    'verdict 仅允许 ELIGIBLE、MISSING_INFO、INELIGIBLE；evidence 是包含 criterion、finding、source 的数组；confidence 为 0 到 1。',
  ].join('\n\n');

  const userText = [
    '请评估这名患者的预筛资格。',
    '年龄：' + screening.age,
    '性别：' + screening.gender,
    '症状及持续时间：' + (screening.clinical.symptoms || '未提供'),
    'STEMI / NSTEMI 诊断信息：' + (screening.clinical.diagnosis || '未提供'),
    '高敏肌钙蛋白及动态变化：' + (screening.clinical.troponin || '未提供'),
    '发病至就诊时间：' + (screening.clinical.onsetToPresentation || '未提供'),
    'PCI 治疗计划：' + (screening.clinical.pciPlan || '未提供'),
    'PCI 禁忌证：' + (screening.clinical.pciContraindications || '未提供'),
    '试验药物过敏 / 不耐受：' + (screening.clinical.drugAllergy || '未提供'),
    '妊娠、备孕或哺乳：' + (screening.clinical.pregnancyStatus || '未提供'),
    '近 3 个月其他临床研究：' + (screening.clinical.otherTrials || '未提供'),
    '研究者判断：' + (screening.clinical.investigatorNotes || '未提供'),
  ].join('\n');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90000);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: 'Bearer ' + settings.apiKey.trim(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: settings.model,
        temperature: 0,
        max_tokens: 1600,
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: [
              { type: 'text', text: userText },
              {
                type: 'image_url',
                image_url: {
                  url: 'data:' + mimeType + ';base64,' + imageData,
                  detail: 'high',
                },
              },
            ],
          },
        ],
      }),
    });

    const responseBody = await response.text();
    if (!response.ok) {
      throw new Error('AI 服务返回 HTTP ' + response.status + '。请检查 API Key、额度和服务地址。');
    }
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(responseBody) as Record<string, unknown>;
    } catch {
      throw new Error('AI 服务返回了无法解析的响应。');
    }
    const choices = payload.choices as Array<Record<string, unknown>> | undefined;
    const message = choices?.[0]?.message as Record<string, unknown> | undefined;
    const content = extractText(message?.content);
    return validateAiResult(parseJsonObject(content));
  } catch (error) {
    if (error instanceof AiConfigurationError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('AI 分析超时。请确认网络后重试。');
    }
    throw error instanceof Error ? error : new Error('AI 分析失败。');
  } finally {
    clearTimeout(timeout);
  }
}

