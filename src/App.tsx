import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Alert,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { File, Paths } from 'expo-file-system';
import * as Notifications from 'expo-notifications';
import { SymbolView } from 'expo-symbols';
import {
  addExistingPatient,
  beginAnalysis,
  closeScreening,
  createScreening,
  enrollPatient,
  exitPatient,
  failAnalysis,
  finishAnalysis,
  getDashboardSummary,
  getPatient,
  getLatestConsent,
  getLatestQualificationVerification,
  getScreening,
  getTasks,
  listFollowupRecords,
  listAnalysisHistory,
  listPatientTasks,
  listPatients,
  listScreenings,
  recoverInterruptedAnalyses,
  recordConsent,
  recordFollowup,
  saveScreeningDraft,
  acknowledgeMissingInformation,
  skipAiAnalysis,
  DuplicatePatientError,
} from './storage/repository';
import {
  bytesToBase64,
  deleteEncryptedImage,
  encryptedImageMimeType,
  readEncryptedImage,
  storeEncryptedImage,
} from './storage/secureFiles';
import { getDatabase } from './storage/database';
import {
  getAutomaticBackupDirectoryName,
  hasAutomaticBackupAccess,
  requestAutomaticBackupAccess,
  startAutomaticBackup,
} from './services/automaticBackup';
import { analyzeEligibility, AiConfigurationError } from './services/aiClient';
import {
  configureNotifications,
  getExactAlarmPermission,
  getReminderDiagnostics,
  openAppNotificationSettings,
  openNotificationChannelSettings,
  refreshLocalReminders,
  requestExactAlarmPermission,
  requestNotificationPermission,
  scheduleTestNotificationInOneMinute,
  sendTestNotificationNow,
  type ReminderDiagnostics,
} from './services/notifications';
import {
  getAiSettings,
  getOperatorName,
  saveAiSettings,
  setOperatorName,
  type AiSettings,
} from './services/settings';
import {
  getBackgroundMonitorState,
  setBackgroundMonitorEnabled,
  syncBackgroundMonitorSnapshot,
  restoreBackgroundMonitorIfEnabled,
  openMonitorNotificationSettings,
  type BackgroundMonitorState,
} from './services/backgroundMonitor';
import { dateKey, formatLocalDateTime, parseLocalDate, parseLocalDateTime } from './domain/dates';
import { STUDY_PROTOCOL_VERSION } from './config/studyProtocol';
import { theme, typeScale } from './theme';
import {
  EMPTY_CLINICAL_INFO,
  type AiResult,
  type AnalysisRun,
  type ClinicalInfo,
  type ConsentDecision,
  type DashboardSummary,
  type FollowupTask,
  type Gender,
  type Patient,
  type Screening,
  type ScreeningStatus,
} from './types';

type Tab = 'home' | 'patients' | 'followups' | 'settings';
type Route =
  | { kind: 'tab' }
  | { kind: 'patientEntry' }
  | { kind: 'existingPatient' }
  | { kind: 'screening'; id?: string }
  | { kind: 'result'; id: string }
  | { kind: 'consent'; id: string }
  | { kind: 'enrollment'; id: string }
  | { kind: 'patient'; id: string }
  | { kind: 'task'; id: string }
  | { kind: 'record'; id: string };

type Props = {
  onOpen: (route: Route) => void;
  onRefresh: (forceReminderReschedule?: boolean) => Promise<void>;
  onBack?: () => void;
};
type BackProps = Props & { onBack: () => void };

function Label({ children, tone = 'muted' }: { children: React.ReactNode; tone?: 'muted' | 'ink' }) {
  return <Text style={[styles.label, tone === 'ink' && { color: theme.ink }]}>{children}</Text>;
}

function Card({ children, style }: { children: React.ReactNode; style?: object }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

function PrimaryButton({
  title,
  onPress,
  disabled,
  secondary,
  danger,
  loading,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  secondary?: boolean;
  danger?: boolean;
  loading?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.button,
        secondary && styles.buttonSecondary,
        danger && styles.buttonDanger,
        disabled && styles.buttonDisabled,
      ]}
    >
      <View style={styles.buttonContent}>
        {loading ? <ActivityIndicator size="small" color={secondary ? theme.primaryDark : '#FFFFFF'} /> : null}
        <Text
          style={[
            styles.buttonText,
            secondary && styles.buttonSecondaryText,
            danger && styles.buttonText,
          ]}
        >
          {title}
        </Text>
      </View>
    </Pressable>
  );
}

function TextField({
  label,
  value,
  onChangeText,
  placeholder,
  keyboardType,
  multiline,
  secureTextEntry,
  autoCapitalize,
  required,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  keyboardType?: 'default' | 'numeric' | 'phone-pad' | 'url';
  multiline?: boolean;
  secureTextEntry?: boolean;
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  required?: boolean;
}) {
  return (
    <View style={styles.field}>
      <Label tone="ink">{label}{required ? <Text style={styles.requiredMark}> *</Text> : null}</Label>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor="#9AA8AE"
        keyboardType={keyboardType ?? 'default'}
        multiline={multiline}
        secureTextEntry={secureTextEntry}
        autoCapitalize={autoCapitalize ?? 'sentences'}
        style={[styles.input, multiline && styles.inputMultiline]}
        textAlignVertical={multiline ? 'top' : 'center'}
      />
    </View>
  );
}

