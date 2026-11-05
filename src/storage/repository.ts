import * as Crypto from 'expo-crypto';
import { getDatabase } from './database';
import { patientFingerprint } from './identity';
import { addCalendarMonthsClamped, getFollowupStatus, parseLocalDate, dateKey } from '../domain/dates';
import { EMPTY_CLINICAL_INFO } from '../types';
import type {
  AiResult,
  AnalysisRun,
  ClinicalInfo,
  ConsentDecision,
  DashboardSummary,
  FollowupTask,
  Gender,
  Patient,
  Screening,
  ScreeningStatus,
} from '../types';

type ScreeningRow = {
  id: string;
  name: string;
  age: number;
  gender: Gender;
  clinical_json: string;
  ecg_path: string;
  status: ScreeningStatus;
  version: number;
  created_at: string;
  updated_at: string;
};

type PatientRow = {
  id: string;
  screening_id: string;
  patient_number: string;
  name: string;
  age: number;
  gender: Gender;
  phone: string;
  group_name: '用药组' | '不用药组';
  enrollment_at: string;
  enrolled_by: string;
  notes: string;
  status: 'ACTIVE' | 'EXITED';
  exited_at: string | null;
};

function parseResult(json?: string | null): AiResult | undefined {
  if (!json) return undefined;
  try {
    return JSON.parse(json) as AiResult;
  } catch {
    return undefined;
  }
}

async function addAudit(
  database: Awaited<ReturnType<typeof getDatabase>>,
  action: string,
  entityType: string,
  entityId: string,
  actor: string,
  details: Record<string, unknown> = {},
): Promise<void> {
  await database.runAsync(
    'INSERT INTO audit_event(id, action, entity_type, entity_id, actor, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    Crypto.randomUUID(),
    action,
    entityType,
    entityId,
    actor,
    JSON.stringify(details),
    new Date().toISOString(),
  );
}

async function getLatestAnalysis(
  screeningId: string,
): Promise<AnalysisRun | undefined> {
  const database = await getDatabase();
  const row = await database.getFirstAsync<{
    id: string;
    screening_id: string;
    input_version: number;
    model: string;
    protocol_version: string;
    verdict: string;
    result_json: string | null;
    error: string | null;
    created_at: string;
  }>(
    'SELECT * FROM ai_analysis_run WHERE screening_id = ? ORDER BY created_at DESC LIMIT 1',
    screeningId,
  );
  if (!row) return undefined;
  return {
    id: row.id,
    screeningId: row.screening_id,
    inputVersion: row.input_version,
    model: row.model,
    protocolVersion: row.protocol_version,
    verdict: row.verdict as AnalysisRun['verdict'],
    result: parseResult(row.result_json),
    error: row.error ?? undefined,
    createdAt: row.created_at,
  };
}

function mapScreening(row: ScreeningRow, latestAnalysis?: AnalysisRun): Screening {
  return {
    id: row.id,
    name: row.name,
    age: row.age,
    gender: row.gender,
    clinical: JSON.parse(row.clinical_json) as ClinicalInfo,
    ecgPath: row.ecg_path,
    status: row.status,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    latestAnalysis,
  };
}

function mapPatient(row: PatientRow): Patient {
  return {
    id: row.id,
    screeningId: row.screening_id,
    patientNumber: row.patient_number,
    name: row.name,
    age: row.age,
    gender: row.gender,
    phone: row.phone,
    groupName: row.group_name,
    enrollmentAt: row.enrollment_at,
    enrolledBy: row.enrolled_by,
    notes: row.notes,
    status: row.status,
    exitedAt: row.exited_at ?? undefined,
  };
}

export async function createScreening(
  actor: string,
  clinical: ClinicalInfo,
): Promise<string> {
  const database = await getDatabase();
  const id = Crypto.randomUUID();
  const now = new Date().toISOString();
  await database.runAsync(
    'INSERT INTO screening_case(id, name, age, gender, clinical_json, ecg_path, status, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id,
    '',
    0,
    '其他',
    JSON.stringify(clinical),
    '',
    'DRAFT',
    1,
    now,
    now,
  );
  await addAudit(database, 'SCREENING_CREATED', 'screening', id, actor);
  return id;
}

