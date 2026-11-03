export type Gender = '男' | '女' | '其他';

export type ScreeningStatus =
  | 'DRAFT'
  | 'ANALYZING'
  | 'PRELIMINARY_PASS'
  | 'MISSING_INFO'
  | 'AI_SKIPPED'
  | 'INELIGIBLE'
  | 'ANALYSIS_FAILED'
  | 'ENROLLED'
  | 'CLOSED';

export type AiVerdict = 'ELIGIBLE' | 'MISSING_INFO' | 'INELIGIBLE';

export type AiResult = {
  verdict: AiVerdict;
  summary: string;
  reasons: string[];
  missing_fields: string[];
  evidence: Array<{ criterion: string; finding: string; source: string }>;
  confidence?: number;
};

export type ClinicalInfo = {
  symptoms: string;
  diagnosis: string;
  troponin: string;
  onsetToPresentation: string;
  pciPlan: string;
  pciContraindications: string;
  drugAllergy: string;
  pregnancyStatus: string;
  otherTrials: string;
  investigatorNotes: string;
};

export type Screening = {
  id: string;
  name: string;
  age: number;
  gender: Gender;
  clinical: ClinicalInfo;
  ecgPath: string;
  status: ScreeningStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
  latestAnalysis?: AnalysisRun;
};

export type AnalysisRun = {
  id: string;
  screeningId: string;
  inputVersion: number;
  model: string;
  protocolVersion: string;
  verdict: AiVerdict | 'FAILED';
  result?: AiResult;
  error?: string;
  createdAt: string;
};

export type ConsentDecision = 'AGREED' | 'DECLINED' | 'NOT_RECORDED';

export type PatientStatus = 'ACTIVE' | 'EXITED';

export type FollowupStatus =
  | 'PENDING'
  | 'DUE'
  | 'OVERDUE'
  | 'COMPLETED'
  | 'CANCELLED';

export type Patient = {
  id: string;
  screeningId: string;
  patientNumber: string;
  name: string;
  age: number;
  gender: Gender;
  phone: string;
  groupName: '用药组' | '不用药组';
  enrollmentAt: string;
  enrolledBy: string;
  notes: string;
  status: PatientStatus;
  exitedAt?: string;
};

export type FollowupTask = {
  id: string;
  patientId: string;
  patientNumber: string;
  patientName: string;
  groupName: string;
  nodeMonth: 1 | 3 | 6 | 12;
  plannedDate: string;
  status: FollowupStatus;
  completedAt?: string;
};

export type DashboardSummary = {
  activePatients: number;
  dueTasks: number;
  overdueTasks: number;
};

export const EMPTY_CLINICAL_INFO: ClinicalInfo = {
  symptoms: '',
  diagnosis: '',
  troponin: '',
  onsetToPresentation: '',
  pciPlan: '',
  pciContraindications: '',
  drugAllergy: '',
  pregnancyStatus: '',
  otherTrials: '',
  investigatorNotes: '',
};