function EnrollmentDatePicker({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const initialDate = parseLocalDate(value) ?? new Date();
  const [viewMonth, setViewMonth] = useState(
    () => new Date(initialDate.getFullYear(), initialDate.getMonth(), 1),
  );
  const year = viewMonth.getFullYear();
  const month = viewMonth.getMonth();
  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells = Array.from({ length: 42 }, (_, index) => {
    const day = index - firstWeekday + 1;
    return day >= 1 && day <= daysInMonth ? day : null;
  });
  const today = dateKey(new Date());

  return (
    <View style={styles.field}>
      <Label tone="ink">{label}<Text style={styles.requiredMark}> *</Text></Label>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={value ? `入组日期，${value}，点击更改` : '选择入组日期'}
        accessibilityState={{ expanded: open }}
        onPress={() => {
          if (!open) {
            const selected = parseLocalDate(value) ?? new Date();
            setViewMonth(new Date(selected.getFullYear(), selected.getMonth(), 1));
          }
          setOpen((current) => !current);
        }}
        style={styles.datePickerTrigger}
      >
        <SymbolView name={{ ios: 'calendar', android: 'calendar_month', web: 'calendar_month' }} size={20} tintColor={theme.primary} />
        <Text style={[styles.datePickerValue, !value && styles.datePickerPlaceholder]}>
          {value || '请选择入组日期'}
        </Text>
        <SymbolView name={{ ios: open ? 'chevron.up' : 'chevron.down', android: open ? 'expand_less' : 'expand_more', web: open ? 'expand_less' : 'expand_more' }} size={19} tintColor={theme.muted} />
      </Pressable>
      {open ? (
        <View style={styles.calendarPanel}>
          <View style={styles.calendarHeader}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="上一个月"
              style={styles.calendarNav}
              onPress={() => setViewMonth(new Date(year, month - 1, 1))}
            >
              <SymbolView name={{ ios: 'chevron.left', android: 'chevron_left', web: 'chevron_left' }} size={20} tintColor={theme.primary} />
            </Pressable>
            <Text style={styles.calendarMonth}>{year}年 {month + 1}月</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="下一个月"
              style={styles.calendarNav}
              onPress={() => setViewMonth(new Date(year, month + 1, 1))}
            >
              <SymbolView name={{ ios: 'chevron.right', android: 'chevron_right', web: 'chevron_right' }} size={20} tintColor={theme.primary} />
            </Pressable>
          </View>
          <View style={styles.calendarGrid}>
            {['日', '一', '二', '三', '四', '五', '六'].map((weekday) => (
              <View key={weekday} style={styles.calendarDayCell}>
                <Text style={styles.calendarWeekday}>{weekday}</Text>
              </View>
            ))}
            {cells.map((day, index) => {
              if (day === null) return <View key={`empty-${index}`} style={styles.calendarDayCell} />;
              const dayValue = dateKey(new Date(year, month, day));
              const selected = value === dayValue;
              return (
                <Pressable
                  key={dayValue}
                  accessibilityRole="radio"
                  accessibilityLabel={`${year}年${month + 1}月${day}日`}
                  accessibilityState={{ selected }}
                  style={[
                    styles.calendarDayCell,
                    styles.calendarDay,
                    selected && styles.calendarDaySelected,
                    dayValue === today && !selected && styles.calendarDayToday,
                  ]}
                  onPress={() => {
                    onChange(dayValue);
                    setOpen(false);
                  }}
                >
                  <Text style={[styles.calendarDayText, selected && styles.calendarDayTextSelected]}>{day}</Text>
                </Pressable>
              );
            })}
          </View>
          <Text style={styles.calendarHint}>选择日期后自动保存为该日</Text>
        </View>
      ) : null}
    </View>
  );
}

function ChoiceRow<T extends string>({
  label,
  options,
  value,
  onChange,
  required,
}: {
  label: string;
  options: T[];
  value?: T;
  onChange: (value: T) => void;
  required?: boolean;
}) {
  return (
    <View style={styles.field}>
      <Label tone="ink">{label}{required ? <Text style={styles.requiredMark}> *</Text> : null}</Label>
      <View style={styles.choiceRow}>
        {options.map((option) => (
          <Pressable
            key={option}
            accessibilityRole="radio"
            accessibilityState={{ selected: value === option }}
            onPress={() => onChange(option)}
            style={[styles.choice, value === option && styles.choiceSelected]}
          >
            <Text style={[styles.choiceText, value === option && styles.choiceTextSelected]}>
              {option}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function PageHeader({
  title,
  subtitle,
  onBack,
}: {
  title: string;
  subtitle?: string;
  onBack?: () => void;
}) {
  return (
    <View style={styles.pageHeader}>
      {onBack ? (
        <Pressable onPress={onBack} style={styles.backButton}>
          <Text style={styles.backText}>‹ 返回</Text>
        </Pressable>
      ) : null}
      <Text style={styles.pageTitle}>{title}</Text>
      {subtitle ? <Text style={styles.pageSubtitle}>{subtitle}</Text> : null}
    </View>
  );
}

function StatusBadge({ status }: { status: FollowupTask['status'] }) {
  const label =
    status === 'PENDING'
      ? '未到期'
      : status === 'DUE'
        ? '今日待随访'
        : status === 'OVERDUE'
          ? '已逾期'
          : status === 'COMPLETED'
            ? '已完成'
            : '已取消';
  const color =
    status === 'OVERDUE'
      ? theme.danger
      : status === 'COMPLETED'
        ? theme.primary
        : status === 'DUE'
          ? theme.accent
          : theme.muted;
  const bg =
    status === 'OVERDUE'
      ? theme.dangerSoft
      : status === 'COMPLETED'
        ? theme.primarySoft
        : status === 'DUE'
          ? '#FBF1E1'
          : '#EEF2F3';
  return (
    <View style={[styles.badge, { backgroundColor: bg }]}>
      <Text style={[styles.badgeText, { color }]}>{label}</Text>
    </View>
  );
}

function ScreeningStatusBadge({ status }: { status: ScreeningStatus }) {
  const label: Record<ScreeningStatus, string> = {
    DRAFT: '待补资料',
    ANALYZING: '分析中',
    PRELIMINARY_PASS: '初筛通过',
    MISSING_INFO: '需补充信息',
    AI_SKIPPED: '已跳过 AI',
    INELIGIBLE: '初筛不符合',
    ANALYSIS_FAILED: '分析失败',
    ENROLLED: '已入组',
    CLOSED: '已结束',
  };
  const color = status === 'PRELIMINARY_PASS'
    ? theme.primary
    : status === 'INELIGIBLE' || status === 'ANALYSIS_FAILED'
      ? theme.danger
        : status === 'MISSING_INFO' || status === 'AI_SKIPPED'
          ? theme.accent
          : theme.muted;
  const bg = status === 'PRELIMINARY_PASS'
    ? theme.primarySoft
    : status === 'INELIGIBLE' || status === 'ANALYSIS_FAILED'
      ? theme.dangerSoft
        : status === 'MISSING_INFO'
          ? '#FBF1E1'
          : status === 'AI_SKIPPED'
            ? theme.blueSoft
            : '#EEF2F3';
  return <View style={[styles.badge, { backgroundColor: bg }]}><Text style={[styles.badgeText, { color }]}>{label[status]}</Text></View>;
}

function EmptyState({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <Card style={styles.emptyCard}>
      <SymbolView name={{ ios: 'tray', android: 'inbox', web: 'inbox' }} size={30} tintColor={theme.muted} />
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptySubtitle}>{subtitle}</Text>
    </Card>
  );
}

function HomePage({
  summary,
  tasks,
  screenings,
  onOpen,
  onRefresh,
}: Props & { summary: DashboardSummary; tasks: FollowupTask[]; screenings: Screening[] }) {
  const todayTasks = tasks
    .filter((task) => task.status === 'DUE' || task.status === 'OVERDUE')
    .sort((a, b) => (a.status === 'OVERDUE' ? -1 : 0) - (b.status === 'OVERDUE' ? -1 : 0));
  const openScreenings = screenings.slice(0, 4);
  const toScreening = (screening: Screening) => {
    if (screening.status === 'ANALYZING') {
      Alert.alert('AI 分析中', '请等待当前分析完成后再打开这条预筛。');
    } else if (screening.status === 'DRAFT') {
      onOpen({ kind: 'screening', id: screening.id });
    } else if (screening.status === 'AI_SKIPPED') {
      onOpen({ kind: 'consent', id: screening.id });
    } else {
      onOpen({ kind: 'result', id: screening.id });
    }
  };
  return (
    <ScrollView contentContainerStyle={styles.pageContent}>
      <View style={styles.homeTitleBlock}>
        <Text style={styles.eyebrow}>{new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })}</Text>
        <Text style={styles.homeTitle}>今日工作</Text>
        <Text style={styles.homeDescription}>从待办开始，让每一位患者的随访都有记录。</Text>
      </View>
      <View style={styles.hero}>
        <Text style={styles.homeDueLabel}>待处理随访</Text>
        <View style={styles.homeDueRow}>
          <Text style={styles.homeDueNumber}>{todayTasks.length}</Text>
          <Text style={styles.homeDueUnit}>项任务</Text>
        </View>
        <View style={styles.homeStatRow}>
          <View style={styles.homeStatItem}>
            <Text style={styles.homeStatNumber}>{summary.dueTasks}</Text>
            <Text style={styles.homeStatLabel}>今日到期</Text>
          </View>
          <View style={styles.homeStatItem}>
            <Text style={[styles.homeStatNumber, { color: theme.danger }]}>{summary.overdueTasks}</Text>
            <Text style={styles.homeStatLabel}>已逾期</Text>
          </View>
          <View style={styles.homeStatItem}>
            <Text style={styles.homeStatNumber}>{summary.activePatients}</Text>
            <Text style={styles.homeStatLabel}>在组患者</Text>
          </View>
        </View>
      </View>

      <SectionHeading title="优先处理" />
      {todayTasks.length === 0 ? (
        <EmptyState title="今天没有到期待办" subtitle="已安排的随访会按计划时间出现在这里。" />
      ) : (
        todayTasks.slice(0, 4).map((task) => (
          <TaskCard key={task.id} task={task} onPress={() => onOpen({ kind: 'task', id: task.id })} />
        ))
      )}

      <SectionHeading title="待处理预筛" action="刷新" onPress={() => { void onRefresh(); }} />
      {openScreenings.length === 0 ? (
        <EmptyState title="暂无待处理预筛" subtitle="新增患者可以先录入资料，再进行资格核实。" />
      ) : (
        openScreenings.map((screening) => (
          <Pressable key={screening.id} accessibilityRole="button" onPress={() => toScreening(screening)}>
            <Card style={styles.screeningCard}>
              <View style={styles.taskTop}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.taskPatient}>{screening.name || '未填写姓名'}</Text>
                  <Text style={styles.taskMeta}>{screening.age > 0 ? `${screening.age} 岁` : '年龄待填写'} · {screening.gender} · 更新于 {formatLocalDateTime(new Date(screening.updatedAt))}</Text>
                </View>
                <ScreeningStatusBadge status={screening.status} />
              </View>
              <Text style={styles.screeningAction}>继续处理  ›</Text>
            </Card>
          </Pressable>
        ))
      )}
      <PrimaryButton title="新增或补录患者" onPress={() => onOpen({ kind: 'patientEntry' })} />
      <View style={{ height: 12 }} />
    </ScrollView>
  );
}

function PatientEntryPage({ onOpen, onBack }: BackProps) {
  return (
    <ScrollView contentContainerStyle={styles.pageContent}>
      <PageHeader title="添加患者" subtitle="请选择患者来源，后续资料会按对应流程保存。" onBack={onBack} />
      <Pressable accessibilityRole="button" onPress={() => onOpen({ kind: 'screening' })}>
        <Card style={styles.entryCard}>
          <View style={styles.entryIcon}>
            <SymbolView name={{ ios: 'person.badge.plus', android: 'person_add', web: 'person_add' }} size={26} tintColor={theme.primary} />
          </View>
          <Text style={styles.entryTitle}>新增入组患者</Text>
          <Text style={styles.bodyText}>从预筛开始，依次完成资料、患者选择和正式资格核实，再生成随访计划。</Text>
          <Text style={styles.entryAction}>开始新增  ›</Text>
        </Card>
      </Pressable>
      <Pressable accessibilityRole="button" onPress={() => onOpen({ kind: 'existingPatient' })}>
        <Card style={styles.entryCard}>
          <View style={[styles.entryIcon, { backgroundColor: theme.successSoft }]}>
            <SymbolView name={{ ios: 'person.crop.rectangle.stack', android: 'clinical_notes', web: 'clinical_notes' }} size={26} tintColor={theme.success} />
          </View>
          <Text style={styles.entryTitle}>添加已经入组患者</Text>
          <Text style={styles.bodyText}>一次性补录既有患者。只需填写姓名、电话、入组日期和所在组，其余资料均可稍后补充。</Text>
          <Text style={[styles.entryAction, { color: theme.success }]}>打开补录表单  ›</Text>
        </Card>
      </Pressable>
    </ScrollView>
  );
}

function ExistingPatientPage({ actor, onBack, onRefresh, onOpen }: BackProps & { actor: string }) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [age, setAge] = useState('');
  const [gender, setGender] = useState<Gender | undefined>();
  const [groupName, setGroupName] = useState<'用药组' | '不用药组' | undefined>();
  const [enrollmentAt, setEnrollmentAt] = useState('');
  const [clinical, setClinical] = useState(EMPTY_CLINICAL_INFO);
  const [ecgPath, setEcgPath] = useState('');
  const [notes, setNotes] = useState('');
  const [consentDecision, setConsentDecision] = useState<ConsentDecision | undefined>();
  const [consentEvidencePath, setConsentEvidencePath] = useState('');
  const [qualificationRecorded, setQualificationRecorded] = useState(false);
  const [verifier, setVerifier] = useState('');
  const [verificationNote, setVerificationNote] = useState('');
  const [busy, setBusy] = useState(false);
  const saved = useRef(false);
  const previewPath = useRef('');
  const proofPath = useRef('');

  useEffect(() => () => {
    if (!saved.current) {
      [previewPath.current, proofPath.current].filter(Boolean).forEach((path) => {
        deleteEncryptedImage(path).catch(() => undefined);
      });
    }
  }, []);

  const pickImage = async (kind: 'ecg' | 'consent') => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('需要照片权限', '请允许访问照片，以选择需要保存的图片。');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: false, quality: 1 });
    if (result.canceled || !result.assets[0]?.uri) return;
    try {
      const nextPath = await storeEncryptedImage(result.assets[0].uri);
      if (kind === 'ecg') {
        if (previewPath.current) await deleteEncryptedImage(previewPath.current);
        previewPath.current = nextPath;
        setEcgPath(nextPath);
      } else {
        if (consentEvidencePath) await deleteEncryptedImage(consentEvidencePath);
        proofPath.current = nextPath;
        setConsentEvidencePath(nextPath);
      }
    } catch (error) {
      Alert.alert('图片保存失败', error instanceof Error ? error.message : '请重试。');
    }
  };

  const updateClinical = (key: keyof ClinicalInfo, value: string) => setClinical((current) => ({ ...current, [key]: value }));
  const submit = async () => {
    const date = parseLocalDate(enrollmentAt);
    if (!name.trim() || !phone.trim() || !date || !groupName) {
      Alert.alert('请补全必填信息', '姓名、电话、入组日期和所在组为必填项。');
      return;
    }
    const parsedAge = age.trim() ? Number(age) : undefined;
    if (parsedAge !== undefined && (!Number.isInteger(parsedAge) || parsedAge < 1 || parsedAge > 130)) {
      Alert.alert('年龄格式不正确', '年龄请填写 1 到 130 的整数；也可以留空。');
      return;
    }
    setBusy(true);
    try {
      const patientId = await addExistingPatient({
        name,
        phone,
        age: parsedAge,
        gender,
        groupName,
        enrollmentAt: dateKey(date),
        clinical,
        ecgPath,
        notes,
        consentDecision,
        consentEvidencePath: consentEvidencePath || undefined,
        qualificationRecorded,
        verifier,
        verificationNote,
        actor,
      });
      saved.current = true;
      await onRefresh();
      onOpen({ kind: 'patient', id: patientId });
    } catch (error) {
      if (error instanceof DuplicatePatientError) Alert.alert('患者可能已存在', error.message);
      else Alert.alert('补录失败', error instanceof Error ? error.message : '请检查资料后重试。');
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.pageContent} keyboardShouldPersistTaps="handled">
        <PageHeader title="补录已入组患者" subtitle="带 * 的字段为必填，其余资料可以留空。" onBack={onBack} />
        <Card>
          <Text style={styles.cardHeading}>患者身份</Text>
          <TextField label="患者姓名" value={name} onChangeText={setName} required placeholder="请输入姓名" />
          <TextField label="联系电话" value={phone} onChangeText={setPhone} required keyboardType="phone-pad" placeholder="请输入联系电话" />
          <TextField label="年龄（选填）" value={age} onChangeText={setAge} keyboardType="numeric" placeholder="周岁" />
          <ChoiceRow label="性别（选填）" options={['男', '女', '其他']} value={gender} onChange={setGender} />
        </Card>
        <Card>
          <Text style={styles.cardHeading}>入组信息</Text>
          <EnrollmentDatePicker label="入组日期" value={enrollmentAt} onChange={setEnrollmentAt} />
          <ChoiceRow label="所在组" options={['用药组', '不用药组']} value={groupName} onChange={setGroupName} required />
          <Text style={styles.helperText}>请选择患者已进入的研究组。此记录用于生成后续随访计划。</Text>
        </Card>
        <Card>
          <Text style={styles.cardHeading}>临床资料（全部选填）</Text>
          <TextField label="症状描述" value={clinical.symptoms} onChangeText={(v) => updateClinical('symptoms', v)} multiline placeholder="例如胸痛持续时间、伴随症状" />
          <TextField label="诊断信息" value={clinical.diagnosis} onChangeText={(v) => updateClinical('diagnosis', v)} multiline placeholder="例如 STEMI / NSTEMI" />
          <TextField label="肌钙蛋白" value={clinical.troponin} onChangeText={(v) => updateClinical('troponin', v)} multiline placeholder="数值、参考上限或动态变化" />
          <TextField label="发病至就诊时间" value={clinical.onsetToPresentation} onChangeText={(v) => updateClinical('onsetToPresentation', v)} placeholder="例如 8 小时" />
          <TextField label="PCI 治疗计划" value={clinical.pciPlan} onChangeText={(v) => updateClinical('pciPlan', v)} multiline />
          <TextField label="PCI 禁忌情况" value={clinical.pciContraindications} onChangeText={(v) => updateClinical('pciContraindications', v)} multiline />
          <TextField label="麝香保心丸过敏或耐受情况" value={clinical.drugAllergy} onChangeText={(v) => updateClinical('drugAllergy', v)} multiline />
          <TextField label="妊娠或哺乳情况" value={clinical.pregnancyStatus} onChangeText={(v) => updateClinical('pregnancyStatus', v)} />
          <TextField label="近 3 个月参与其他研究情况" value={clinical.otherTrials} onChangeText={(v) => updateClinical('otherTrials', v)} multiline />
          <TextField label="研究者补充说明" value={clinical.investigatorNotes} onChangeText={(v) => updateClinical('investigatorNotes', v)} multiline />
          <View style={styles.spacer} />
          <PrimaryButton title={ecgPath ? '心电图已加密保存' : '选填：添加心电图图片'} onPress={() => pickImage('ecg')} secondary />
        </Card>
        <Card>
          <Text style={styles.cardHeading}>历史知情同意（选填）</Text>
          <ChoiceRow label="患者选择" options={['同意参加', '不同意', '未记录']} value={consentDecision === 'AGREED' ? '同意参加' : consentDecision === 'DECLINED' ? '不同意' : consentDecision === 'NOT_RECORDED' ? '未记录' : undefined} onChange={(value) => setConsentDecision(value === '同意参加' ? 'AGREED' : value === '不同意' ? 'DECLINED' : 'NOT_RECORDED')} />
          <View style={styles.spacer} />
          <PrimaryButton title={consentEvidencePath ? '同意证明已加密保存' : '选填：添加同意证明图片'} onPress={() => pickImage('consent')} secondary />
          <Text style={styles.helperText}>可以只记录患者选择、只添加证明图片，或都不填写。</Text>
        </Card>
        <Card>
          <Text style={styles.cardHeading}>历史资格核实（选填）</Text>
          <View style={styles.switchRow}>
            <Text style={styles.switchLabel}>记录为已完成资格核实</Text>
            <Switch value={qualificationRecorded} onValueChange={setQualificationRecorded} trackColor={{ true: theme.primary }} />
          </View>
          <TextField label="核实人" value={verifier} onChangeText={setVerifier} placeholder="选填" />
          <TextField label="核实说明" value={verificationNote} onChangeText={setVerificationNote} multiline placeholder="选填" />
        </Card>
        <Card>
          <Text style={styles.cardHeading}>患者情况说明（选填）</Text>
          <TextField label="补充说明" value={notes} onChangeText={setNotes} multiline placeholder="仅供本机研究记录" />
        </Card>
        <Text style={styles.privacyNote}>既有患者补录会直接创建档案和 1、3、6、12 个月随访任务，不要求重新进行 AI 预筛或入组核实。记录操作人：{actor}</Text>
        <PrimaryButton title={busy ? '正在保存患者资料…' : '保存并打开患者档案'} onPress={submit} disabled={busy} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function MetricCard({ label, value, tone }: { label: string; value: string; tone: 'gold' | 'red' | 'green' | 'blue' }) {
  const color = tone === 'gold' ? '#A66E17' : tone === 'red' ? theme.danger : tone === 'green' ? theme.primary : '#426C89';
  const bg = tone === 'gold' ? '#FBF3E6' : tone === 'red' ? theme.dangerSoft : tone === 'green' ? theme.primarySoft : theme.blueSoft;
  return (
    <View style={[styles.metricCard, { backgroundColor: bg }]}>
      <Text style={[styles.metricValue, { color }]}>{value}</Text>
      <Text style={styles.metricLabel}>{label}</Text>
    </View>
  );
}

function SectionHeading({ title, action, onPress }: { title: string; action?: string; onPress?: () => void }) {
  return (
    <View style={styles.sectionHeading}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {action && onPress ? <Pressable onPress={onPress}><Text style={styles.sectionAction}>{action}  ›</Text></Pressable> : null}
    </View>
  );
}

function TaskCard({ task, onPress }: { task: FollowupTask; onPress: () => void }) {
  return (
    <Pressable onPress={onPress}>
      <Card style={styles.taskCard}>
        <View style={styles.taskTop}>
          <View style={{ flex: 1 }}>
            <Text style={styles.taskPatient}>{task.patientNumber}</Text>
            <Text style={styles.taskMeta}>{task.patientName} · {task.groupName}</Text>
          </View>
          <StatusBadge status={task.status} />
        </View>
        <View style={styles.taskBottom}>
          <Text style={styles.taskNode}>第 {task.nodeMonth} 个月随访</Text>
          <Text style={styles.taskDate}>{task.plannedDate}  ›</Text>
        </View>
      </Card>
    </Pressable>
  );
}

function HomeTab({ summary, tasks, screenings, onOpen, onRefresh }: Props & { summary: DashboardSummary; tasks: FollowupTask[]; screenings: Screening[] }) {
  return <HomePage summary={summary} tasks={tasks} screenings={screenings} onOpen={onOpen} onRefresh={onRefresh} />;
}

function ScreeningPage({
  id: initialId,
  actor,
  onBack,
  onAnalyzed,
  onSkipped,
}: {
  id?: string;
  actor: string;
  onBack: () => void;
  onAnalyzed: (id: string) => void;
  onSkipped: (id: string) => void;
}) {
  const [id, setId] = useState(initialId ?? '');
  const [name, setName] = useState('');
  const [age, setAge] = useState('');
  const [gender, setGender] = useState<Gender>('男');
  const [clinical, setClinical] = useState<ClinicalInfo>(EMPTY_CLINICAL_INFO);
  const [ecgPath, setEcgPath] = useState('');
  const [previewUri, setPreviewUri] = useState('');
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(Boolean(initialId));

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        if (initialId) {
          const existing = await getScreening(initialId);
          if (!active || !existing) return;
          setName(existing.name);
          setAge(existing.age ? String(existing.age) : '');
          setGender(existing.gender);
          setClinical(existing.clinical);
          setEcgPath(existing.ecgPath);
          if (existing.ecgPath) {
            const bytes = await readEncryptedImage(existing.ecgPath);
            const data = await bytesToBase64(bytes);
            setPreviewUri('data:' + encryptedImageMimeType(existing.ecgPath) + ';base64,' + data);
          }
          setId(existing.id);
        } else {
          const newId = await createScreening(actor, EMPTY_CLINICAL_INFO);
          if (active) setId(newId);
        }
      } catch (error) {
        Alert.alert('无法打开预筛', error instanceof Error ? error.message : '本机存储初始化失败。');
      } finally {
        if (active) setReady(true);
      }
    })();
    return () => {
      active = false;
    };
  }, [actor, initialId]);

  const changeClinical = (key: keyof ClinicalInfo, value: string) => {
    setClinical((current) => ({ ...current, [key]: value }));
  };

  const pickEcg = async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('需要照片权限', '请允许访问照片，以选择患者心电图。');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: false,
      quality: 1,
    });
    if (result.canceled || !result.assets[0]?.uri) return;
    try {
      const nextPath = await storeEncryptedImage(result.assets[0].uri);
      await saveScreeningDraft(
        id,
        {
          name,
          age: Number(age) || 0,
          gender,
          clinical,
          ecgPath: nextPath,
        },
        actor,
      );
      await deleteEncryptedImage(ecgPath);
      const bytes = await readEncryptedImage(nextPath);
      setPreviewUri(
        'data:' + encryptedImageMimeType(nextPath) + ';base64,' + (await bytesToBase64(bytes)),
      );
      setEcgPath(nextPath);
    } catch (error) {
      Alert.alert('图片保存失败', error instanceof Error ? error.message : '请重试。');
    }
  };

  const runAnalysis = async () => {
    if (!id) return;
    const parsedAge = Number(age);
    if (!name.trim() || !Number.isInteger(parsedAge) || parsedAge < 1) {
      Alert.alert('资料不完整', '请填写患者姓名和正整数年龄。');
      return;
    }
    if (!ecgPath) {
      Alert.alert('缺少心电图', '请先上传患者心电图。');
      return;
    }
    let activeAnalysisId = '';
    try {
      setBusy(true);
      await saveScreeningDraft(
        id,
        { name, age: parsedAge, gender, clinical, ecgPath },
        actor,
      );
      const settings = await getAiSettings();
      if (!settings.apiKey.trim()) {
        Alert.alert('尚未设置 AI API Key', '请先在“我的”页面填写 API Key，预筛资料已保存在本机。');
        return;
      }
      const screening = await getScreening(id);
      if (!screening) throw new Error('读取预筛资料失败。');
      const started = await beginAnalysis(screening, settings.model, STUDY_PROTOCOL_VERSION, actor);
      activeAnalysisId = started.analysisId;
      const result = await analyzeEligibility(screening);
      await finishAnalysis(started.analysisId, id, result);
      onAnalyzed(id);
    } catch (error) {
      if (activeAnalysisId) {
        try {
          await failAnalysis(
            activeAnalysisId,
            id,
            error instanceof Error ? error.message : '分析失败',
          );
        } catch {
          // Keep the original user-facing error.
        }
      }
      if (error instanceof AiConfigurationError) {
        Alert.alert('暂不能开始审核', error.message);
      } else if (error instanceof Error) {
        Alert.alert('审核失败', error.message + '\n资料已保存在本机，可以重试。');
      } else {
        Alert.alert('审核失败', '资料已保存在本机，可以重试。');
      }
    } finally {
      setBusy(false);
    }
  };

  const skipAnalysis = () => {
    const parsedAge = Number(age);
    if (!name.trim() || !Number.isInteger(parsedAge) || parsedAge < 1) {
      Alert.alert('资料不完整', '请填写患者姓名和正整数年龄。');
      return;
    }
    Alert.alert(
      '跳过 AI 预筛？',
      '本次不会进行 AI 资格判断，也不需要上传心电图。继续入组前，仍须由授权人员人工核实资格并记录核实说明。',
      [
        { text: '返回', style: 'cancel' },
        {
          text: '跳过并继续',
          onPress: async () => {
            try {
              setBusy(true);
              await saveScreeningDraft(
                id,
                { name, age: parsedAge, gender, clinical, ecgPath },
                actor,
              );
              await skipAiAnalysis(id, actor);
              onSkipped(id);
            } catch (error) {
              Alert.alert('无法继续', error instanceof Error ? error.message : '请检查资料后重试。');
            } finally {
              setBusy(false);
            }
          },
        },
      ],
    );
  };

  const saveAndBack = async () => {
    if (id) {
      try {
        await saveScreeningDraft(
          id,
          { name, age: Number(age) || 0, gender, clinical, ecgPath },
          actor,
        );
      } catch (error) {
        Alert.alert('草稿保存失败', error instanceof Error ? error.message : '请重试。');
        return;
      }
    }
    onBack();
  };

  if (!ready) return <LoadingView label="正在打开本地预筛资料…" />;

  return (
    <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.pageContent}>
        <PageHeader title={initialId ? '补充预筛资料' : '新增患者预筛'} subtitle="可上传心电图进行 AI 辅助预筛，也可跳过 AI 并由授权人员人工核实。" onBack={saveAndBack} />
        <Card>
          <Text style={styles.cardHeading}>患者基本信息</Text>
          <TextField label="姓名" value={name} onChangeText={setName} placeholder="请输入患者姓名" />
          <TextField label="年龄" value={age} onChangeText={setAge} keyboardType="numeric" placeholder="周岁" />
          <ChoiceRow label="性别" options={['男', '女', '其他']} value={gender} onChange={setGender} />
        </Card>

        <Card>
          <Text style={styles.cardHeading}>心电图（可选）</Text>
          <Text style={styles.helperText}>使用 AI 辅助预筛时需要上传；跳过 AI 即可不上传。选择的图片在本机加密保存，提交 AI 分析时才会发送给你配置的模型服务。</Text>
          {previewUri ? <Image source={{ uri: previewUri }} style={styles.ecgPreview} resizeMode="contain" /> : null}
          <PrimaryButton title={ecgPath ? '更换心电图' : '选择心电图图片'} onPress={pickEcg} secondary />
        </Card>

        <Card>
          <Text style={styles.cardHeading}>临床资料</Text>
          <Text style={styles.helperText}>能确认的信息尽量填写；未知或缺失项会由 AI 标记为待补充。</Text>
          <TextField label="典型症状及持续时间" value={clinical.symptoms} onChangeText={(v) => changeClinical('symptoms', v)} multiline placeholder="例如：胸痛 30 分钟" />
          <TextField label="STEMI / NSTEMI 诊断信息" value={clinical.diagnosis} onChangeText={(v) => changeClinical('diagnosis', v)} multiline placeholder="诊断依据、心电图表现等" />
          <TextField label="高敏肌钙蛋白及动态变化" value={clinical.troponin} onChangeText={(v) => changeClinical('troponin', v)} multiline placeholder="数值、参考值上限和变化趋势" />
          <TextField label="发病至就诊时间" value={clinical.onsetToPresentation} onChangeText={(v) => changeClinical('onsetToPresentation', v)} placeholder="例如：发病后 6 小时" />
          <TextField label="PCI 治疗计划" value={clinical.pciPlan} onChangeText={(v) => changeClinical('pciPlan', v)} multiline placeholder="是否拟进行 PCI" />
          <TextField label="PCI 禁忌证" value={clinical.pciContraindications} onChangeText={(v) => changeClinical('pciContraindications', v)} multiline placeholder="如无，请填写“无”" />
          <TextField label="试验药物过敏或不耐受" value={clinical.drugAllergy} onChangeText={(v) => changeClinical('drugAllergy', v)} multiline placeholder="麝香保心丸过敏、无法耐受等" />
          <TextField label="妊娠、备孕或哺乳情况" value={clinical.pregnancyStatus} onChangeText={(v) => changeClinical('pregnancyStatus', v)} placeholder="不适用时可说明" />
          <TextField label="近 3 个月参与其他临床研究" value={clinical.otherTrials} onChangeText={(v) => changeClinical('otherTrials', v)} multiline placeholder="如无，请填写“无”" />
          <TextField label="研究者判断" value={clinical.investigatorNotes} onChangeText={(v) => changeClinical('investigatorNotes', v)} multiline placeholder="其他需要纳入评估的信息" />
        </Card>

        <PrimaryButton title={busy ? '正在提交 AI 分析…' : '保存并开始 AI 预筛'} onPress={runAnalysis} disabled={busy} />
        <View style={{ height: 10 }} />
        <PrimaryButton title="跳过 AI，继续患者同意" onPress={skipAnalysis} disabled={busy} secondary />
        {busy ? <ActivityIndicator color={theme.primary} style={{ marginTop: 16 }} /> : null}
        <Text style={styles.privacyNote}>姓名和电话不会发送给 AI。跳过 AI 时不会发送心电图或临床资料。</Text>
        <View style={{ height: 20 }} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function ResultPage({ id, actor, onBack, onOpen }: BackProps & { id: string; actor: string }) {
  const [screening, setScreening] = useState<Screening>();
  useEffect(() => {
    getScreening(id).then(setScreening).catch(() => undefined);
  }, [id]);
  if (!screening) return <LoadingView label="正在读取 AI 审核结果…" />;
  const run = screening.latestAnalysis;
  const result = run?.result;
  const verdict = run?.verdict;
  const passed = verdict === 'ELIGIBLE';
  const rejected = verdict === 'INELIGIBLE';
  const color = passed ? theme.primary : rejected ? theme.danger : theme.accent;
  const title = passed ? '初步审核通过' : rejected ? '明确不符合' : verdict === 'FAILED' ? '分析失败' : '资料需要补充';
  const continueToConsent = () => onOpen({ kind: 'consent', id });

  return (
    <ScrollView contentContainerStyle={styles.pageContent}>
      <PageHeader title="AI 审核结果" subtitle={'分析版本 ' + (run?.inputVersion ?? screening.version)} onBack={onBack} />
      <Card>
        <View style={[styles.resultMark, { backgroundColor: passed ? theme.primarySoft : rejected ? theme.dangerSoft : '#FBF1E1' }]}>
          <Text style={[styles.resultMarkText, { color }]}>{passed ? '✓' : rejected ? '×' : '!'}</Text>
        </View>
        <Text style={[styles.resultTitle, { color }]}>{title}</Text>
        <Text style={styles.resultSummary}>{result?.summary ?? run?.error ?? '请检查网络和 AI API 配置后重试。'}</Text>
        {result?.reasons.map((reason, index) => <Text key={index} style={styles.bullet}>•  {reason}</Text>)}
      </Card>
      {result?.missing_fields.length ? (
        <Card>
          <Text style={styles.cardHeading}>缺少或需要核实的信息</Text>
          {result.missing_fields.map((field, index) => <Text key={index} style={styles.bullet}>•  {field}</Text>)}
        </Card>
      ) : null}
      {result?.evidence.length ? (
        <Card>
          <Text style={styles.cardHeading}>依据摘要</Text>
          {result.evidence.map((item, index) => (
            <View key={index} style={styles.evidenceItem}>
              <Text style={styles.evidenceTitle}>{item.criterion || '评估项'}</Text>
              <Text style={styles.helperText}>{item.finding}</Text>
              {item.source ? <Text style={styles.evidenceSource}>来源：{item.source}</Text> : null}
            </View>
          ))}
        </Card>
      ) : null}
      {passed ? (
        <PrimaryButton title="进入患者同意环节" onPress={continueToConsent} />
      ) : rejected ? (
        <PrimaryButton
          title="结束当前预筛"
          danger
          onPress={async () => {
            await closeScreening(id, actor, 'AI 预筛明确不符合');
            onBack();
          }}
        />
      ) : verdict === 'MISSING_INFO' ? (
        <>
          <PrimaryButton
            title="返回补充资料"
            secondary
            onPress={() => onOpen({ kind: 'screening', id })}
          />
          <View style={{ height: 10 }} />
          <PrimaryButton
            title="已知晓，继续"
            onPress={async () => {
              await acknowledgeMissingInformation(
                id,
                run?.id ?? '',
                result?.missing_fields ?? [],
                actor,
              );
              onOpen({ kind: 'consent', id });
            }}
          />
        </>
      ) : (
        <PrimaryButton title="返回资料并重试" secondary onPress={() => onOpen({ kind: 'screening', id })} />
      )}
      <Text style={styles.privacyNote}>AI 结果是预筛判断；正式入组仍需授权人员核实研究资格。</Text>
    </ScrollView>
  );
}