export async function saveScreeningDraft(
  id: string,
  input: {
    name: string;
    age: number;
    gender: Gender;
    clinical: ClinicalInfo;
    ecgPath: string;
  },
  actor: string,
): Promise<void> {
  const database = await getDatabase();
  const now = new Date().toISOString();
  await database.runAsync(
    'UPDATE screening_case SET name = ?, age = ?, gender = ?, clinical_json = ?, ecg_path = ?, status = ?, version = version + 1, updated_at = ? WHERE id = ?',
    input.name.trim(),
    input.age,
    input.gender,
    JSON.stringify(input.clinical),
    input.ecgPath,
    'DRAFT',
    now,
    id,
  );
  await addAudit(database, 'SCREENING_UPDATED', 'screening', id, actor);
}

export async function skipAiAnalysis(screeningId: string, actor: string): Promise<void> {
  const database = await getDatabase();
  const now = new Date().toISOString();
  const result = await database.runAsync(
    'UPDATE screening_case SET status = ?, updated_at = ? WHERE id = ? AND status = ?',
    'AI_SKIPPED',
    now,
    screeningId,
    'DRAFT',
  );
  if (result.changes === 0) throw new Error('当前预筛状态不允许跳过 AI。请返回资料页后重试。');
  await addAudit(database, 'AI_ANALYSIS_SKIPPED', 'screening', screeningId, actor, {
    reason: '用户选择跳过 AI 预筛，后续由授权人员人工核实资格',
  });
}

export async function getScreening(id: string): Promise<Screening | undefined> {
  const database = await getDatabase();
  const row = await database.getFirstAsync<ScreeningRow>(
    'SELECT * FROM screening_case WHERE id = ?',
    id,
  );
  if (!row) return undefined;
  return mapScreening(row, await getLatestAnalysis(id));
}

export async function listAnalysisHistory(screeningId: string): Promise<AnalysisRun[]> {
  const database = await getDatabase();
  const rows = await database.getAllAsync<{
    id: string;
    screening_id: string;
    input_version: number;
    model: string;
    protocol_version: string;
    verdict: string;
    result_json: string | null;
    error: string | null;
    created_at: string;
  }>(
    'SELECT * FROM ai_analysis_run WHERE screening_id = ? ORDER BY created_at DESC',
    screeningId,
  );
  return rows.map((row) => ({
    id: row.id,
    screeningId: row.screening_id,
    inputVersion: row.input_version,
    model: row.model,
    protocolVersion: row.protocol_version,
    verdict: row.verdict as AnalysisRun['verdict'],
    result: parseResult(row.result_json),
    error: row.error ?? undefined,
    createdAt: row.created_at,
  }));
}

export async function listScreenings(): Promise<Screening[]> {
  const database = await getDatabase();
  const rows = await database.getAllAsync<ScreeningRow>(
    'SELECT * FROM screening_case WHERE status NOT IN (?, ?) ORDER BY updated_at DESC LIMIT 100',
    'ENROLLED',
    'CLOSED',
  );
  return Promise.all(
    rows.map(async (row) => mapScreening(row, await getLatestAnalysis(row.id))),
  );
}

export async function beginAnalysis(
  screening: Screening,
  model: string,
  protocolVersion: string,
  actor: string,
): Promise<{ analysisId: string; revisionId: string }> {
  const database = await getDatabase();
  const revisionId = Crypto.randomUUID();
  const analysisId = Crypto.randomUUID();
  let effectiveRevisionId = revisionId;
  const now = new Date().toISOString();
  const snapshot = {
    name: screening.name,
    age: screening.age,
    gender: screening.gender,
    clinical: screening.clinical,
    ecgPath: screening.ecgPath,
  };
  await database.withTransactionAsync(async () => {
    const existingRevision = await database.getFirstAsync<{ id: string }>(
      'SELECT id FROM screening_revision WHERE screening_id = ? AND version = ? LIMIT 1',
      screening.id,
      screening.version,
    );
    effectiveRevisionId = existingRevision?.id ?? revisionId;
    if (!existingRevision) {
      await database.runAsync(
        'INSERT INTO screening_revision(id, screening_id, version, data_json, ecg_path, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        effectiveRevisionId,
        screening.id,
        screening.version,
        JSON.stringify(snapshot),
        screening.ecgPath,
        now,
      );
    }
    await database.runAsync(
      'INSERT INTO ai_analysis_run(id, screening_id, revision_id, input_version, model, protocol_version, verdict, result_json, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      analysisId,
      screening.id,
      effectiveRevisionId,
      screening.version,
      model,
      protocolVersion,
      'RUNNING',
      null,
      null,
      now,
    );
    await database.runAsync(
      'UPDATE screening_case SET status = ?, updated_at = ? WHERE id = ?',
      'ANALYZING',
      now,
      screening.id,
    );
    await addAudit(database, 'AI_ANALYSIS_STARTED', 'screening', screening.id, actor, {
      analysisId,
      inputVersion: screening.version,
      model,
      protocolVersion,
    });
  });
  return { analysisId, revisionId: effectiveRevisionId };
}

export async function recoverInterruptedAnalyses(): Promise<void> {
  const database = await getDatabase();
  const now = new Date().toISOString();
  await database.withTransactionAsync(async () => {
    const interrupted = await database.getAllAsync<{ id: string; screening_id: string }>(
      'SELECT id, screening_id FROM ai_analysis_run WHERE verdict = ?',
      'RUNNING',
    );
    if (interrupted.length === 0) return;
    await database.runAsync(
      'UPDATE ai_analysis_run SET verdict = ?, error = ? WHERE verdict = ?',
      'FAILED',
      'App 上次未能完成 AI 分析。资料仍保存在本机，可重新提交。',
      'RUNNING',
    );
    for (const screeningId of new Set(interrupted.map((run) => run.screening_id))) {
      await database.runAsync(
        'UPDATE screening_case SET status = ?, updated_at = ? WHERE id = ? AND status = ?',
        'ANALYSIS_FAILED',
        now,
        screeningId,
        'ANALYZING',
      );
    }
  });
}

export async function finishAnalysis(
  analysisId: string,
  screeningId: string,
  result: AiResult,
): Promise<void> {
  const database = await getDatabase();
  const screeningStatus: ScreeningStatus =
    result.verdict === 'ELIGIBLE'
      ? 'PRELIMINARY_PASS'
      : result.verdict === 'INELIGIBLE'
        ? 'INELIGIBLE'
        : 'MISSING_INFO';
  await database.withTransactionAsync(async () => {
    await database.runAsync(
      'UPDATE ai_analysis_run SET verdict = ?, result_json = ?, error = NULL WHERE id = ?',
      result.verdict,
      JSON.stringify(result),
      analysisId,
    );
    await database.runAsync(
      'UPDATE screening_case SET status = ?, updated_at = ? WHERE id = ?',
      screeningStatus,
      new Date().toISOString(),
      screeningId,
    );
  });
}

export async function failAnalysis(
  analysisId: string,
  screeningId: string,
  message: string,
): Promise<void> {
  const database = await getDatabase();
  await database.withTransactionAsync(async () => {
    await database.runAsync(
      'UPDATE ai_analysis_run SET verdict = ?, error = ? WHERE id = ?',
      'FAILED',
      message.slice(0, 500),
      analysisId,
    );
    await database.runAsync(
      'UPDATE screening_case SET status = ?, updated_at = ? WHERE id = ?',
      'ANALYSIS_FAILED',
      new Date().toISOString(),
      screeningId,
    );
  });
}

export async function acknowledgeMissingInformation(
  screeningId: string,
  analysisId: string,
  missingFields: string[],
  actor: string,
): Promise<void> {
  const database = await getDatabase();
  await database.runAsync(
    'INSERT INTO missing_acknowledgement(id, screening_id, analysis_id, missing_fields_json, actor, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    Crypto.randomUUID(),
    screeningId,
    analysisId,
    JSON.stringify(missingFields),
    actor,
    new Date().toISOString(),
  );
  await addAudit(database, 'MISSING_INFO_ACKNOWLEDGED', 'screening', screeningId, actor, {
    analysisId,
    missingFields,
  });
}

export async function recordConsent(
  screeningId: string,
  decision: ConsentDecision,
  evidencePath: string | null,
  actor: string,
): Promise<void> {
  const database = await getDatabase();
  const now = new Date().toISOString();
  await database.withTransactionAsync(async () => {
    await database.runAsync(
      'INSERT INTO consent_record(id, screening_id, decision, evidence_path, actor, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      Crypto.randomUUID(),
      screeningId,
      decision,
      evidencePath,
      actor,
      now,
    );
    if (decision === 'DECLINED') {
      await database.runAsync(
        'UPDATE screening_case SET status = ?, updated_at = ? WHERE id = ?',
        'CLOSED',
        now,
        screeningId,
      );
    }
    await addAudit(database, 'CONSENT_RECORDED', 'screening', screeningId, actor, {
      decision,
      evidenceAttached: Boolean(evidencePath),
    });
  });
}

/**
 * Keep a declined decision in the existing consent and screening tables
 * without creating a patient or scheduling any follow-up. No schema migration.
 */