function ConsentPage({
  id,
  actor,
  onBack,
  onOpen,
  onRefresh,
}: BackProps & { id: string; actor: string }) {
  const [evidencePath, setEvidencePath] = useState('');
  const [busy, setBusy] = useState(false);
  const pickEvidence = async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('需要照片权限', '如需提交可选证明，请允许访问照片。');
      return;
    }
    try {
      const picked = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: false,
        quality: 1,
      });
      if (!picked.canceled && picked.assets[0]?.uri) {
        const path = await storeEncryptedImage(picked.assets[0].uri);
        await deleteEncryptedImage(evidencePath);
        setEvidencePath(path);
      }
    } catch (error) {
      Alert.alert('证明图片保存失败', error instanceof Error ? error.message : '请重试。');
    }
  };
  const leaveConsentPage = () => {
    if (evidencePath) deleteEncryptedImage(evidencePath).catch(() => undefined);
    onBack();
  };
  const submit = async (decision: ConsentDecision) => {
    try {
      setBusy(true);
      await recordConsent(id, decision, decision === 'AGREED' ? evidencePath || null : null, actor);
      if (decision === 'DECLINED') {
        deleteEncryptedImage(evidencePath).catch(() => undefined);
        Alert.alert('已记录', '当前预筛已结束，不会创建正式患者或随访任务。');
        await onRefresh();
        onBack();
      } else {
        onOpen({ kind: 'enrollment', id });
      }
    } catch (error) {
      Alert.alert('提交失败', error instanceof Error ? error.message : '请重试。');
    } finally {
      setBusy(false);
    }
  };
  return (
    <ScrollView contentContainerStyle={styles.pageContent}>
      <PageHeader title="患者同意" subtitle="记录患者选择；证明材料可选。" onBack={leaveConsentPage} />
      <Card>
        <Text style={styles.cardHeading}>患者是否同意参加本研究？</Text>
        <Text style={styles.helperText}>请先向患者说明研究内容，并按研究流程完成知情同意核实。</Text>
        <View style={styles.spacer} />
        <PrimaryButton title="选择同意" onPress={() => submit('AGREED')} disabled={busy} />
        <View style={{ height: 10 }} />
        <PrimaryButton title="选择不同意" onPress={() => submit('DECLINED')} disabled={busy} secondary />
      </Card>
      <Card>
        <Text style={styles.cardHeading}>可选：上传同意证明</Text>
        <Text style={styles.helperText}>不上传也可以继续。证明图片会加密保存在本机。</Text>
        <View style={styles.spacer} />
        <PrimaryButton title={evidencePath ? '证明已保存在本机' : '选择证明图片'} onPress={pickEvidence} secondary />
        {evidencePath ? <Text style={styles.successText}>已添加可选附件</Text> : null}
      </Card>
    </ScrollView>
  );
}