export async function recordDeclinedRegistration(input: {
  name: string;
  age?: number;
  gender?: Gender;
  notes?: string;
  actor: string;
}): Promise<void> {
  const name = input.name.trim();
  if (!name) throw new Error('请填写患者姓名。');
  const database = await getDatabase();
  const screeningId = Crypto.randomUUID();
  const now = new Date().toISOString();
  await database.withTransactionAsync(async () => {
    await database.runAsync(
      'INSERT INTO screening_case(id, name, age, gender, clinical_json, ecg_path, status, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      screeningId, name, input.age ?? 0, input.gender ?? '其他',
      JSON.stringify({ ...EMPTY_CLINICAL_INFO, investigatorNotes: input.notes?.trim() ?? '' }),
      '', 'CLOSED', 1, now, now,
    );
    await database.runAsync(
      'INSERT INTO consent_record(id, screening_id, decision, evidence_path, actor, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      Crypto.randomUUID(), screeningId, 'DECLINED', null, input.actor, now,
    );
    await addAudit(database, 'CONSENT_RECORDED', 'screening', screeningId, input.actor, { decision: 'DECLINED', enrollmentCreated: false });
  });
}

export class DuplicatePatientError extends Error {
  constructor() {
    super('同一研究项目内已存在姓名和电话相同的患者，请检查已有记录。');
    this.name = 'DuplicatePatientError';
  }
}

export async function enrollPatient(input: {
  screeningId: string;
  phone: string;
  groupName: '用药组' | '不用药组';
  enrollmentAt: string;
  notes: string;
  actor: string;
  qualificationVerified: boolean;
  verifier: string;
  verificationNote: string;
}): Promise<string> {
  const database = await getDatabase();
  const screening = await getScreening(input.screeningId);
  if (!screening) throw new Error('未找到预筛记录。');
  const latestAnalysis = screening.latestAnalysis;
  const aiSkipped = screening.status === 'AI_SKIPPED';
  if (!aiSkipped && (!latestAnalysis || !['ELIGIBLE', 'MISSING_INFO'].includes(latestAnalysis.verdict))) {
    throw new Error('当前 AI 结果不能进入入组登记。');
  }
  if (!input.phone.trim()) throw new Error('请填写患者电话。');
  if (!input.qualificationVerified) throw new Error('请先完成授权人员正式资格核实。');
  if (!input.verifier.trim()) throw new Error('请填写正式资格核实人。');
  if (!input.verificationNote.trim()) throw new Error('请填写正式资格核实说明。');

  const fingerprint = await patientFingerprint(screening.name, input.phone);
  const patientId = Crypto.randomUUID();
  const now = new Date().toISOString();
  const localStudyId = 'LOCAL-STUDY';
  const enrollmentDate = parseLocalDate(input.enrollmentAt) ?? new Date(input.enrollmentAt);
  if (!Number.isFinite(enrollmentDate.getTime())) throw new Error('入组日期无效，请重新选择。');
  const enrollmentDateValue = dateKey(enrollmentDate);
  const patientNumber =
    'PT-' +
    enrollmentDate.getFullYear() +
    String(enrollmentDate.getMonth() + 1).padStart(2, '0') +
    String(enrollmentDate.getDate()).padStart(2, '0') +
    '-' + patientId.slice(0, 6).toUpperCase();
  const consent = await database.getFirstAsync<{ decision: ConsentDecision }>(
    'SELECT decision FROM consent_record WHERE screening_id = ? ORDER BY created_at DESC LIMIT 1',
    input.screeningId,
  );
  if (consent?.decision !== 'AGREED') throw new Error('需要先记录患者同意。');

  const missingAck =
    aiSkipped ||
    latestAnalysis?.verdict !== 'MISSING_INFO' ||
    Boolean(await database.getFirstAsync<{ id: string }>(
      'SELECT id FROM missing_acknowledgement WHERE screening_id = ? AND analysis_id = ? LIMIT 1',
      screening.id,
      latestAnalysis?.id ?? '',
    ));
  if (!missingAck) throw new Error('请先确认已知晓缺失资料。');

  await database.withTransactionAsync(async () => {
    const duplicate = await database.getFirstAsync<{ id: string }>(
      'SELECT id FROM patient WHERE study_id = ? AND identity_fingerprint = ? LIMIT 1',
      localStudyId,
      fingerprint,
    );
    if (duplicate) throw new DuplicatePatientError();

    await database.runAsync(
      'INSERT INTO qualification_verification(id, screening_id, analysis_id, verifier, verified, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      Crypto.randomUUID(),
      screening.id,
      aiSkipped ? null : latestAnalysis?.id ?? null,
      input.verifier.trim(),
      1,
      input.verificationNote.trim(),
      now,
    );
    await database.runAsync(
      'INSERT INTO patient(id, screening_id, patient_number, study_id, identity_fingerprint, name, age, gender, phone, group_name, enrollment_at, enrolled_by, notes, status, exited_at, exit_note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      patientId,
      screening.id,
      patientNumber,
      localStudyId,
      fingerprint,
      screening.name.trim(),
      screening.age,
      screening.gender,
      input.phone.trim(),
      input.groupName,
      enrollmentDateValue,
      input.actor,
      input.notes.trim(),
      'ACTIVE',
      null,
      null,
      now,
    );
    for (const month of [1, 3, 6, 12] as const) {
      await database.runAsync(
        'INSERT INTO followup_task(id, patient_id, node_month, planned_date, status, completed_at, cancelled_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        Crypto.randomUUID(),
        patientId,
        month,
        addCalendarMonthsClamped(enrollmentDateValue, month),
        'PENDING',
        null,
        null,
        now,
      );
    }
    await database.runAsync(
      'UPDATE screening_case SET status = ?, updated_at = ? WHERE id = ?',
      'ENROLLED',
      now,
      screening.id,
    );
    await addAudit(database, 'PATIENT_ENROLLED', 'patient', patientId, input.actor, {
      screeningId: screening.id,
      patientNumber,
      nodeMonths: [1, 3, 6, 12],
    });
  });
  return patientId;
}