function EnrollmentPage({
  id,
  actor,
  onBack,
  onOpen,
  onRefresh,
}: BackProps & { id: string; actor: string }) {
  const [screening, setScreening] = useState<Screening>();
  const [phone, setPhone] = useState('');
  const [groupName, setGroupName] = useState<'用药组' | '不用药组'>('用药组');
  const [enrollmentAt, setEnrollmentAt] = useState('');
  const [notes, setNotes] = useState('');
  const [verified, setVerified] = useState(false);
  const [verifier, setVerifier] = useState(actor);
  const [verificationNote, setVerificationNote] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getScreening(id).then(setScreening).catch(() => undefined);
  }, [id]);

  const submit = async () => {
    if (!screening) return;
    const date = parseLocalDate(enrollmentAt);
    if (!date) {
      Alert.alert('尚未选择入组日期', '请在日历中选择患者的入组日期。');
      return;
    }
    if (!verified) {
      Alert.alert('尚未完成正式资格核实', '请由授权人员完成核实后再确认入组。');
      return;
    }
    setBusy(true);
    try {
      const patientId = await enrollPatient({
        screeningId: id,
        phone,
        groupName,
        enrollmentAt: dateKey(date),
        notes,
        actor,
        qualificationVerified: verified,
        verifier,
        verificationNote,
      });
      await onRefresh();
      onOpen({ kind: 'patient', id: patientId });
    } catch (error) {
      if (error instanceof DuplicatePatientError) {
        Alert.alert('疑似重复患者', error.message);
      } else {
        Alert.alert('暂不能完成入组', error instanceof Error ? error.message : '请检查资料后重试。');
      }
    } finally {
      setBusy(false);
    }
  };

  if (!screening) return <LoadingView label="正在读取入组资料…" />;
  return (
    <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.pageContent}>
        <PageHeader title="正式入组登记" subtitle="选择入组日期，确认后生成患者编号和四个随访任务。" onBack={onBack} />
        <Card>
          <Text style={styles.cardHeading}>候选患者</Text>
          <Text style={styles.patientName}>{screening.name}</Text>
          <Text style={styles.helperText}>{screening.age} 岁 · {screening.gender}</Text>
        </Card>
        <Card>
          <Text style={styles.cardHeading}>入组信息</Text>
          <TextField label="患者电话（必填）" value={phone} onChangeText={setPhone} keyboardType="phone-pad" placeholder="请输入患者联系电话" />
          <ChoiceRow label="所属组别" options={['用药组', '不用药组']} value={groupName} onChange={setGroupName} />
          <EnrollmentDatePicker label="入组日期" value={enrollmentAt} onChange={setEnrollmentAt} />
          <TextField label="患者情况说明（选填）" value={notes} onChangeText={setNotes} multiline placeholder="补充说明" />
        </Card>
        <Card>
          <Text style={styles.cardHeading}>正式资格核实</Text>
          <Text style={styles.helperText}>{screening.status === 'AI_SKIPPED' ? '本次已跳过 AI 预筛；授权人员须根据研究方案人工核实资格后才能入组。' : 'AI 负责预筛主判；授权人员核实正式临床资格后才能入组。'}</Text>
          <View style={styles.switchRow}>
            <Text style={styles.switchLabel}>授权人员已完成核实</Text>
            <Switch value={verified} onValueChange={setVerified} trackColor={{ true: theme.primary }} />
          </View>
          <TextField label="核实人" value={verifier} onChangeText={setVerifier} placeholder="填写授权核实人" />
          <TextField label="核实说明" value={verificationNote} onChangeText={setVerificationNote} multiline placeholder="记录正式资格核实依据" />
        </Card>
        <Text style={styles.privacyNote}>当前登录操作人：{actor}。入组日期和操作人确认后不可普通修改。</Text>
        <PrimaryButton title={busy ? '正在完成入组…' : '确认正式入组'} onPress={submit} disabled={busy} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function PatientListPage({ onOpen }: Props) {
  const [patients, setPatients] = useState<Patient[]>([]);
  const [query, setQuery] = useState('');
  useEffect(() => {
    listPatients().then(setPatients).catch(() => undefined);
  }, []);
  const filtered = patients.filter((patient) =>
    [patient.name, patient.phone, patient.patientNumber].some((value) =>
      value.toLowerCase().includes(query.trim().toLowerCase()),
    ),
  );
  return (
    <ScrollView contentContainerStyle={styles.pageContent}>
      <PageHeader title="患者档案" subtitle={patients.length + ' 位患者'} />
      <PrimaryButton title="新增或补录患者" onPress={() => onOpen({ kind: 'patientEntry' })} />
      <TextField label="搜索患者" value={query} onChangeText={setQuery} placeholder="姓名、电话或患者编号" />
      {filtered.length === 0 ? (
        <EmptyState title={patients.length ? '没有找到匹配记录' : '还没有正式入组患者'} subtitle={patients.length ? '试试患者姓名或编号。' : '完成 AI 预筛、同意和入组后，患者会出现在这里。'} />
      ) : (
        filtered.map((patient) => (
          <Pressable key={patient.id} onPress={() => onOpen({ kind: 'patient', id: patient.id })}>
            <Card style={styles.patientCard}>
              <View style={styles.patientCardTop}>
                <View style={styles.avatar}><Text style={styles.avatarText}>{patient.name.slice(0, 1)}</Text></View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.patientName}>{patient.name}</Text>
                  <Text style={styles.taskMeta}>{patient.patientNumber} · {patient.groupName}</Text>
                </View>
                <Text style={[styles.patientState, patient.status === 'EXITED' && { color: theme.muted }]}>
                  {patient.status === 'ACTIVE' ? '在组' : '已退出'}
                </Text>
              </View>
              <Text style={styles.patientPhone}>{patient.phone}</Text>
            </Card>
          </Pressable>
        ))
      )}
    </ScrollView>
  );
}

function PatientDetailPage({
  id,
  actor,
  onBack,
  onOpen,
  onRefresh,
}: BackProps & { id: string; actor: string }) {
  const [patient, setPatient] = useState<Patient>();
  const [tasks, setTasks] = useState<FollowupTask[]>([]);
  const [screening, setScreening] = useState<Screening>();
  const [analysisHistory, setAnalysisHistory] = useState<AnalysisRun[]>([]);
  const [consent, setConsent] = useState<Awaited<ReturnType<typeof getLatestConsent>>>();
  const [qualification, setQualification] = useState<Awaited<ReturnType<typeof getLatestQualificationVerification>>>();
  const load = useCallback(async () => {
    const record = await getPatient(id);
    setPatient(record);
    setTasks(await listPatientTasks(id));
    if (record) {
      const [screeningRecord, consentRecord, verificationRecord] = await Promise.all([
        getScreening(record.screeningId),
        getLatestConsent(record.screeningId),
        getLatestQualificationVerification(record.screeningId),
      ]);
      setScreening(screeningRecord);
      setConsent(consentRecord);
      setQualification(verificationRecord);
      setAnalysisHistory(await listAnalysisHistory(record.screeningId));
    }
  }, [id]);
  useEffect(() => { load().catch(() => undefined); }, [load]);
  if (!patient) return <LoadingView label="正在读取患者档案…" />;
  const confirmExit = () =>
    Alert.alert('确认患者退出？', '未完成随访会停止提醒，历史记录保留。', [
      { text: '返回', style: 'cancel' },
      {
        text: '确认退出',
        style: 'destructive',
        onPress: async () => {
          try {
            await exitPatient(patient.id, '用户手动确认患者退出', actor);
            await onRefresh();
            await load();
          } catch (error) {
            Alert.alert('退出失败', error instanceof Error ? error.message : '请重试。');
          }
        },
      },
    ]);
  return (
    <ScrollView contentContainerStyle={styles.pageContent}>
      <PageHeader title="患者详情" subtitle={patient.patientNumber} onBack={onBack} />
      <Card>
        <View style={styles.patientCardTop}>
          <View style={styles.avatar}><Text style={styles.avatarText}>{patient.name.slice(0, 1)}</Text></View>
          <View style={{ flex: 1 }}>
            <Text style={styles.patientName}>{patient.name}</Text>
          <Text style={styles.taskMeta}>{patient.age > 0 ? `${patient.age} 岁` : '年龄未补录'} · {patient.gender} · {patient.groupName}</Text>
          </View>
          <Text style={styles.patientState}>{patient.status === 'ACTIVE' ? '在组' : '已退出'}</Text>
        </View>
        <View style={styles.infoDivider} />
        <InfoLine label="联系电话" value={patient.phone} />
        <InfoLine label="入组日期" value={dateKey(parseLocalDate(patient.enrollmentAt) ?? new Date(patient.enrollmentAt))} />
        <InfoLine label="入组操作人" value={patient.enrolledBy} />
        {patient.notes ? <InfoLine label="情况说明" value={patient.notes} /> : null}
        {screening?.latestAnalysis?.result ? (
          <InfoLine label="AI 预筛结论" value={screening.latestAnalysis.result.summary} />
        ) : null}
        {qualification && !qualification.aiAssisted ? (
          <InfoLine label="AI 预筛" value="没有关联 AI 预筛记录" />
        ) : null}
      </Card>
      <Card>
        <Text style={styles.cardHeading}>知情同意与资格核实</Text>
        <InfoLine label="患者选择" value={consent?.decision === 'AGREED' ? '同意参加' : consent?.decision === 'DECLINED' ? '不同意' : consent?.decision === 'NOT_RECORDED' ? '未记录' : '暂无记录'} />
        {consent ? <InfoLine label="记录时间" value={new Date(consent.createdAt).toLocaleString()} /> : null}
        {consent ? <InfoLine label="记录操作人" value={consent.actor} /> : null}
        {consent ? <InfoLine label="证明材料" value={consent.evidencePath ? '已提交加密图片' : '未提交（可选）'} /> : null}
        <View style={styles.infoDivider} />
        <InfoLine label="资格核实" value={qualification?.verified ? '已核实' : qualification ? '有记录，未标记已核实' : '暂无记录'} />
        {qualification ? <InfoLine label="核实方式" value={qualification.aiAssisted ? '结合 AI 预筛' : '未关联 AI 预筛'} /> : null}
        {qualification ? <InfoLine label="核实人" value={qualification.verifier} /> : null}
        {qualification ? <InfoLine label="核实时间" value={new Date(qualification.createdAt).toLocaleString()} /> : null}
        {qualification?.note ? <InfoLine label="核实说明" value={qualification.note} /> : null}
      </Card>
      <Card>
        <Text style={styles.cardHeading}>AI 预筛审核历史</Text>
        {analysisHistory.length === 0 ? (
          <Text style={styles.helperText}>{qualification && !qualification.aiAssisted ? '没有关联 AI 分析记录；资格信息按录入内容保存在档案中。' : '暂无审核记录。'}</Text>
        ) : analysisHistory.map((run) => (
          <View key={run.id} style={styles.evidenceItem}>
            <Text style={styles.evidenceTitle}>{run.result?.verdict === 'ELIGIBLE' ? '初筛通过' : run.result?.verdict === 'INELIGIBLE' ? '明确不符合' : run.result?.verdict === 'MISSING_INFO' ? '资料待补充' : '分析失败'} · {new Date(run.createdAt).toLocaleString()}</Text>
            <Text style={styles.helperText}>输入版本 {run.inputVersion} · {run.model} · 方案 {run.protocolVersion}</Text>
            {run.result?.summary ? <Text style={styles.bodyText}>{run.result.summary}</Text> : null}
            {run.error ? <Text style={styles.helperText}>{run.error}</Text> : null}
          </View>
        ))}
      </Card>
      <SectionHeading title="随访计划" />
      {tasks.map((task) => <TaskCard key={task.id} task={task} onPress={() => onOpen({ kind: 'task', id: task.id })} />)}
      {patient.status === 'ACTIVE' ? (
        <PrimaryButton title="患者退出研究" onPress={confirmExit} danger />
      ) : (
        <Card><Text style={styles.helperText}>该患者已退出。后续提醒已停止。</Text></Card>
      )}
      <View style={{ height: 14 }} />
    </ScrollView>
  );
}

function InfoLine({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.infoLine}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue}>{value}</Text>
    </View>
  );
}

type FollowupPatientSummary = {
  patientId: string;
  patientName: string;
  patientNumber: string;
  groupName: string;
  taskCount: number;
  todoCount: number;
  overdueCount: number;
  completedCount: number;
  nextTask?: FollowupTask;
};

const FollowupPatientCard = React.memo(function FollowupPatientCard({
  patient,
  onOpen,
}: {
  patient: FollowupPatientSummary;
  onOpen: (route: Route) => void;
}) {
  const summary = [
    patient.todoCount ? `${patient.todoCount} 项待办` : '',
    patient.overdueCount ? `${patient.overdueCount} 项逾期` : '',
    patient.completedCount ? `${patient.completedCount} 项已完成` : '',
  ].filter(Boolean).join(' · ');
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${patient.patientName}，${patient.patientNumber}，${patient.taskCount} 项随访任务`}
      onPress={() => onOpen({ kind: 'patient', id: patient.patientId })}
    >
      <Card style={styles.followupPatientCard}>
        <View style={styles.followupPatientTop}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{patient.patientName.slice(0, 1)}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.patientName}>{patient.patientName}</Text>
            <Text style={styles.taskMeta}>{patient.patientNumber} · {patient.groupName}</Text>
          </View>
          <SymbolView name={{ ios: 'chevron.right', android: 'chevron_right', web: 'chevron_right' }} size={20} tintColor={theme.muted} />
        </View>
        <Text style={styles.followupPatientSummary}>{summary || `${patient.taskCount} 项随访任务`}</Text>
        <Text style={styles.followupPatientNext}>
          {patient.nextTask
            ? `${patient.nextTask.status === 'COMPLETED' ? '最近已完成' : '最近待随访'}：${patient.nextTask.plannedDate} · 第 ${patient.nextTask.nodeMonth} 个月`
            : '所有随访任务已完成'}
        </Text>
      </Card>
    </Pressable>
  );
});

function FollowupListSeparator() {
  return <View style={styles.followupListSeparator} />;
}

function FollowupsPage({ onOpen, onRefresh, tasks }: Props & { tasks: FollowupTask[] }) {
  const [filter, setFilter] = useState<'待办' | '逾期' | '已完成' | '全部'>('待办');
  const visible = React.useMemo(() => {
    const grouped = new Map<string, FollowupTask[]>();
    for (const task of tasks) {
      if (task.status === 'CANCELLED') continue;
      const patientTasks = grouped.get(task.patientId);
      if (patientTasks) patientTasks.push(task);
      else grouped.set(task.patientId, [task]);
    }

    const summaries: FollowupPatientSummary[] = [];
    for (const [patientId, patientTasks] of grouped) {
      const todoCount = patientTasks.filter((task) => task.status === 'PENDING' || task.status === 'DUE').length;
      const overdueCount = patientTasks.filter((task) => task.status === 'OVERDUE').length;
      const completedCount = patientTasks.filter((task) => task.status === 'COMPLETED').length;
      const matches = filter === '待办'
        ? todoCount > 0
        : filter === '逾期'
          ? overdueCount > 0
          : filter === '已完成'
            ? completedCount > 0
            : patientTasks.length > 0;
      if (!matches) continue;

      const highlightedTasks = filter === '已完成'
        ? patientTasks.filter((task) => task.status === 'COMPLETED')
        : patientTasks.filter((task) => task.status === 'PENDING' || task.status === 'DUE' || task.status === 'OVERDUE');
      const nextTask = highlightedTasks.sort((left, right) =>
        filter === '已完成'
          ? right.plannedDate.localeCompare(left.plannedDate)
          : left.plannedDate.localeCompare(right.plannedDate),
      )[0];
      const first = patientTasks[0];
      summaries.push({
        patientId,
        patientName: first.patientName,
        patientNumber: first.patientNumber,
        groupName: first.groupName,
        taskCount: patientTasks.length,
        todoCount,
        overdueCount,
        completedCount,
        nextTask,
      });
    }

    return summaries.sort((left, right) => {
      const leftDate = left.nextTask?.plannedDate ?? '9999-12-31';
      const rightDate = right.nextTask?.plannedDate ?? '9999-12-31';
      return leftDate.localeCompare(rightDate) || left.patientName.localeCompare(right.patientName, 'zh-CN');
    });
  }, [filter, tasks]);

  return (
    <FlatList
      data={visible}
      keyExtractor={(patient) => patient.patientId}
      renderItem={({ item }) => <FollowupPatientCard patient={item} onOpen={onOpen} />}
      ItemSeparatorComponent={FollowupListSeparator}
      contentContainerStyle={styles.followupListContent}
      ListHeaderComponent={(
        <View style={styles.followupsHeader}>
          <PageHeader title="患者随访" subtitle="按患者查看计划和进度，点入档案处理具体节点。" />
          <View style={styles.filterRow}>
            {(['待办', '逾期', '已完成', '全部'] as const).map((item) => (
              <Pressable
                key={item}
                accessibilityRole="radio"
                accessibilityState={{ selected: filter === item }}
                onPress={() => setFilter(item)}
                style={[styles.filterChip, filter === item && styles.filterChipSelected]}
              >
                <Text style={[styles.filterText, filter === item && styles.filterTextSelected]}>{item}</Text>
              </Pressable>
            ))}
            <Pressable accessibilityRole="button" onPress={() => { void onRefresh(); }} style={styles.refreshPatientsButton}>
              <Text style={styles.sectionAction}>刷新</Text>
            </Pressable>
          </View>
          <Text style={styles.helperText}>共 {visible.length} 位患者 · 点开患者可查看 1、3、6、12 个月随访任务</Text>
        </View>
      )}
      ListEmptyComponent={<EmptyState title="没有符合条件的患者" subtitle="匹配的随访任务会按患者显示在这里。" />}
      initialNumToRender={10}
      maxToRenderPerBatch={10}
      windowSize={5}
      removeClippedSubviews={Platform.OS === 'android'}
    />
  );
}

function TaskDetailPage({
  id,
  onBack,
  onOpen,
}: BackProps & { id: string }) {
  const [task, setTask] = useState<FollowupTask>();
  const [patient, setPatient] = useState<Patient>();
  const [records, setRecords] = useState<Awaited<ReturnType<typeof listFollowupRecords>>>([]);
  const load = useCallback(async () => {
    const found = (await getTasks()).find((item) => item.id === id);
    setTask(found);
    if (found) {
      setPatient(await getPatient(found.patientId));
      setRecords(await listFollowupRecords(id));
    }
  }, [id]);
  useEffect(() => { load().catch(() => undefined); }, [load]);
  if (!task || !patient) return <LoadingView label="正在读取随访任务…" />;
  return (
    <ScrollView contentContainerStyle={styles.pageContent}>
      <PageHeader title="随访详情" subtitle={'第 ' + task.nodeMonth + ' 个月随访'} onBack={onBack} />
      <Card>
        <View style={styles.taskTop}>
          <View>
            <Text style={styles.taskPatient}>{patient.name} · {patient.patientNumber}</Text>
            <Text style={styles.taskMeta}>{patient.age > 0 ? `${patient.age} 岁` : '年龄未补录'} · {patient.gender} · {patient.groupName}</Text>
          </View>
          <StatusBadge status={task.status} />
        </View>
        <View style={styles.infoDivider} />
        <InfoLine label="计划日期" value={task.plannedDate} />
        <InfoLine label="联系电话" value={patient.phone} />
        {patient.notes ? <InfoLine label="情况说明" value={patient.notes} /> : null}
        <View style={styles.buttonPair}>
          <View style={{ flex: 1 }}>
            <PrimaryButton title="拨打电话" secondary onPress={() => Linking.openURL('tel:' + patient.phone).catch(() => Alert.alert('无法拨号', '此设备不支持拨打电话。'))} />
          </View>
          <View style={{ width: 10 }} />
          <View style={{ flex: 1 }}>
            <PrimaryButton title="记录随访" onPress={() => onOpen({ kind: 'record', id: task.id })} disabled={task.status === 'COMPLETED' || task.status === 'CANCELLED'} />
          </View>
        </View>
      </Card>
      <SectionHeading title="联系历史" />
      {records.length === 0 ? <EmptyState title="暂无联系记录" subtitle="拨打电话后在这里保存联系结果。" /> : records.map((record) => (
        <Card key={record.id} style={styles.recordCard}>
          <Text style={styles.recordTitle}>{record.completed ? '随访完成' : '联系尝试'} · {record.result}</Text>
          <Text style={styles.helperText}>{new Date(record.contactedAt).toLocaleString()}</Text>
          {record.condition ? <Text style={styles.bodyText}>{record.condition}</Text> : null}
          {record.notes ? <Text style={styles.bodyText}>{record.notes}</Text> : null}
        </Card>
      ))}
    </ScrollView>
  );
}

function FollowupRecordPage({
  id,
  actor,
  onBack,
  onRefresh,
}: BackProps & { id: string; actor: string }) {
  const [contactedAt, setContactedAt] = useState(formatLocalDateTime(new Date()));
  const [result, setResult] = useState('已接通');
  const [completed, setCompleted] = useState(false);
  const [condition, setCondition] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const date = parseLocalDateTime(contactedAt);
    if (!date) {
      Alert.alert('联系时间格式错误', '请按 YYYY-MM-DD HH:mm 填写。');
      return;
    }
    setBusy(true);
    try {
      await recordFollowup({
        taskId: id,
        contactedAt: date.toISOString(),
        result,
        completed,
        condition,
        notes,
        actor,
      });
      await onRefresh();
      onBack();
    } catch (error) {
      Alert.alert('保存失败', error instanceof Error ? error.message : '请重试。');
    } finally {
      setBusy(false);
    }
  };
  return (
    <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.pageContent}>
        <PageHeader title="电话随访记录" subtitle="只有明确完成本次随访才会停止提醒。" onBack={onBack} />
        <Card>
          <TextField label="实际联系时间" value={contactedAt} onChangeText={setContactedAt} placeholder="YYYY-MM-DD HH:mm" />
          <ChoiceRow label="联系结果" options={['已接通', '未接通', '拒绝接听', '号码错误']} value={result} onChange={setResult} />
          <TextField label="患者情况说明" value={condition} onChangeText={setCondition} multiline placeholder="记录患者反馈" />
          <TextField label="备注" value={notes} onChangeText={setNotes} multiline placeholder="选填" />
          <View style={styles.switchRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.switchLabel}>本次随访已完成</Text>
              <Text style={styles.helperText}>未接通时不要打开此选项。</Text>
            </View>
            <Switch value={completed} onValueChange={setCompleted} trackColor={{ true: theme.primary }} />
          </View>
        </Card>
        <PrimaryButton title={busy ? '正在保存…' : '保存联系记录'} onPress={submit} disabled={busy} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function SettingsDisclosure({
  title, subtitle, expanded, onToggle, children,
}: {
  title: string;
  subtitle: string;
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={onToggle}
        style={styles.settingsDisclosureRow}
      >
        <View style={{ flex: 1 }}>
          <Text style={styles.cardHeading}>{title}</Text>
          <Text style={styles.settingsSubtitle}>{subtitle}</Text>
        </View>
        <SymbolView
          name={{ ios: expanded ? 'chevron.up' : 'chevron.down', android: expanded ? 'expand_less' : 'expand_more', web: expanded ? 'expand_less' : 'expand_more' }}
          size={21}
          tintColor={theme.muted}
        />
      </Pressable>
      {expanded ? <View style={styles.settingsDisclosureBody}>{children}</View> : null}
    </Card>
  );
}

function SettingsPage({ onRefresh }: Props) {
  const [settings, setSettings] = useState<AiSettings>({
    apiKey: '',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4.1-mini',
  });
  const [actor, setActor] = useState('本机操作人');
  const [saved, setSaved] = useState(false);
  const [notificationGranted, setNotificationGranted] = useState(false);
  const [exactAlarmGranted, setExactAlarmGranted] = useState(false);
  const [reminderDiagnostics, setReminderDiagnostics] = useState<ReminderDiagnostics | null>(null);
  const [reminderDetailsOpen, setReminderDetailsOpen] = useState(false);
  const [testFeedback, setTestFeedback] = useState('');
  const [monitorState, setMonitorState] = useState<BackgroundMonitorState>({
    enabled: false, running: false, lastError: '', lastStartedAt: 0,
    lastStoppedAt: 0, lastStartReason: '', lastTaskRemovedAt: 0,
    lastRestoreAttemptAt: 0, startCount: 0,
  });
  const [monitorBusy, setMonitorBusy] = useState(false);
  const [backupDetailsOpen, setBackupDetailsOpen] = useState(false);
  const [aiDetailsOpen, setAiDetailsOpen] = useState(false);
  const [operatorDetailsOpen, setOperatorDetailsOpen] = useState(false);
  const [aboutDetailsOpen, setAboutDetailsOpen] = useState(false);
  const [configuringReminders, setConfiguringReminders] = useState(false);
  const [backupDirectoryName, setBackupDirectoryName] = useState<string | null>(null);
  const [changingBackupDirectory, setChangingBackupDirectory] = useState(false);
  const refreshMonitorStatus = useCallback(async () => {
    if (Platform.OS === 'android') setMonitorState(await getBackgroundMonitorState());
  }, []);
  const toggleMonitor = async (enabled: boolean) => {
    if (monitorBusy) return;
    setMonitorBusy(true);
    try {
      await setBackgroundMonitorEnabled(enabled);
      await refreshMonitorStatus();
      if (enabled) {
        Alert.alert('后台监测已开启', '通知栏已提供紧凑摘要及可展开的三项随访统计。轻点进入工作台，也可以在通知中结束监测。已启用系统支持的服务恢复机制，但无法保证强行停止后继续运行。');
      }
    } catch (error) {
      Alert.alert('无法切换后台监测', error instanceof Error ? error.message : '请检查通知权限并重试。');
      await refreshMonitorStatus().catch(() => undefined);
    } finally {
      setMonitorBusy(false);
    }
  };
  const refreshNotificationPermissions = useCallback(async () => {
    const [notification, exactAlarm, diagnostics] = await Promise.all([
      Notifications.getPermissionsAsync(),
      getExactAlarmPermission(),
      getReminderDiagnostics().catch(() => null),
    ]);
    setNotificationGranted(notification.granted);
    setExactAlarmGranted(exactAlarm);
    setReminderDiagnostics(diagnostics);
  }, []);
  useEffect(() => {
    Promise.all([
      getAiSettings(),
      getOperatorName(),
      getAutomaticBackupDirectoryName(),
      refreshNotificationPermissions(),
      refreshMonitorStatus(),
    ])
      .then(([ai, operator, directoryName]) => {
        setSettings(ai);
        setActor(operator);
        setBackupDirectoryName(directoryName);
      })
      .catch(() => undefined);
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void refreshNotificationPermissions();
        void refreshMonitorStatus();
      }
    });
    return () => subscription.remove();
  }, [refreshNotificationPermissions, refreshMonitorStatus]);
  const change = (key: keyof AiSettings, value: string) => setSettings((current) => ({ ...current, [key]: value }));
  const save = async () => {
    try {
      await saveAiSettings(settings);
      await setOperatorName(actor);
      setSaved(true);
      setTimeout(() => setSaved(false), 2400);
    } catch (error) {
      Alert.alert('保存失败', error instanceof Error ? error.message : '请重试。');
    }
  };
  const configureReminders = async () => {
    if (configuringReminders) return;
    setConfiguringReminders(true);
    try {
      let notificationsAllowed = (await Notifications.getPermissionsAsync()).granted;
      if (!notificationsAllowed) {
        notificationsAllowed = await requestNotificationPermission();
        setNotificationGranted(notificationsAllowed);
        if (!notificationsAllowed) {
          Alert.alert('通知尚未开启', '请允许研伴发送通知，随访提醒才能显示在通知栏。', [
            { text: '稍后', style: 'cancel' },
            { text: '打开通知设置', onPress: () => void openAppNotifications() },
          ]);
          return;
        }
      }

      let exactAlarmAllowed = Platform.OS !== 'android' || await getExactAlarmPermission();
      if (Platform.OS === 'android' && !exactAlarmAllowed) {
        exactAlarmAllowed = await requestExactAlarmPermission();
        setExactAlarmGranted(exactAlarmAllowed);
        if (!exactAlarmAllowed) {
          Alert.alert('还需开启精确提醒', '请在刚打开的“闹钟和提醒”系统页面中允许研伴，然后返回本页继续配置。');
          return;
        }
      }

      if (Platform.OS === 'android') {
        const diagnostics = await getReminderDiagnostics().catch(() => null);
        setReminderDiagnostics(diagnostics);
        if (!diagnostics) {
          Alert.alert('需要检查通知渠道', '系统暂时无法读取提醒渠道状态。请打开通知渠道，确认通知、横幅和震动已开启。', [
            { text: '稍后', style: 'cancel' },
            { text: '打开通知渠道', onPress: () => void openNotificationSettings() },
          ]);
          return;
        }
        if (!diagnostics.highImportance || !diagnostics.vibrationEnabled) {
          Alert.alert('还需完成通知渠道设置', '请在系统页面为“患者随访提醒”开启通知、横幅和震动。完成后返回本页，再点“继续配置”检查。', [
            { text: '稍后', style: 'cancel' },
            { text: '打开通知渠道', onPress: () => void openNotificationSettings() },
          ]);
          return;
        }
        if (diagnostics.backgroundRestricted) {
          Alert.alert('系统限制后台提醒', '请将研伴的电池或后台使用设置改为允许。部分一加机型还需开启“自启动/关联启动”。完成后返回本页，再点“继续配置”检查。', [
            { text: '稍后', style: 'cancel' },
            { text: '打开应用设置', onPress: () => void openBackgroundSettings() },
          ]);
          return;
        }
      }

      setNotificationGranted(true);
      setExactAlarmGranted(exactAlarmAllowed);
      await onRefresh(true);
      await refreshNotificationPermissions();
      Alert.alert(
        '提醒设置已检查',
        '通知、精确提醒和可读取的通知渠道设置均已满足。部分手机厂商的自启动设置无法由 App 读取；如果后台提醒仍受影响，请在系统应用设置中允许研伴后台运行。',
      );
    } catch (error) {
      Alert.alert('提醒设置未完成', error instanceof Error ? error.message : '请检查系统通知和闹钟设置后重试。');
    } finally {
      setConfiguringReminders(false);
    }
  };
  const testNotification = async (delayed: boolean) => {
    setTestFeedback('');
    try {
      if (delayed) {
        const exactDelivery = await scheduleTestNotificationInOneMinute();
        await refreshNotificationPermissions();
        Alert.alert(
          '测试通知已安排',
          Platform.OS !== 'android'
            ? '约 1 分钟后触发。你可以返回桌面等待系统通知。'
            : exactDelivery
              ? '已交给系统精确闹钟。请返回桌面或从最近任务划掉 App，再检查通知横幅和五秒震动。系统设置中的「强行停止」不属于该测试。'
              : '当前没有精确闹钟权限，请先授权后重试。',
        );
      } else {
        const vibrationEnabled = await sendTestNotificationNow();
        // Do not show a modal Alert here: it can cover the very heads-up
        // notification the user is trying to test on the foreground screen.
        setTestFeedback(vibrationEnabled
          ? '即时测试已发送：请观察顶部横幅与约 5 秒震动。'
          : '当前提醒渠道的震动被关闭。请打开系统通知渠道启用震动。');
        await refreshNotificationPermissions();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '请检查系统通知权限后重试。';
      setTestFeedback(message);
      Alert.alert('通知测试未完成', message);
    }
  };
  const openNotificationSettings = async () => {
    try {
      await openNotificationChannelSettings();
    } catch (error) {
      Alert.alert('无法打开通知设置', error instanceof Error ? error.message : '请到系统设置中调整研伴通知。');
    }
  };
  const openAppNotifications = async () => {
    try {
      await openAppNotificationSettings();
    } catch (error) {
      Alert.alert('无法打开通知设置', error instanceof Error ? error.message : '请到系统设置中调整研伴通知。');
    }
  };
  const openBackgroundSettings = async () => {
    try {
      await Linking.openSettings();
    } catch (error) {
      Alert.alert('无法打开系统设置', error instanceof Error ? error.message : '请在手机设置中找到研伴的电池或后台运行设置。');
    }
  };
  const reminderReady = notificationGranted && exactAlarmGranted && (
    Platform.OS !== 'android' || Boolean(
      reminderDiagnostics?.highImportance &&
      reminderDiagnostics.vibrationEnabled &&
      !reminderDiagnostics.backgroundRestricted,
    )
  );
  const changeBackupDirectory = async () => {
    setChangingBackupDirectory(true);
    try {
      const selected = await requestAutomaticBackupAccess();
      if (!selected) return;
      setBackupDirectoryName(await getAutomaticBackupDirectoryName());
      // Starting the backup observer after an optional permission grant is
      // essential; a database opened earlier will not re-register itself.
      startAutomaticBackup(await getDatabase());
      Alert.alert('备份文件夹已更新', '已有自动备份已复制到新文件夹。此文件夹会用于后续自动备份和恢复。');
    } catch (error) {
      Alert.alert('文件夹设置未完成', error instanceof Error ? error.message : '请重新选择备份文件夹。');
    } finally {
      setChangingBackupDirectory(false);
    }
  };
  return (
    <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.pageContent}>
        <PageHeader title="我的" subtitle="账户、提醒与本机数据" />
        <Card>
          <View style={styles.taskTop}>
            <View style={{ flex: 1 }}>
              <Text style={styles.cardHeading}>随访提醒</Text>
              <Text style={styles.settingsSubtitle}>系统通知与定时提醒</Text>
            </View>
            <View style={[styles.reminderStatusDot, { backgroundColor: reminderReady ? theme.success : theme.accent }]} />
          </View>
          <Text style={[styles.reminderReadinessText, { marginTop: 12 }]}>
            {reminderReady ? '提醒基础设置正常' : '有待完成的系统设置'}
          </Text>
          <Text style={styles.helperText}>
            每日按计划提醒待办；若设备存在后台限制，会引导你完成必要设置。
          </Text>
          <View style={{ height: 14 }} />
          <PrimaryButton
            title={configuringReminders ? '正在检查…' : reminderReady ? '检查提醒状态' : '开启随访提醒'}
            onPress={() => void configureReminders()}
            disabled={configuringReminders}
            loading={configuringReminders}
          />
          {Platform.OS === 'android' ? (
            <View style={{ marginTop: 14, marginBottom: 6 }}>
              <View style={styles.taskTop}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.cardHeading}>后台随访监测</Text>
                  <Text style={styles.settingsSubtitle}>
                    {monitorState.enabled
                      ? monitorState.running ? '运行中 · 已启用低功耗守护' : '已开启 · 服务未运行，请查看诊断状态'
                      : '未开启 · 可自主选择常驻通知'}
                  </Text>
                </View>
                <Switch
                  value={monitorState.enabled}
                  disabled={monitorBusy || (!notificationGranted && Number(Platform.Version) < 33)}
                  onValueChange={(value) => void toggleMonitor(value)}
                  accessibilityLabel="后台随访监测"
                />
              </View>
              <Text style={styles.helperText}>
                守护服务现在运行在独立原生进程中；划掉最近任务不会主动停止它。统计仅在数据变化时同步，不联网、不轮询。可单独隐藏监测通知，而不停止后台服务。
              </Text>
              {!notificationGranted ? (
                <Text style={styles.helperText}>通知权限未授权：Android 13+ 的监测服务仍可运行，但正式随访提醒横幅会被屏蔽，请恢复通知权限。</Text>
              ) : null}
              {monitorState.lastError ? (
                <Text style={[styles.helperText, { color: theme.danger }]}>运行异常：{monitorState.lastError}</Text>
              ) : null}
              {monitorState.enabled ? (
                <View style={{ marginTop: 8 }}>
                  <PrimaryButton
                    title="监测通知显示设置（可以单独隐藏）"
                    onPress={() => void openMonitorNotificationSettings().catch((error) =>
                      Alert.alert('无法打开监测通知设置', error instanceof Error ? error.message : '请手动打开系统通知设置。'))}
                    secondary
                  />
                  <Text style={styles.helperText}>
                    可以长按监测通知，仅关闭「随访后台监测」渠道的展示，不会主动停止守护服务。不要关闭整个研伴的通知权限，否则正式提醒横幅也会消失。Android 系统的「停止应用」操作仍会终止后台运行。
                  </Text>
                </View>
              ) : null}

              {monitorState.enabled && monitorState.lastStartedAt > 0 ? (
                <Text style={styles.helperText}>
                  上次启动：{new Date(monitorState.lastStartedAt).toLocaleString('zh-CN', { hour12: false })}
                  {' · '}启动记录 {monitorState.startCount} 次
                </Text>
              ) : null}
              {monitorState.enabled && !monitorState.running ? (
                <Text style={[styles.helperText, { color: theme.danger }]}>
                  服务当前未运行；系统可能已终止后台服务。请重新进入 App 检查后台通知。
                </Text>
              ) : null}
            </View>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: reminderDetailsOpen }}
            onPress={() => setReminderDetailsOpen((value) => !value)}
            style={styles.reminderDisclosure}
          >
            <Text style={styles.reminderDisclosureText}>诊断与测试（高级）</Text>
            <SymbolView
              name={{ ios: reminderDetailsOpen ? 'chevron.up' : 'chevron.down', android: reminderDetailsOpen ? 'expand_less' : 'expand_more', web: reminderDetailsOpen ? 'expand_less' : 'expand_more' }}
              size={20}
              tintColor={theme.primary}
            />
          </Pressable>
          {reminderDetailsOpen ? (
            <View style={styles.reminderDetails}>
              <Text style={styles.helperText}>通知：{notificationGranted ? '已授权' : '未授权'} · 准点提醒：{exactAlarmGranted ? '已授权' : '未授权'}</Text>
              {Platform.OS === 'android' ? (
                <>
                  <Text style={styles.helperText}>
                    通知级别：{reminderDiagnostics ? reminderDiagnostics.highImportance ? '高' : '需调整' : '未读取'}
                    {' · '}震动：{reminderDiagnostics ? reminderDiagnostics.vibrationEnabled ? '已开启' : '未开启' : '未读取'}
                  </Text>
                  <Text style={styles.helperText}>后台限制：{reminderDiagnostics ? reminderDiagnostics.backgroundRestricted ? '系统已限制' : '未报告限制' : '未知'} · 电池优化豁免：{reminderDiagnostics?.batteryOptimizationExempt ? '已获得' : '未获得（可能受厂商优化影响）'}</Text>
                  <Text style={styles.helperText}>系统通知：{reminderDiagnostics?.notificationsEnabled ? '允许' : '受限'} · 通道重要级别：{reminderDiagnostics?.channelImportance ?? '未知'}（横幅需要至少 4）</Text>
                </>
              ) : null}
              {reminderDiagnostics && reminderDiagnostics.testScheduledAt > 0 ? (
                <Text style={styles.helperText}>
                  上次延迟测试：{reminderDiagnostics.testServiceEnteredAt > 0 || reminderDiagnostics.testReceiverReceivedAt > 0
                    ? '原生提醒已执行'
                    : '系统尚未投递提醒'}
                  {' · '}通知：{reminderDiagnostics.testNotificationPostedAt > 0 ? '已发布' : '未确认'}
                  {' · '}震动：{reminderDiagnostics.testVibrationStartedAt > 0 ? '已发起' : '未确认'}
                </Text>
              ) : null}
              {reminderDiagnostics && reminderDiagnostics.testScheduledAt > 0 ? (
                <>
                  <Text style={styles.helperText}>备援计划：{reminderDiagnostics.testFallbackAt > 0 ? new Date(reminderDiagnostics.testFallbackAt).toLocaleString("zh-CN", { hour12: false }) : "未注册"} · 广播入口：{reminderDiagnostics.testFallbackReceivedAt > 0 ? "已收到" : "尚无记录"}</Text>
                  <Text style={styles.helperText}>计划触发：{new Date(reminderDiagnostics.testScheduledAt).toLocaleString('zh-CN', { hour12: false })}</Text>
                  {reminderDiagnostics.testServiceEnteredAt > 0 || reminderDiagnostics.testReceiverReceivedAt > 0 ? (
                    <Text style={styles.helperText}>
                      原生入口到达：{new Date(reminderDiagnostics.testServiceEnteredAt > 0
                        ? reminderDiagnostics.testServiceEnteredAt : reminderDiagnostics.testReceiverReceivedAt).toLocaleString('zh-CN', { hour12: false })}
                      {' · '}较计划延迟 {Math.max(0, Math.round(((reminderDiagnostics.testServiceEnteredAt > 0
                        ? reminderDiagnostics.testServiceEnteredAt : reminderDiagnostics.testReceiverReceivedAt) - reminderDiagnostics.testScheduledAt) / 1000))} 秒
                    </Text>
                  ) : (
                    <Text style={styles.helperText}>目标组件尚无到达记录：可能是系统取消或推迟了闹钟，不能仅凭此认定震动执行失败。</Text>
                  )}
                </>
              ) : null}
              {Platform.OS === 'android' && (reminderDiagnostics?.dailyPlannedAt ?? 0) > 0 ? (
                <Text style={styles.helperText}>
                  正式随访闹钟：{new Date(reminderDiagnostics.dailyPlannedAt).toLocaleString('zh-CN', { hour12: false })}
                  {' · '}备用投递：{reminderDiagnostics.dailyFallbackAt > 0 ? '已安排' : '无精确授权'}
                  {' · '}上次通知确认：{reminderDiagnostics.dailyNotifiedAt > 0
                    ? new Date(reminderDiagnostics.dailyNotifiedAt).toLocaleString('zh-CN', { hour12: false }) : '暂无'}
                </Text>
              ) : null}
              {Platform.OS === 'android' && monitorState.enabled ? (
                <>
                  <Text style={styles.helperText}>后台服务：{monitorState.running ? '运行中' : '未运行'} · {monitorState.lastStartReason || '未记录启动原因'}</Text>
                  {monitorState.lastTaskRemovedAt > 0 ? (
                    <Text style={styles.helperText}>最近任务划出记录：{new Date(monitorState.lastTaskRemovedAt).toLocaleString('zh-CN', { hour12: false })}</Text>
                  ) : null}
                  {monitorState.lastRestoreAttemptAt > 0 ? (
                    <Text style={styles.helperText}>系统事件恢复尝试：{new Date(monitorState.lastRestoreAttemptAt).toLocaleString('zh-CN', { hour12: false })}</Text>
                  ) : null}
                </>
              ) : null}
              {reminderDiagnostics?.testError ? (
                <Text style={[styles.helperText, { color: theme.danger }]}>上次测试错误：{reminderDiagnostics.testError}</Text>
              ) : null}
              {testFeedback ? <Text style={styles.helperText}>{testFeedback}</Text> : null}
              <Text style={styles.helperText}>当前为双通道原生提醒：准点由系统直接唤起提醒服务；若未确认通知，90 秒后由独立系统广播补投一次。成功后自动去重。正常划掉任务应不影响系统闹钟，但系统级强行停止后 Android 无法保证投递。</Text>
              <View style={{ height: 12 }} />
              <PrimaryButton title="立即测试通知（震动 5 秒）" onPress={() => void testNotification(false)} secondary disabled={!notificationGranted} />
              <View style={{ height: 8 }} />
              <PrimaryButton title="一分钟后后台 / 熄屏测试" onPress={() => void testNotification(true)} secondary disabled={!notificationGranted} />
              <View style={{ height: 8 }} />
              <PrimaryButton title="刷新本次测试结果" onPress={() => void refreshNotificationPermissions()} secondary />
              {Platform.OS === 'android' ? (
                <>
                  <View style={{ height: 8 }} />
                  <PrimaryButton title="系统通知渠道" onPress={() => void openNotificationSettings()} secondary />
                  <View style={{ height: 8 }} />
                  <PrimaryButton title="设备后台设置" onPress={() => void openBackgroundSettings()} secondary />
                </>
              ) : null}
            </View>
          ) : null}
        </Card>
        <SettingsDisclosure
          title="数据与备份"
          subtitle={backupDirectoryName ? '已选择备份文件夹' : '本机加密保存 · 尚未开启文件夹备份'}
          expanded={backupDetailsOpen}
          onToggle={() => setBackupDetailsOpen((value) => !value)}
        >
          <Text style={styles.helperText}>
            患者资料保存在本机加密数据库。外部备份需要选择文件夹；恢复旧数据请在首次创建资料前选择原备份文件夹。
          </Text>
          <Text style={styles.helperText}>备份目录：{backupDirectoryName ?? '未设置'}</Text>
          <View style={{ height: 12 }} />
          <PrimaryButton
            title={changingBackupDirectory ? '正在打开文件夹选择器…' : '选择或更改备份文件夹'}
            onPress={() => void changeBackupDirectory()}
            disabled={changingBackupDirectory}
            secondary
          />
        </SettingsDisclosure>
        <SettingsDisclosure
          title="AI 服务"
          subtitle="预筛辅助分析 · 连接配置"
          expanded={aiDetailsOpen}
          onToggle={() => setAiDetailsOpen((value) => !value)}
        >
          <Text style={styles.helperText}>心电图与必要临床资料将发送到所选 AI 服务。请确认服务符合项目的数据授权要求。</Text>
          <TextField label="API Key" value={settings.apiKey} onChangeText={(v) => change('apiKey', v)} placeholder="粘贴 API Key" secureTextEntry autoCapitalize="none" />
          <TextField label="API Base URL" value={settings.baseUrl} onChangeText={(v) => change('baseUrl', v)} keyboardType="url" autoCapitalize="none" />
          <TextField label="模型名称" value={settings.model} onChangeText={(v) => change('model', v)} autoCapitalize="none" />
          <View style={{ height: 12 }} />
          <PrimaryButton title={saved ? '已保存' : '保存 AI 服务配置'} onPress={() => void save()} />
        </SettingsDisclosure>
        <SettingsDisclosure
          title="操作人信息"
          subtitle="本机审计记录的署名"
          expanded={operatorDetailsOpen}
          onToggle={() => setOperatorDetailsOpen((value) => !value)}
        >
          <TextField label="操作人姓名" value={actor} onChangeText={setActor} placeholder="用于本机审计记录" />
          <View style={{ height: 12 }} />
          <PrimaryButton title={saved ? '已保存' : '保存操作人'} onPress={() => void save()} secondary />
        </SettingsDisclosure>
        <SettingsDisclosure
          title="关于研伴"
          subtitle="应用版本与研究方案"
          expanded={aboutDetailsOpen}
          onToggle={() => setAboutDetailsOpen((value) => !value)}
        >
          <InfoLine label="应用版本" value="2.0.6-preview" />
          <InfoLine label="研究方案" value={STUDY_PROTOCOL_VERSION} />
          <Text style={styles.helperText}>AI 用于辅助预筛。正式入组仍需要授权人员人工核实。</Text>
        </SettingsDisclosure>
        <Text style={styles.privacyNote}>数据仅保存在本机，AI 预筛按所配置服务单独发送必要信息。</Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function LoadingView({ label }: { label: string }) {
  return (
    <View style={styles.loading}>
      <ActivityIndicator color={theme.primary} size="large" />
      <Text style={styles.loadingText}>{label}</Text>
    </View>
  );
}

function BackupAccessGate({ busy, onRequest, onSkip }: { busy: boolean; onRequest: () => void; onSkip: () => void }) {
  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="dark-content" />
      <ScrollView contentContainerStyle={styles.pageContent}>
        <PageHeader title="数据恢复（可选）" subtitle="如果你正在换机或重新安装，可以先恢复旧数据。首次使用可以跳过。" />
        <Card>
          <Text style={styles.cardHeading}>目录级授权</Text>
          <Text style={styles.bodyText}>
            如果已有研伴旧备份，请先在系统文件夹选择器中选定原备份文件夹。旧版本备份通常位于 Downloads/_.yanban-patient-followup；
            也可以新建一个文件夹。患者数据库和附件会加密后保存，备份仅用于本机恢复，不会上传。
          </Text>
          <Text style={styles.helperText}>
            Android 只会把你选定的文件夹及其子目录授权给研伴。建议选择专用文件夹，不要选包含其他无关文件的宽泛目录。
          </Text>
          <View style={{ height: 12 }} />
          <PrimaryButton
            title={busy ? '正在打开文件夹选择器…' : '选择文件夹并尝试恢复'}
            onPress={onRequest}
            disabled={busy}
          />
          <View style={{ height: 10 }} />
          <PrimaryButton title="没有旧备份，直接开始" onPress={onSkip} secondary disabled={busy} />
          <Text style={styles.privacyNote}>
            卸载后 Android 会撤销目录授权。重新安装后，请重新选择同一个文件夹；备份会自动识别，不需要逐个选择文件。
          </Text>
        </Card>
      </ScrollView>
    </SafeAreaView>
  );
}

function TabBar({ active, onChange }: { active: Tab; onChange: (tab: Tab) => void }) {
  const items: Array<{ id: Tab; title: string; ios: string; android: string }> = [
    { id: 'home', title: '工作台', ios: 'square.grid.2x2.fill', android: 'dashboard', },
    { id: 'patients', title: '患者', ios: 'person.2.fill', android: 'groups' },
    { id: 'followups', title: '随访', ios: 'calendar', android: 'calendar_month' },
    { id: 'settings', title: '我的', ios: 'gearshape.fill', android: 'settings' },
  ];
  return (
    <View style={styles.tabBar}>
      {items.map((item) => (
        <Pressable key={item.id} style={styles.tabItem} onPress={() => onChange(item.id)} accessibilityRole="tab" accessibilityState={{ selected: active === item.id }}>
          <SymbolView name={{ ios: item.ios as never, android: item.android as never, web: item.android as never }} size={21} tintColor={active === item.id ? theme.primary : theme.muted} />
          <Text style={[styles.tabText, active === item.id && styles.tabActive]}>{item.title}</Text>
        </Pressable>
      ))}
    </View>
  );
}

export default function App() {
  const [ready, setReady] = useState(false);
  const [fatalError, setFatalError] = useState('');
  const [backupAccessGranted, setBackupAccessGranted] = useState<boolean | null>(null);
  const [requestingBackupAccess, setRequestingBackupAccess] = useState(false);
  const skippedBackupOnboarding = useRef(false);
  const [page, setPage] = useState<Route>({ kind: 'tab' });
  const [tab, setTab] = useState<Tab>('home');
  const [actor, setActor] = useState('本机操作人');
  const [summary, setSummary] = useState<DashboardSummary>({ activePatients: 0, dueTasks: 0, overdueTasks: 0 });
  const [tasks, setTasks] = useState<FollowupTask[]>([]);
  const [screenings, setScreenings] = useState<Screening[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const initializationInProgress = useRef(false);
  const initializationComplete = useRef(false);
  const exactAlarmPermissionRef = useRef<boolean | null>(null);

  const refresh = useCallback(async (forceReminderReschedule = false) => {
    try {
      setRefreshing(true);
      const [nextSummary, nextTasks, nextScreenings, operator] = await Promise.all([
        getDashboardSummary(),
        getTasks(),
        listScreenings(),
        getOperatorName(),
      ]);
      setSummary(nextSummary);
      setTasks(nextTasks);
      setScreenings(nextScreenings);
      setActor(operator);
      const exactAlarmGranted = await getExactAlarmPermission();
      const permissionChanged = exactAlarmPermissionRef.current !== null
        && exactAlarmPermissionRef.current !== exactAlarmGranted;
      await refreshLocalReminders(forceReminderReschedule || permissionChanged);
      // Event-driven update: never poll the encrypted database from the monitor.
      await syncBackgroundMonitorSnapshot(nextTasks).catch(() => undefined);
      exactAlarmPermissionRef.current = exactAlarmGranted;
    } catch (error) {
      if (error instanceof Error) setFatalError(error.message);
    } finally {
      setRefreshing(false);
    }
  }, []);

  const initializeAfterBackupAccess = useCallback(async () => {
    if (initializationComplete.current) {
      setReady(true);
      return;
    }
    if (initializationInProgress.current) return;
    initializationInProgress.current = true;
    try {
      await getDatabase();
      await recoverInterruptedAnalyses();
      await configureNotifications();
      // Re-register native alarms after a fresh launch, including after a
      // device reboot, package update, or a force-stop that cleared PendingIntents.
      await refresh(true);
      await restoreBackgroundMonitorIfEnabled().catch(() => undefined);
      initializationComplete.current = true;
      setReady(true);
    } catch (error) {
      setFatalError(error instanceof Error ? error.message : '本地数据库初始化失败。');
    } finally {
      initializationInProgress.current = false;
    }
  }, [refresh]);

  const checkBackupAccessAndInitialize = useCallback(async () => {
    try {
      const granted = await hasAutomaticBackupAccess();
      const existingDatabase = new File(Paths.document, 'SQLite', 'patient-followup.db').exists;
      // Existing local data must never be locked out for lack of folder access.
      // On a fresh installation offer an optional restore choice first.
      const needsRecoveryChoice = !granted && !existingDatabase && !skippedBackupOnboarding.current;
      setBackupAccessGranted(!needsRecoveryChoice);
      if (needsRecoveryChoice) {
        setReady(false);
        return;
      }
      if (initializationComplete.current) {
        setReady(true);
        await refresh(true);
        // Repair an opted-in monitor after a foreground return if Android/OEM
        // evicted the native service while the React activity stayed alive.
        await restoreBackgroundMonitorIfEnabled().catch(() => undefined);
      } else {
        await initializeAfterBackupAccess();
      }
    } catch (error) {
      setFatalError(error instanceof Error ? error.message : '无法检查本机备份访问权限。');
    }
  }, [initializeAfterBackupAccess, refresh]);

  const enableBackupAccess = useCallback(async () => {
    setRequestingBackupAccess(true);
    try {
      const granted = await requestAutomaticBackupAccess();
      setBackupAccessGranted(granted);
      if (granted) await checkBackupAccessAndInitialize();
    } catch (error) {
      Alert.alert(
        '备份文件夹未设置',
        error instanceof Error ? error.message : '请在系统文件夹选择器中授权一个专用备份文件夹。',
      );
    } finally {
      setRequestingBackupAccess(false);
    }
  }, [checkBackupAccessAndInitialize]);

  const skipBackupSetup = useCallback(() => {
    skippedBackupOnboarding.current = true;
    setBackupAccessGranted(true);
    void initializeAfterBackupAccess();
  }, [initializeAfterBackupAccess]);

  useEffect(() => {
    void checkBackupAccessAndInitialize();
  }, [checkBackupAccessAndInitialize]);

  useEffect(() => {
    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      if (response.notification.request.content.data?.kind !== 'followup-reminder') return;
      setTab('followups');
      setPage({ kind: 'tab' });
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    const openFollowups = (url: string | null | undefined) => {
      if (url?.startsWith('patientfollowup://followups')) {
        setTab('followups');
        setPage({ kind: 'tab' });
      } else if (url?.startsWith('patientfollowup://home')) {
        setTab('home');
        setPage({ kind: 'tab' });
      }
    };
    void Linking.getInitialURL().then(openFollowups);
    const subscription = Linking.addEventListener('url', ({ url }) => openFollowups(url));
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void checkBackupAccessAndInitialize();
    });
    return () => subscription.remove();
  }, [checkBackupAccessAndInitialize]);

  const goTab = (next: Tab) => {
    setTab(next);
    setPage({ kind: 'tab' });
    if (next === 'home' || next === 'followups' || next === 'patients') {
      refresh().catch(() => undefined);
    }
  };

  if (fatalError) {
    return (
      <SafeAreaView style={styles.safe}>
        <StatusBar barStyle="dark-content" />
        <View style={styles.errorWrap}>
          <Text style={styles.errorMark}>!</Text>
          <Text style={styles.pageTitle}>App 初始化未完成</Text>
          <Text style={styles.errorText}>{fatalError}</Text>
          <Text style={styles.helperText}>请使用包含 SQLCipher 的原生开发构建，不要通过 Expo Go 验证加密数据库。</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (backupAccessGranted === null) {
    return <SafeAreaView style={styles.safe}><LoadingView label="正在检查本机数据恢复权限…" /></SafeAreaView>;
  }

  if (!backupAccessGranted) {
    return <BackupAccessGate busy={requestingBackupAccess} onRequest={enableBackupAccess} onSkip={skipBackupSetup} />;
  }

  if (!ready) return <SafeAreaView style={styles.safe}><LoadingView label="正在初始化本地加密空间…" /></SafeAreaView>;

  let content: React.ReactNode;
  if (page.kind === 'tab') {
    if (tab === 'home') {
      content = <HomeTab summary={summary} tasks={tasks} screenings={screenings} onOpen={setPage} onRefresh={refresh} />;
    } else if (tab === 'patients') {
      content = <PatientListPage onOpen={setPage} onRefresh={refresh} />;
    } else if (tab === 'followups') {
      content = <FollowupsPage tasks={tasks} onOpen={setPage} onRefresh={refresh} />;
    } else {
      content = <SettingsPage onOpen={setPage} onRefresh={refresh} />;
    }
  } else if (page.kind === 'patientEntry') {
    content = <PatientEntryPage onOpen={setPage} onRefresh={refresh} onBack={() => setPage({ kind: 'tab' })} />;
  } else if (page.kind === 'existingPatient') {
    content = <ExistingPatientPage actor={actor} onOpen={setPage} onRefresh={refresh} onBack={() => setPage({ kind: 'patientEntry' })} />;
  } else if (page.kind === 'screening') {
    content = <ScreeningPage id={page.id} actor={actor} onBack={() => setPage({ kind: 'tab' })} onAnalyzed={(id) => setPage({ kind: 'result', id })} onSkipped={(id) => setPage({ kind: 'consent', id })} />;
  } else if (page.kind === 'result') {
    content = <ResultPage id={page.id} actor={actor} onBack={() => setPage({ kind: 'tab' })} onOpen={setPage} onRefresh={refresh} />;
  } else if (page.kind === 'consent') {
    content = <ConsentPage id={page.id} actor={actor} onBack={() => setPage({ kind: 'tab' })} onOpen={setPage} onRefresh={refresh} />;
  } else if (page.kind === 'enrollment') {
    content = <EnrollmentPage id={page.id} actor={actor} onBack={() => setPage({ kind: 'tab' })} onOpen={setPage} onRefresh={refresh} />;
  } else if (page.kind === 'patient') {
    content = <PatientDetailPage id={page.id} actor={actor} onBack={() => setPage({ kind: 'tab' })} onOpen={setPage} onRefresh={refresh} />;
  } else if (page.kind === 'task') {
    content = <TaskDetailPage id={page.id} onBack={() => setPage({ kind: 'tab' })} onOpen={setPage} onRefresh={refresh} />;
  } else {
    content = <FollowupRecordPage id={page.id} actor={actor} onBack={() => setPage({ kind: 'tab' })} onOpen={setPage} onRefresh={refresh} />;
  }

  return (
    <SafeAreaView style={styles.safe}>
        <StatusBar barStyle="dark-content" />
      <View style={styles.appHeader}>
        <View style={styles.brandMark}>
          <SymbolView name={{ ios: 'heart.text.square.fill', android: 'medical_services', web: 'medical_services' }} size={21} tintColor="#FFFFFF" />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.brandName}>研伴</Text>
          <Text style={styles.brandCaption}>患者入组与随访</Text>
        </View>
        {refreshing ? <ActivityIndicator color={theme.primary} /> : null}
      </View>
      <View style={styles.fill}>{content}</View>
      {page.kind === 'tab' ? <TabBar active={tab} onChange={goTab} /> : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.canvas, paddingTop: Platform.OS === 'android' ? (StatusBar.currentHeight ?? 0) : 0 },
  fill: { flex: 1 },
  appHeader: {
    height: 54,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 18,
    borderBottomColor: theme.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    backgroundColor: theme.paper,
  },
  brandMark: { width: 38, height: 38, borderRadius: 12, backgroundColor: theme.primary, alignItems: 'center', justifyContent: 'center', marginRight: 11 },
  brandMarkText: { color: '#FFFFFF', fontSize: 18, fontWeight: '800' },
  brandName: { color: theme.ink, fontSize: 16, fontWeight: '700', letterSpacing: 0.2 },
  brandCaption: { color: theme.muted, fontSize: 12, marginTop: 1 },
  pageContent: { paddingHorizontal: 18, paddingTop: 20, paddingBottom: 32, gap: 14 },
  hero: { padding: 20, borderRadius: 20, backgroundColor: theme.primarySoft },
  homeTitleBlock: { paddingBottom: 2, gap: 4 },
  homeTitle: { color: theme.ink, fontSize: 28, lineHeight: 36, fontWeight: '700' },
  homeDescription: { color: theme.muted, fontSize: 14, lineHeight: 22 },
  homeDueLabel: { color: theme.primaryDark, fontSize: 14, fontWeight: '600' },
  homeDueRow: { flexDirection: 'row', alignItems: 'baseline', gap: 8, marginTop: 6 },
  homeDueNumber: { fontSize: 44, lineHeight: 52, fontWeight: '700', color: theme.ink },
  homeDueUnit: { fontSize: 14, color: theme.muted },
  homeStatRow: { flexDirection: 'row', gap: 10, marginTop: 14 },
  homeStatItem: { flex: 1, backgroundColor: theme.paper, borderRadius: 13, padding: 12 },
  homeStatNumber: { fontSize: 22, lineHeight: 27, color: theme.ink, fontWeight: '700' },
  homeStatLabel: { fontSize: 12, color: theme.muted, marginTop: 4 },
  eyebrow: { color: theme.primaryDark, letterSpacing: 0.3, fontSize: 12, fontWeight: '700' },
  heroTitle: { color: theme.ink, ...typeScale.pageTitle, marginTop: 8 },
  heroCopy: { color: theme.muted, fontSize: 16, lineHeight: 24, marginTop: 7, marginBottom: 18 },
  card: { backgroundColor: theme.paper, borderRadius: 16, padding: 18, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.border },
  entryCard: { padding: 20, minHeight: 190 },
  entryIcon: { width: 48, height: 48, borderRadius: 14, backgroundColor: theme.primarySoft, alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  entryTitle: { color: theme.ink, fontSize: 18, lineHeight: 25, fontWeight: '600' },
  entryAction: { color: theme.primary, fontSize: 14, fontWeight: '600', marginTop: 14 },
  metricRow: { flexDirection: 'row', gap: 10 },
  metricCard: { flex: 1, minHeight: 88, borderRadius: 14, padding: 15, justifyContent: 'center' },
  metricValue: { fontSize: 27, fontWeight: '700' },
  metricLabel: { fontSize: 13, color: theme.muted, marginTop: 4, fontWeight: '600' },
  sectionHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 5, marginBottom: 1 },
  sectionTitle: { color: theme.ink, ...typeScale.sectionTitle },
  sectionAction: { color: theme.primaryDark, fontSize: 13, fontWeight: '700' },
  taskCard: { paddingVertical: 14, paddingHorizontal: 15 },
  screeningCard: { paddingVertical: 14, paddingHorizontal: 15 },
  screeningAction: { color: theme.primary, fontSize: 12, fontWeight: '700', marginTop: 11, textAlign: 'right' },
  taskTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  taskPatient: { color: theme.ink, fontSize: 15, fontWeight: '600' },
  taskMeta: { color: theme.muted, ...typeScale.caption, marginTop: 4 },
  taskBottom: { flexDirection: 'row', justifyContent: 'space-between', borderTopWidth: 1, borderTopColor: '#EEF1F1', paddingTop: 10, marginTop: 12 },
  taskNode: { color: theme.ink, fontSize: 12, fontWeight: '700' },
  taskDate: { color: theme.muted, fontSize: 13 },
  badge: { paddingHorizontal: 9, paddingVertical: 5, borderRadius: 20 },
  badgeText: { fontSize: 12, fontWeight: '600' },
  pageHeader: { marginBottom: 2 },
  backButton: { marginBottom: 8, alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center', paddingRight: 12 },
  backText: { color: theme.primary, fontSize: 14, fontWeight: '700' },
  pageTitle: { color: theme.ink, ...typeScale.pageTitle },
  pageSubtitle: { color: theme.muted, fontSize: 15, marginTop: 5, lineHeight: 23 },
  label: { color: theme.ink, ...typeScale.label, marginBottom: 8 },
  requiredMark: { color: theme.danger, fontWeight: '700' },
  field: { marginTop: 14 },
  input: { borderColor: theme.border, borderWidth: 1, borderRadius: 11, color: theme.ink, fontSize: 16, paddingHorizontal: 13, paddingVertical: 12, backgroundColor: theme.paper, minHeight: 50 },
  inputMultiline: { minHeight: 88, paddingTop: 12 },
  datePickerTrigger: { borderColor: theme.border, borderWidth: 1, borderRadius: 11, backgroundColor: theme.paper, minHeight: 52, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 11 },
  datePickerValue: { flex: 1, color: theme.ink, fontSize: 16, fontWeight: '600' },
  datePickerPlaceholder: { color: theme.muted, fontWeight: '400' },
  calendarPanel: { marginTop: 8, borderWidth: 1, borderColor: theme.border, borderRadius: 14, backgroundColor: theme.paper, padding: 10 },
  calendarHeader: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  calendarNav: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 12, backgroundColor: theme.primarySoft },
  calendarMonth: { color: theme.ink, ...typeScale.cardTitle },
  calendarGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  calendarDayCell: { width: '14.2857%', height: 44, alignItems: 'center', justifyContent: 'center' },
  calendarWeekday: { color: theme.muted, fontSize: 13, fontWeight: '700' },
  calendarDay: { borderWidth: 1, borderColor: 'transparent', borderRadius: 22 },
  calendarDaySelected: { backgroundColor: theme.primary },
  calendarDayToday: { borderColor: theme.primary },
  calendarDayText: { color: theme.ink, fontSize: 14, fontWeight: '600' },
  calendarDayTextSelected: { color: '#FFFFFF', fontWeight: '700' },
  calendarHint: { color: theme.muted, fontSize: 13, textAlign: 'right', marginTop: 7 },
  button: { backgroundColor: theme.primary, borderRadius: 12, minHeight: 50, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
  buttonSecondary: { backgroundColor: theme.primarySoft },
  buttonDanger: { backgroundColor: theme.danger },
  buttonDisabled: { opacity: 0.55 },
  buttonContent: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  buttonText: { color: '#FFFFFF', fontWeight: '600', fontSize: 15 },
  buttonSecondaryText: { color: theme.primaryDark },
  choiceRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  choice: { borderColor: theme.border, borderWidth: 1, borderRadius: 10, paddingHorizontal: 15, minHeight: 48, justifyContent: 'center', backgroundColor: theme.paper },
  choiceSelected: { borderColor: theme.primary, backgroundColor: theme.primarySoft },
  choiceText: { color: theme.muted, fontWeight: '700', fontSize: 14 },
  choiceTextSelected: { color: theme.primaryDark },
  cardHeading: { color: theme.ink, ...typeScale.cardTitle, marginBottom: 3 },
  helperText: { color: theme.muted, fontSize: 14, lineHeight: 21, marginTop: 5 },
  bodyText: { color: theme.muted, ...typeScale.body, marginTop: 8 },
  ecgPreview: { width: '100%', height: 190, marginTop: 12, marginBottom: 12, backgroundColor: '#F8FAFA', borderRadius: 12 },
  privacyNote: { color: theme.muted, fontSize: 13, lineHeight: 19, textAlign: 'center', paddingHorizontal: 10, marginTop: 4 },
  emptyCard: { alignItems: 'center', paddingVertical: 26 },
  emptyMark: { color: '#9BB5B2', fontSize: 31, marginBottom: 7 },
  emptyTitle: { color: theme.ink, fontSize: 15, fontWeight: '600' },
  emptySubtitle: { color: theme.muted, fontSize: 13, lineHeight: 19, textAlign: 'center', marginTop: 5 },
  resultMark: { width: 54, height: 54, borderRadius: 18, alignItems: 'center', justifyContent: 'center', alignSelf: 'center', marginBottom: 12 },
  resultMarkText: { fontSize: 27, fontWeight: '800' },
  resultTitle: { textAlign: 'center', fontSize: 21, fontWeight: '700' },
  resultSummary: { color: theme.ink, fontSize: 14, lineHeight: 21, textAlign: 'center', marginTop: 8 },
  bullet: { color: theme.ink, fontSize: 13, lineHeight: 20, marginTop: 8 },
  evidenceItem: { borderTopColor: theme.border, borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 10, marginTop: 10 },
  evidenceTitle: { color: theme.ink, fontSize: 13, fontWeight: '600' },
  evidenceSource: { color: theme.muted, fontSize: 12, marginTop: 5 },
  successText: { color: theme.primary, fontSize: 12, fontWeight: '700', marginTop: 9, textAlign: 'center' },
  spacer: { height: 11 },
  patientCard: { paddingVertical: 14 },
  patientCardTop: { flexDirection: 'row', alignItems: 'center', gap: 11 },
  avatar: { height: 43, width: 43, backgroundColor: theme.primarySoft, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: theme.primaryDark, fontWeight: '700', fontSize: 18 },
  patientName: { color: theme.ink, fontSize: 16, fontWeight: '600' },
  patientState: { color: theme.primary, fontSize: 12, fontWeight: '600' },
  patientPhone: { color: theme.muted, fontSize: 13, marginTop: 11, marginLeft: 54 },
  infoDivider: { height: 1, backgroundColor: theme.border, marginVertical: 13 },
  infoLine: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginTop: 9 },
  infoLabel: { width: 88, color: theme.muted, fontSize: 13, lineHeight: 19 },
  infoValue: { flex: 1, color: theme.ink, fontSize: 15, lineHeight: 22 },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 16 },
  switchLabel: { color: theme.ink, fontSize: 13, fontWeight: '700' },
  buttonPair: { flexDirection: 'row', marginTop: 17 },
  recordCard: { paddingVertical: 13 },
  recordTitle: { color: theme.ink, fontSize: 13, fontWeight: '600' },
  filterRow: { flexDirection: 'row', gap: 7, marginBottom: 4 },
  filterChip: { borderRadius: 20, backgroundColor: '#E9EEEE', paddingHorizontal: 12, minHeight: 48, justifyContent: 'center' },
  filterChipSelected: { backgroundColor: theme.primary },
  filterText: { color: theme.muted, fontSize: 13, fontWeight: '600' },
  filterTextSelected: { color: '#FFFFFF' },
  settingStatusRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 10 },
  settingsDisclosureRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 48 },
  settingsSubtitle: { color: theme.muted, fontSize: 13, lineHeight: 20, marginTop: 3 },
  settingsDisclosureBody: { marginTop: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.border, paddingTop: 12 },
  reminderReadinessRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
  reminderStatusDot: { width: 9, height: 9, borderRadius: 5 },
  reminderReadinessText: { color: theme.ink, fontSize: 14, fontWeight: '700' },
  reminderDisclosure: { minHeight: 48, marginTop: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  reminderDisclosureText: { color: theme.primaryDark, fontSize: 14, fontWeight: '600' },
  reminderDetails: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.border, paddingTop: 8 },
  reminderTestHint: { color: theme.ink, fontSize: 13, lineHeight: 19, marginTop: 12 },
  tabBar: { flexDirection: 'row', backgroundColor: theme.paper, borderTopColor: theme.border, borderTopWidth: StyleSheet.hairlineWidth, height: 68, paddingBottom: Platform.OS === 'ios' ? 5 : 0 },
  tabItem: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 3, minHeight: 48 },
  tabText: { color: theme.muted, fontSize: 12, fontWeight: '600' },
  tabActive: { color: theme.primary },
  followupListContent: { paddingHorizontal: 20, paddingTop: 20, paddingBottom: 32, flexGrow: 1 },
  followupsHeader: { gap: 12, marginBottom: 4 },
  followupListSeparator: { height: 12 },
  followupPatientCard: { paddingVertical: 15, paddingHorizontal: 16 },
  followupPatientTop: { flexDirection: 'row', alignItems: 'center', gap: 11 },
  followupPatientSummary: { color: theme.ink, fontSize: 14, lineHeight: 20, marginTop: 13, fontWeight: '500' },
  followupPatientNext: { color: theme.muted, fontSize: 13, lineHeight: 19, marginTop: 5 },
  refreshPatientsButton: { minHeight: 48, minWidth: 48, paddingHorizontal: 8, alignItems: 'center', justifyContent: 'center' },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  loadingText: { color: theme.muted, fontSize: 13, marginTop: 12 },
  errorWrap: { flex: 1, justifyContent: 'center', padding: 28, gap: 12 },
  errorMark: { color: theme.danger, fontWeight: '800', fontSize: 38 },
  errorText: { color: theme.ink, fontSize: 15, lineHeight: 23 },
});