export async function addExistingPatient(input: {
  name: string;
  age?: number;
  gender?: Gender;
  phone: string;
  groupName: '用药组' | '不用药组';
  enrollmentAt: string;
  clinical: ClinicalInfo;
  ecgPath?: string;
  notes?: string;
  consentDecision?: ConsentDecision;
  consentEvidencePath?: string;
  qualificationRecorded?: boolean;
  verifier?: string;
  verificationNote?: string;
  actor: string;
}): Promise<string> {
  const name = input.name.trim();
  const phone = input.phone.trim();
  if (!name || !phone) throw new Error('请填写患者姓名和电话。');
  if (!['用药组', '不用药组'].includes(input.groupName)) throw new Error('请选择患者所在组。');
  const enrollmentAt = parseLocalDate(input.enrollmentAt) ?? new Date(input.enrollmentAt);
  if (!Number.isFinite(enrollmentAt.getTime())) throw new Error('入组日期无效，请重新选择。');
  const enrollmentDateValue = dateKey(enrollmentAt);

  const database = await getDatabase();
  const screeningId = Crypto.randomUUID();
  const patientId = Crypto.randomUUID();
  const now = new Date().toISOString();
  const fingerprint = await patientFingerprint(name, phone);
  const localStudyId = 'LOCAL-STUDY';
  const patientNumber =
    'PT-' +
    enrollmentAt.getFullYear() +
    String(enrollmentAt.getMonth() + 1).padStart(2, '0') +
    String(enrollmentAt.getDate()).padStart(2, '0') +
    '-' + patientId.slice(0, 6).toUpperCase();

  await database.withTransactionAsync(async () => {
    const duplicate = await database.getFirstAsync<{ id: string }>(
      'SELECT id FROM patient WHERE study_id = ? AND identity_fingerprint = ? LIMIT 1',
      localStudyId,
      fingerprint,
    );
    if (duplicate) throw new DuplicatePatientError();

    await database.runAsync(
      'INSERT INTO screening_case(id, name, age, gender, clinical_json, ecg_path, status, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      screeningId,
      name,
      input.age ?? 0,
      input.gender ?? '其他',
      JSON.stringify(input.clinical),
      input.ecgPath ?? '',
      'ENROLLED',
      1,
      now,
      now,
    );

    await database.runAsync(
      'INSERT INTO patient(id, screening_id, patient_number, study_id, identity_fingerprint, name, age, gender, phone, group_name, enrollment_at, enrolled_by, notes, status, exited_at, exit_note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      patientId,
      screeningId,
      patientNumber,
      localStudyId,
      fingerprint,
      name,
      input.age ?? 0,
      input.gender ?? '其他',
      phone,
      input.groupName,
      enrollmentDateValue,
      input.actor,
      input.notes?.trim() ?? '',
      'ACTIVE',
      null,
      null,
      now,
    );

    for (const month of [1, 3, 6, 12] as const) {
      await database.runAsync(
        'INSERT INTO followup_task(id, patient_id, node_month, planned_date, status, completed_at, cancelled_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        Crypto.randomUUID(),
        patientId,
        month,
        addCalendarMonthsClamped(enrollmentDateValue, month),
        'PENDING',
        null,
        null,
        now,
      );
    }

    if (input.consentDecision || input.consentEvidencePath) {
      await database.runAsync(
        'INSERT INTO consent_record(id, screening_id, decision, evidence_path, actor, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        Crypto.randomUUID(),
        screeningId,
        input.consentDecision ?? 'NOT_RECORDED',
        input.consentEvidencePath ?? null,
        input.actor,
        now,
      );
    }

    if (input.qualificationRecorded || input.verifier?.trim() || input.verificationNote?.trim()) {
      await database.runAsync(
        'INSERT INTO qualification_verification(id, screening_id, analysis_id, verifier, verified, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        Crypto.randomUUID(),
        screeningId,
        null,
        input.verifier?.trim() ?? '',
        input.qualificationRecorded ? 1 : 0,
        input.verificationNote?.trim() ?? '',
        now,
      );
    }

    await addAudit(database, 'HISTORICAL_PATIENT_IMPORTED', 'patient', patientId, input.actor, {
      screeningId,
      patientNumber,
      nodeMonths: [1, 3, 6, 12],
    });
  });
  return patientId;
}

/**
 * Edit patient contact details in one transaction. Keep enrollment date,
 * group, scheduled follow-ups and immutable patient number untouched.
 * Fingerprint must follow edited name/phone so future duplicate checks work.
 */
export async function updatePatientDetails(input: {
  patientId: string;
  name: string;
  phone: string;
  age: number;
  gender: Gender;
  notes: string;
}): Promise<void> {
  const name = input.name.trim();
  const phone = input.phone.trim();
  if (!name || !phone) throw new Error('请填写姓名和联系电话。');
  if (name.length > 100 || phone.length > 40 || input.notes.length > 3000)
    throw new Error('输入内容过长，请检查姓名、电话或备注。');
  if (!Number.isInteger(input.age) || input.age < 0 || input.age > 130)
    throw new Error('年龄请输入 0 到 130 之间的整数；不清楚可填 0。');
  if (!['男', '女', '其他'].includes(input.gender))
    throw new Error('请选择正确的性别。');
  const database = await getDatabase();
  const fingerprint = await patientFingerprint(name, phone);
  await database.withTransactionAsync(async () => {
    const original = await database.getFirstAsync<PatientRow>(
      'SELECT * FROM patient WHERE id = ?', input.patientId);
    if (!original) throw new Error('找不到患者资料，请返回列表刷新。');
    const duplicate = await database.getFirstAsync<{ id: string }>(
      'SELECT id FROM patient WHERE study_id = ? AND identity_fingerprint = ? AND id <> ? LIMIT 1',
      'LOCAL-STUDY', fingerprint, input.patientId);
    if (duplicate) throw new DuplicatePatientError();
    const now = new Date().toISOString();
    await database.runAsync(
      'UPDATE patient SET name = ?, phone = ?, age = ?, gender = ?, notes = ?, identity_fingerprint = ? WHERE id = ?',
      name, phone, input.age, input.gender, input.notes.trim(), fingerprint, input.patientId);
    await database.runAsync(
      'UPDATE screening_case SET name = ?, age = ?, gender = ?, updated_at = ? WHERE id = ?',
      name, input.age, input.gender, now, original.screening_id);
    await addAudit(database, 'PATIENT_DETAILS_UPDATED', 'patient', input.patientId, '本机', {
      fields: ['name', 'phone', 'age', 'gender', 'notes'],
    });
  });
}

export async function listPatients(): Promise<Patient[]> {
  const database = await getDatabase();
  const rows = await database.getAllAsync<PatientRow>(
    'SELECT * FROM patient ORDER BY created_at DESC LIMIT 500',
  );
  return rows.map(mapPatient);
}

export async function getPatient(patientId: string): Promise<Patient | undefined> {
  const database = await getDatabase();
  const row = await database.getFirstAsync<PatientRow>(
    'SELECT * FROM patient WHERE id = ?',
    patientId,
  );
  return row ? mapPatient(row) : undefined;
}

/**
 * Patient-level actionable follow-ups for the foreground-only daily briefing.
 * Never send names/phone numbers to Android's background notification service.
 * Match HomePage's DUE/OVERDUE criteria while doing the filtering in SQL.
 */
export type DueFollowupContact = {
  patientId: string;
  patientName: string;
  patientNumber: string;
  phone: string;
  firstTaskId: string;
  nodeMonths: number[];
  dueTodayCount: number;
  overdueCount: number;
};

export async function listDueFollowupContacts(today = dateKey(new Date())): Promise<DueFollowupContact[]> {
  const database = await getDatabase();
  const rows = await database.getAllAsync<{
    task_id: string;
    patient_id: string;
    patient_name: string;
    patient_number: string;
    phone: string;
    node_month: number;
    planned_date: string;
  }>(
    `SELECT t.id AS task_id, t.patient_id, p.name AS patient_name,
            p.patient_number, p.phone, t.node_month, t.planned_date
       FROM followup_task t
       INNER JOIN patient p ON p.id = t.patient_id
      WHERE p.status = 'ACTIVE'
        AND t.status NOT IN ('COMPLETED', 'CANCELLED')
        AND t.planned_date <= ?
      ORDER BY CASE WHEN t.planned_date = ? THEN 0 ELSE 1 END,
               t.planned_date ASC, p.name COLLATE NOCASE`,
    today, today,
  );

  const contacts = new Map<string, DueFollowupContact>();
  for (const row of rows) {
    let contact = contacts.get(row.patient_id);
    if (!contact) {
      contact = {
        patientId: row.patient_id,
        patientName: row.patient_name,
        patientNumber: row.patient_number,
        phone: row.phone,
        firstTaskId: row.task_id,
        nodeMonths: [],
        dueTodayCount: 0,
        overdueCount: 0,
      };
      contacts.set(row.patient_id, contact);
    }
    if (!contact.nodeMonths.includes(row.node_month)) contact.nodeMonths.push(row.node_month);
    if (row.planned_date === today) contact.dueTodayCount += 1;
    else contact.overdueCount += 1;
  }
  return Array.from(contacts.values()).sort((a, b) => {
    if ((a.dueTodayCount > 0) !== (b.dueTodayCount > 0)) return a.dueTodayCount > 0 ? -1 : 1;
    return a.patientName.localeCompare(b.patientName, 'zh-CN');
  });
}

export async function getTasks(): Promise<FollowupTask[]> {
  const database = await getDatabase();
  const rows = await database.getAllAsync<{
    id: string;
    patient_id: string;
    patient_number: string;
    patient_name: string;
    group_name: string;
    node_month: number;
    planned_date: string;
    task_status: string;
    patient_status: string;
    completed_at: string | null;
  }>(
    'SELECT t.id, t.patient_id, p.patient_number, p.name AS patient_name, p.group_name, t.node_month, t.planned_date, t.status AS task_status, p.status AS patient_status, t.completed_at FROM followup_task t JOIN patient p ON p.id = t.patient_id ORDER BY t.planned_date ASC',
  );
  return rows.map((row) => ({
    id: row.id,
    patientId: row.patient_id,
    patientNumber: row.patient_number,
    patientName: row.patient_name,
    groupName: row.group_name,
    nodeMonth: row.node_month as 1 | 3 | 6 | 12,
    plannedDate: row.planned_date,
    status: getFollowupStatus(row.planned_date, row.task_status, row.patient_status),
    completedAt: row.completed_at ?? undefined,
  }));
}

// Counts all formally enrolled patients, including patients who later exited.
// This is intentionally distinct from DashboardSummary.activePatients.
export async function getTotalEnrolledPatientCount(): Promise<number> {
  const database = await getDatabase();
  const result = await database.getFirstAsync<{ count: number }>(
    'SELECT COUNT(*) AS count FROM patient',
  );
  return result?.count ?? 0;
}

export async function getDashboardSummary(): Promise<DashboardSummary> {
  const database = await getDatabase();
  const patientCount = await database.getFirstAsync<{ count: number }>(
    'SELECT COUNT(*) AS count FROM patient WHERE status = ?',
    'ACTIVE',
  );
  const tasks = await getTasks();
  return {
    activePatients: patientCount?.count ?? 0,
    dueTasks: tasks.filter((task) => task.status === 'DUE').length,
    overdueTasks: tasks.filter((task) => task.status === 'OVERDUE').length,
  };
}

export async function listPatientTasks(patientId: string): Promise<FollowupTask[]> {
  return (await getTasks()).filter((task) => task.patientId === patientId);
}

export async function listFollowupRecords(taskId: string): Promise<Array<{
  id: string;
  contactedAt: string;
  result: string;
  completed: boolean;
  condition: string;
  notes: string;
  actor: string;
}>> {
  const database = await getDatabase();
  const rows = await database.getAllAsync<{
    id: string;
    contacted_at: string;
    contact_result: string;
    completed: number;
    patient_condition: string;
    notes: string;
    actor: string;
  }>(
    'SELECT * FROM followup_record WHERE task_id = ? ORDER BY contacted_at DESC',
    taskId,
  );
  return rows.map((row) => ({
    id: row.id,
    contactedAt: row.contacted_at,
    result: row.contact_result,
    completed: row.completed === 1,
    condition: row.patient_condition,
    notes: row.notes,
    actor: row.actor,
  }));
}

export async function recordFollowup(input: {
  taskId: string;
  contactedAt: string;
  result: string;
  completed: boolean;
  condition: string;
  notes: string;
  actor: string;
}): Promise<void> {
  const database = await getDatabase();
  const now = new Date().toISOString();
  await database.withTransactionAsync(async () => {
    const task = await database.getFirstAsync<{ status: string; patient_id: string }>(
      'SELECT t.status, t.patient_id FROM followup_task t JOIN patient p ON p.id = t.patient_id WHERE t.id = ? AND p.status = ?',
      input.taskId,
      'ACTIVE',
    );
    if (!task) throw new Error('随访任务不存在或患者已退出。');
    await database.runAsync(
      'INSERT INTO followup_record(id, task_id, contacted_at, contact_result, completed, patient_condition, notes, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      Crypto.randomUUID(),
      input.taskId,
      input.contactedAt,
      input.result,
      input.completed ? 1 : 0,
      input.condition.trim(),
      input.notes.trim(),
      input.actor,
      now,
    );
    if (input.completed) {
      await database.runAsync(
        'UPDATE followup_task SET status = ?, completed_at = ? WHERE id = ? AND status != ?',
        'COMPLETED',
        now,
        input.taskId,
        'CANCELLED',
      );
    }
    await addAudit(database, 'FOLLOWUP_RECORDED', 'followup_task', input.taskId, input.actor, {
      completed: input.completed,
      result: input.result,
    });
  });
}

export async function exitPatient(
  patientId: string,
  note: string,
  actor: string,
): Promise<void> {
  const database = await getDatabase();
  const now = new Date().toISOString();
  await database.withTransactionAsync(async () => {
    const result = await database.runAsync(
      'UPDATE patient SET status = ?, exited_at = ?, exit_note = ? WHERE id = ? AND status = ?',
      'EXITED',
      now,
      note.trim(),
      patientId,
      'ACTIVE',
    );
    if (result.changes === 0) throw new Error('患者不存在或已退出。');
    await database.runAsync(
      'UPDATE followup_task SET status = ?, cancelled_at = ? WHERE patient_id = ? AND status != ?',
      'CANCELLED',
      now,
      patientId,
      'COMPLETED',
    );
    await addAudit(database, 'PATIENT_EXITED', 'patient', patientId, actor, {
      note: note.trim(),
    });
  });
}

export async function closeScreening(
  screeningId: string,
  actor: string,
  reason: string,
): Promise<void> {
  const database = await getDatabase();
  await database.runAsync(
    'UPDATE screening_case SET status = ?, updated_at = ? WHERE id = ?',
    'CLOSED',
    new Date().toISOString(),
    screeningId,
  );
  await addAudit(database, 'SCREENING_CLOSED', 'screening', screeningId, actor, {
    reason,
  });
}

export async function getLatestConsent(
  screeningId: string,
): Promise<{
  decision: ConsentDecision;
  evidencePath: string | null;
  actor: string;
  createdAt: string;
} | undefined> {
  const database = await getDatabase();
  return (
    (await database.getFirstAsync<{
      decision: ConsentDecision;
      evidence_path: string | null;
      actor: string;
      created_at: string;
    }>(
      'SELECT decision, evidence_path, actor, created_at FROM consent_record WHERE screening_id = ? ORDER BY created_at DESC LIMIT 1',
      screeningId,
    ).then((row) =>
      row
        ? {
            decision: row.decision,
            evidencePath: row.evidence_path,
            actor: row.actor,
            createdAt: row.created_at,
          }
        : undefined,
    ))
  );
}

export async function getLatestQualificationVerification(screeningId: string): Promise<{
  verifier: string;
  verified: boolean;
  note: string;
  createdAt: string;
  aiAssisted: boolean;
} | undefined> {
  const database = await getDatabase();
  const row = await database.getFirstAsync<{
    verifier: string;
    verified: number;
    note: string;
    created_at: string;
    analysis_id: string | null;
  }>(
    'SELECT verifier, verified, note, created_at, analysis_id FROM qualification_verification WHERE screening_id = ? ORDER BY created_at DESC LIMIT 1',
    screeningId,
  );
  return row
    ? {
        verifier: row.verifier,
        verified: row.verified === 1,
        note: row.note,
        createdAt: row.created_at,
      aiAssisted: row.analysis_id !== null,
      }
    : undefined;
}

