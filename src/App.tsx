import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Alert,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Linking,
  Modal,
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
import { File, Paths } from 'expo-file-system';
import * as Notifications from 'expo-notifications';
import { SymbolView } from 'expo-symbols';
import {
  addExistingPatient,
  recordDeclinedRegistration,
  exitPatient,
  getDashboardSummary,
  getPatient,
  getLatestConsent,
  getLatestQualificationVerification,
  getTasks,
  listDueFollowupContacts,
  listFollowupRecords,
  listPatientTasks,
  listPatients,
  listScreenings,
  recoverInterruptedAnalyses,
  recordFollowup,
  DuplicatePatientError,
  type DueFollowupContact,
} from './storage/repository';
import { getDatabase } from './storage/database';
import {
  getAutomaticBackupDirectoryName,
  hasAutomaticBackupAccess,
  requestAutomaticBackupAccess,
  startAutomaticBackup,
} from './services/automaticBackup';
import {
  configureNotifications,
  getExactAlarmPermission,
  getReminderDiagnostics,
  openAppNotificationSettings,
  openNotificationChannelSettings,
  requestBatteryOptimizationExemption,
  openBatteryOptimizationSettings,
  openAppBatterySettings,
  refreshLocalReminders,
  requestExactAlarmPermission,
  requestNotificationPermission,
  scheduleTestNotificationInOneMinute,
  sendTestNotificationNow,
  type ReminderDiagnostics,
} from './services/notifications';
import {
  getOperatorName,
  setOperatorName,
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
import FollowupCalendarHome from './FollowupCalendarHome';
import { calendarReminderStatus, requestCalendarAccess, writableCalendars, configureCalendarReminder, syncCalendarFollowups, preferredWritableCalendars, createCalendarRingingTest, openCalendarRingingTest, openNextCalendarReminder, type WritableCalendar, type CalendarReminderStatus } from './services/calendarReminders';
import {
  EMPTY_CLINICAL_INFO,
  type DashboardSummary,
  type FollowupTask,
  type Gender,
  type Patient,
  type Screening,
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

function EmptyState({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <Card style={styles.emptyCard}>
      <SymbolView name={{ ios: 'tray', android: 'inbox', web: 'inbox' }} size={30} tintColor={theme.muted} />
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptySubtitle}>{subtitle}</Text>
    </Card>
  );
}

/**
 * Patient details stay inside the unlocked, foreground React Native app.
 * The ongoing Android monitor receives aggregate counts only, never names or
 * phone numbers. Modal is deliberately not a system-level notification.
 */
function TodayFollowupDialog({
  visible,
  contacts,
  onClose,
  onDial,
  onOpenTask,
}: {
  visible: boolean;
  contacts: DueFollowupContact[];
  onClose: () => void;
  onDial: (phone: string) => void;
  onOpenTask: (taskId: string) => void;
}) {
  const todayCount = contacts.filter((contact) => contact.dueTodayCount > 0).length;
  const overdueCount = contacts.filter((contact) => contact.overdueCount > 0).length;
  return (
    <Modal
      visible={visible}
      animationType="fade"
      transparent
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={styles.briefingOverlay}>
        <Pressable
          accessibilityLabel="关闭今日随访清单"
          accessibilityRole="button"
          style={StyleSheet.absoluteFill}
          onPress={onClose}
        />
        <View style={styles.briefingPanel}>
          <View style={styles.briefingTop}>
            <View style={styles.briefingHeaderText}>
              <Text style={styles.briefingEyebrow}>
                {new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })}
              </Text>
              <Text style={styles.briefingTitle}>今日随访速览</Text>
              <Text style={styles.briefingSubtitle}>
                {contacts.length > 0
                  ? contacts.length + ' 位患者待联系 · 今日到期 ' + todayCount + ' 位 · 含逾期 ' + overdueCount + ' 位'
                  : '今天暂无需要联系的患者'}
              </Text>
            </View>
            <Pressable
              style={styles.briefingClose}
              accessibilityRole="button"
              accessibilityLabel="关闭弹窗"
              onPress={onClose}
            >
              <Text style={styles.briefingCloseText}>×</Text>
            </Pressable>
          </View>
          {contacts.length === 0 ? (
            <View style={styles.briefingEmpty}>
              <Text style={styles.briefingEmptyIcon}>✓</Text>
              <Text style={styles.briefingEmptyTitle}>今日待办已清空</Text>
              <Text style={styles.briefingEmptyCaption}>有新的到期随访时会自动显示在这里。</Text>
            </View>
          ) : (
            <ScrollView
              style={styles.briefingList}
              contentContainerStyle={styles.briefingListContent}
              showsVerticalScrollIndicator={contacts.length > 4}
            >
              {contacts.map((contact) => (
                <View key={contact.patientId} style={styles.briefingContact}>
                  <View style={styles.briefingContactMain}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.briefingPatientName} numberOfLines={1}>
                        {contact.patientName || '姓名未填写'}
                      </Text>
                      <Text style={styles.briefingPatientMeta} numberOfLines={2}>
                        {contact.patientNumber + ' · ' + contact.nodeMonths.map((month) => '第' + month + '月').join(' / ')}
                      </Text>
                    </View>
                    <Text
                      style={[
                        styles.briefingStatus,
                        contact.dueTodayCount === 0 && styles.briefingStatusOverdue,
                      ]}
                    >
                      {contact.dueTodayCount > 0
                        ? contact.overdueCount > 0 ? '今日到期·含逾期' : '今日到期'
                        : '已逾期'}
                    </Text>
                  </View>
                  <View style={styles.briefingContactActions}>
                    {contact.phone.trim() ? (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={'打开拨号盘：' + contact.patientName + '，' + contact.phone}
                        onPress={() => onDial(contact.phone)}
                        style={styles.briefingDialButton}
                      >
                        <Text style={styles.briefingDialText} numberOfLines={1}>☎  {contact.phone}</Text>
                        <Text style={styles.briefingDialArrow}>›</Text>
                      </Pressable>
                    ) : (
                      <Text style={styles.briefingNoPhone}>未登记联系电话</Text>
                    )}
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => onOpenTask(contact.firstTaskId)}
                      style={styles.briefingTaskLink}
                    >
                      <Text style={styles.briefingTaskLinkText}>查看任务</Text>
                    </Pressable>
                  </View>
                </View>
              ))}
            </ScrollView>
          )}
          <View style={styles.briefingFooter}>
            <Text style={styles.briefingPrivacy}>仅在 App 内显示患者信息 · 拨号前由你确认</Text>
            <Pressable accessibilityRole="button" onPress={onClose} style={styles.briefingDone}>
              <Text style={styles.briefingDoneText}>进入工作台</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function HomePage({
  summary, tasks, onOpen, onRefresh,
  onOpenFollowups,
}: Props & { summary: DashboardSummary; tasks: FollowupTask[]; screenings: Screening[]; onOpenFollowups: () => void }) {
  return (
    <FollowupCalendarHome
      summary={summary}
      tasks={tasks}
      onOpenTask={(id) => onOpen({ kind: 'task', id })}
      onAddPatient={() => onOpen({ kind: 'patientEntry' })}
      onOpenFollowups={onOpenFollowups}
      onRefresh={() => { void onRefresh(); }}
    />
  );
}

// Local DB mutations are authoritative; calendar errors are nonfatal and
// explicitly reported AFTER saving, never presented as failed patient writes.
async function reconcileAfterPatientMutation(): Promise<string | null> {
  try {
    await refreshLocalReminders();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : '手机日历暂时不可用';
  }
}

function PatientEntryPage({ onOpen, onBack, onRefresh, actor }: BackProps & { actor: string }) {
  const [step, setStep] = useState<1 | 2>(1);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [age, setAge] = useState('');
  const [gender, setGender] = useState<Gender>('其他');
  const [groupName, setGroupName] = useState<'用药组' | '不用药组' | undefined>();
  const [enrollmentAt, setEnrollmentAt] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [syncingCalendar, setSyncingCalendar] = useState(false);
  const locked = useRef(false);

  const next = () => {
    if (!name.trim() || !phone.trim()) {
      Alert.alert('请补全基本资料', '患者姓名、联系电话为必填项。');
      return;
    }
    if (phone.replace(/\D/g, '').length < 3) {
      Alert.alert('电话格式不正确', '请检查患者联系电话。');
      return;
    }
    if (!groupName) {
      Alert.alert('请选择研究组别', '请明确选择用药组或不用药组。');
      return;
    }
    if (!parseLocalDate(enrollmentAt)) {
      Alert.alert('请选择入组日期', '请通过日历选择患者入组日期。');
      return;
    }
    if (age.trim() && (!Number.isInteger(Number(age)) || Number(age) < 1 || Number(age) > 130)) {
      Alert.alert('年龄格式不正确', '年龄为可选项，如填写请输入 1 到 130 的整数。');
      return;
    }
    setStep(2);
  };

  const finish = async (agreed: boolean) => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    try {
      if (agreed && !groupName) throw new Error('请返回第一步选择研究组别。');
      if (!agreed) {
        await recordDeclinedRegistration({
          name, age: age.trim() ? Number(age) : undefined, gender, notes, actor,
        });
        await onRefresh();
        Alert.alert('已记录患者不同意', '未创建正式患者，也没有生成随访计划。');
        onBack();
        return;
      }
      if (!groupName) throw new Error('请先选择研究组别。');
      const patientId = await addExistingPatient({
        name, phone, age: age.trim() ? Number(age) : undefined,
        gender, groupName, enrollmentAt, notes,
        clinical: EMPTY_CLINICAL_INFO,
        consentDecision: 'AGREED', actor,
      });
      setSyncingCalendar(true);
      const calendarError = await reconcileAfterPatientMutation();
      setSyncingCalendar(false);
      await onRefresh();
      if (calendarError) {
        Alert.alert('患者入组成功 · 日历待同步', `患者资料和随访任务已安全保存。日历同步未完成：${calendarError}。下次启动或手动同步时会重试。`);
      }
      onOpen({ kind: 'patient', id: patientId });
    } catch (error) {
      if (error instanceof DuplicatePatientError) Alert.alert('患者可能已经存在', error.message);
      else Alert.alert('无法完成登记', error instanceof Error ? error.message : '请检查资料后重试。');
    } finally {
      locked.current = false;
      setBusy(false);
      setSyncingCalendar(false);
    }
  };

  return (
    <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.pageContent} keyboardShouldPersistTaps="handled">
        <PageHeader title={step === 1 ? '入组患者信息登记' : '患者同意确认'}
          subtitle={step === 1 ? '第 1 步 / 共 2 步 · 集中填写患者资料' : '第 2 步 / 共 2 步 · 同意后直接完成入组'}
          onBack={step === 1 ? onBack : () => setStep(1)} />
        <View style={styles.registrationSteps}>
          <View style={[styles.registrationStep, styles.registrationStepActive]}>
            <Text style={styles.registrationStepLabel}>01 患者信息</Text>
          </View>
          <View style={[styles.registrationStep, step === 2 && styles.registrationStepActive]}>
            <Text style={styles.registrationStepLabel}>02 同意确认</Text>
          </View>
        </View>
        {step === 1 ? (
          <>
            <Card>
              <Text style={styles.cardHeading}>患者信息</Text>
              <Text style={styles.helperText}>只保留必要资料，其余情况写在备注框里。</Text>
              <TextField label="姓名 *" value={name} onChangeText={setName} placeholder="患者姓名" />
              <TextField label="联系电话 *" value={phone} onChangeText={setPhone} keyboardType="phone-pad" placeholder="用于后续电话随访" />
              <TextField label="年龄（选填）" value={age} onChangeText={setAge} keyboardType="numeric" placeholder="周岁" />
              <ChoiceRow label="性别（选填）" options={['其他', '男', '女']} value={gender} onChange={setGender} />
              <ChoiceRow label="研究组别 *" options={['用药组', '不用药组']} value={groupName} onChange={setGroupName} />
              <EnrollmentDatePicker label="入组日期 *" value={enrollmentAt} onChange={setEnrollmentAt} />
            </Card>
            <Card>
              <Text style={styles.cardHeading}>备注信息（选填）</Text>
              <Text style={styles.helperText}>临床情况、诊断和其他需要记录的内容都可以写在这里，没有可留空。</Text>
              <TextInput value={notes} onChangeText={setNotes}
                accessibilityLabel="患者备注信息"
                multiline textAlignVertical="top"
                placeholder="输入需要补充的患者资料、情况说明或备注…"
                placeholderTextColor={theme.muted}
                style={[styles.input, styles.registrationNotes]} />
            </Card>
            <PrimaryButton title="下一步 · 确认患者同意" onPress={next} disabled={busy} />
          </>
        ) : (
          <>
            <Card>
              <Text style={styles.cardHeading}>患者是否同意入组？</Text>
              <Text style={styles.helperText}>请按照研究流程向患者充分说明相关事项并完成知情同意。这里记录同意结果，不替代正式的知情同意文件。</Text>
              <View style={styles.infoDivider} />
              <InfoLine label="姓名" value={name.trim()} />
              <InfoLine label="联系电话" value={phone.trim()} />
              <InfoLine label="组别" value={groupName ?? "未选择"} />
              <InfoLine label="入组日期" value={enrollmentAt} />
              {notes.trim() ? <InfoLine label="备注" value={notes.trim()} /> : null}
            </Card>
            <PrimaryButton title={syncingCalendar ? '已保存 · 正在核对日历…' : busy ? '正在办理入组…' : '患者同意 · 直接完成入组'} onPress={() => { void finish(true); }} disabled={busy} />
            <PrimaryButton title="患者不同意 · 不创建随访任务" secondary disabled={busy} onPress={() => {
              Alert.alert('确认患者不同意？', '仅保存不同意记录，不创建患者档案或随访计划。', [
                { text: '返回', style: 'cancel' },
                { text: '确认不同意', style: 'destructive', onPress: () => { void finish(false); } },
              ]);
            }} />
            <Text style={styles.privacyNote}>同意后直接创建患者档案和第 1、3、6、12 个月随访，不再填写额外核实页面。</Text>
          </>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function SectionHeading({ title, action, onPress }: { title: string; action?: string; onPress?: () => void }) {
  return <View style={styles.sectionHeading}>
    <Text style={styles.sectionTitle}>{title}</Text>
    {action && onPress ? <Pressable onPress={onPress}><Text style={styles.sectionAction}>{action}  ›</Text></Pressable> : null}
  </View>;
}

function TaskCard({ task, onPress }: { task: FollowupTask; onPress: () => void }) {
  return <Pressable accessibilityRole="button" onPress={onPress}>
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
  </Pressable>;
}

function HomeTab({ summary, tasks, screenings, onOpen, onRefresh, onOpenFollowups }: Props & { summary: DashboardSummary; tasks: FollowupTask[]; screenings: Screening[]; onOpenFollowups: () => void }) {
  return <HomePage summary={summary} tasks={tasks} screenings={screenings} onOpen={onOpen} onRefresh={onRefresh} onOpenFollowups={onOpenFollowups} />;
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
        <EmptyState title={patients.length ? '没有找到匹配记录' : '还没有正式入组患者'} subtitle={patients.length ? '试试患者姓名或编号。' : '完成患者信息登记并确认同意后，患者会出现在这里。'} />
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
  const [exitBusy, setExitBusy] = useState(false);
  const [tasks, setTasks] = useState<FollowupTask[]>([]);
  const [consent, setConsent] = useState<Awaited<ReturnType<typeof getLatestConsent>>>();
  const [qualification, setQualification] = useState<Awaited<ReturnType<typeof getLatestQualificationVerification>>>();
  const load = useCallback(async () => {
    const record = await getPatient(id);
    setPatient(record);
    setTasks(await listPatientTasks(id));
    if (record) {
      const [consentRecord, verificationRecord] = await Promise.all([
        getLatestConsent(record.screeningId),
        getLatestQualificationVerification(record.screeningId),
      ]);
      setConsent(consentRecord);
      setQualification(verificationRecord);
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
          if (exitBusy) return;
          setExitBusy(true);
          let exited = false;
          try {
            await exitPatient(patient.id, '用户手动确认患者退出', actor);
            exited = true;
            const calendarError = await reconcileAfterPatientMutation();
            await onRefresh();
            await load();
            if (calendarError) Alert.alert('患者已退出 · 日历待同步',
              `患者退出状态已保存。日历核对未完成：${calendarError}，下次打开研伴会自动重试。`);
          } catch (error) {
            Alert.alert(exited ? '患者已退出 · 页面刷新异常' : '退出失败',
              error instanceof Error ? error.message : '请重试。');
          } finally {
            setExitBusy(false);
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
      </Card>
      <Card>
        <Text style={styles.cardHeading}>患者同意与历史核实记录</Text>
        <InfoLine label="患者选择" value={consent?.decision === 'AGREED' ? '同意参加' : consent?.decision === 'DECLINED' ? '不同意' : consent?.decision === 'NOT_RECORDED' ? '未记录' : '暂无记录'} />
        {consent ? <InfoLine label="记录时间" value={new Date(consent.createdAt).toLocaleString()} /> : null}
        {consent ? <InfoLine label="记录操作人" value={consent.actor} /> : null}
        {consent ? <InfoLine label="证明材料" value={consent.evidencePath ? '已提交加密图片' : '未提交（可选）'} /> : null}
        <View style={styles.infoDivider} />
        <InfoLine label="资格核实" value={qualification?.verified ? '已核实' : qualification ? '有记录，未标记已核实' : '暂无记录'} />
        {qualification ? <InfoLine label="核实人" value={qualification.verifier} /> : null}
        {qualification ? <InfoLine label="核实时间" value={new Date(qualification.createdAt).toLocaleString()} /> : null}
        {qualification?.note ? <InfoLine label="核实说明" value={qualification.note} /> : null}
      </Card>
      <SectionHeading title="随访计划" />
      {tasks.map((task) => <TaskCard key={task.id} task={task} onPress={() => onOpen({ kind: 'task', id: task.id })} />)}
      {patient.status === 'ACTIVE' ? (
        <PrimaryButton title={exitBusy ? "正在退出并核对日历…" : "患者退出研究"} onPress={confirmExit} disabled={exitBusy} danger />
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
      const calendarError = completed ? await reconcileAfterPatientMutation() : null;
      await onRefresh();
      if (calendarError) {
        Alert.alert('随访已保存 · 日历待同步', `随访记录已保存；日历同步失败：${calendarError}。`);
      }
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
  const [operatorDetailsOpen, setOperatorDetailsOpen] = useState(false);
  const [aboutDetailsOpen, setAboutDetailsOpen] = useState(false);
  const [configuringReminders, setConfiguringReminders] = useState(false);
  const [calendarReminder, setCalendarReminder] = useState<CalendarReminderStatus | null>(null);
  const [calendarOptions, setCalendarOptions] = useState<WritableCalendar[]>([]);
  const [calendarBusy, setCalendarBusy] = useState(false);
  const [calendarAdvanced, setCalendarAdvanced] = useState(false);
  const [calendarTestCreated, setCalendarTestCreated] = useState(false);
  // Only ask for a channel-settings review once per settings-page visit.
  // Android does not expose a runtime permission to enable heads-up or lock-screen display.
  const channelReviewPrompted = useRef(false);
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
  const refreshCalendarStatus = useCallback(async () => {
    if (Platform.OS !== 'android') return;
    const status = await calendarReminderStatus();
    setCalendarReminder(status);
  }, []);
  const enableCalendarReminders = async () => {
    if (calendarBusy) return;
    setCalendarBusy(true);
    try {
      if (!(await requestCalendarAccess())) {
        Alert.alert('需要日历权限', '请允许日历读取和写入，研伴才能创建及核对随访日程。拒绝权限不会影响患者登记。');
        await refreshCalendarStatus();
        return;
      }
      const calendars = await writableCalendars();
      const ordinary = preferredWritableCalendars(calendars);
      setCalendarOptions(calendars);
      await refreshCalendarStatus();
      if (!calendars.length) {
        Alert.alert('没有可写日历', '请先打开手机日历，创建并保存一条普通日程，再返回研伴重试。');
      } else if (calendarReminder?.enabled) {
        setCalendarAdvanced(true);
      } else {
        const local = ordinary.find(item => item.isLocal);
        if (local) {
          // Prefer the ordinary phone-local calendar without exposing provider
          // account identifiers or special birthday/countdown calendars.
          await configureCalendarReminder(local.id, true);
          await syncCalendarFollowups(await getTasks());
          await onRefresh(true);
          setCalendarReminder(await calendarReminderStatus());
          setCalendarAdvanced(false);
          Alert.alert('已连接手机本地日历', '已同步未来随访日程。请继续点击“测试日历响铃”，检查手机日历的响铃提醒开关。');
        } else {
          setCalendarAdvanced(true);
          Alert.alert('请选择普通日历', '没有识别到手机本地日历。请选择日常使用的普通日历，避免生日或其他应用的专用日历。');
        }
      }
    } catch (error) {
      Alert.alert('无法读取手机日历', error instanceof Error ? error.message : '请检查系统日历权限。');
    } finally {
      setCalendarBusy(false);
    }
  };
  const selectCalendarReminder = async (calendar: WritableCalendar) => {
    if (calendarBusy) return;
    setCalendarBusy(true);
    try {
      const next = await configureCalendarReminder(calendar.id, true);
      setCalendarReminder(next);
      // Surface sync failure to the user. The existing native alarm is not
      // cancelled until the Calendar Provider write succeeds.
      await syncCalendarFollowups(await getTasks());
      await refreshLocalReminders(true);
      await onRefresh(true);
      setCalendarReminder(await calendarReminderStatus());
      setCalendarAdvanced(false);
      Alert.alert('日历提醒已开启', '研伴已向所选日历写入未来随访日期。每天 09:30、19:00 各一条提醒，不包含患者信息和数量。请另外确认该日历应用的通知和锁屏提醒设置。');
    } catch (error) {
      Alert.alert('日历同步未成功', error instanceof Error ? error.message : '请返回检查权限和日历账户。');
    } finally {
      setCalendarBusy(false);
    }
  };
  const disableCalendarReminders = async () => {
    if (calendarBusy) return;
    setCalendarBusy(true);
    try {
      const next = await configureCalendarReminder(null, false);
      setCalendarReminder(next);
      setCalendarOptions([]);
      await refreshLocalReminders(true);
      await onRefresh(true);
      Alert.alert('已切回研伴提醒', '已尝试删除研伴创建的未来日历日程，原生提醒重新启用。');
    } catch (error) {
      Alert.alert('切换失败', error instanceof Error ? error.message : '请检查日历权限后重试。');
    } finally {
      setCalendarBusy(false);
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
      getOperatorName(),
      getAutomaticBackupDirectoryName(),
      refreshNotificationPermissions(),
      refreshMonitorStatus(),
      refreshCalendarStatus(),
    ])
      .then(([operator, directoryName]) => {
        setActor(operator);
        setBackupDirectoryName(directoryName);
      })
      .catch(() => undefined);
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void refreshNotificationPermissions();
        void refreshMonitorStatus();
        void refreshCalendarStatus();
      }
    });
    return () => subscription.remove();
  }, [refreshNotificationPermissions, refreshMonitorStatus, refreshCalendarStatus]);
  const save = async () => {
    try {
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
        if (!diagnostics.notificationsEnabled || !diagnostics.highImportance || !diagnostics.vibrationEnabled) {
          Alert.alert('还需完成通知渠道设置', '请为“患者随访提醒”开启允许通知、横幅（悬浮通知）、锁屏显示与震动，并选择响铃或重要通知。Android 不允许 App 代替你打开这些系统开关。', [
            { text: '稍后', style: 'cancel' },
            { text: '打开通知渠道', onPress: () => { channelReviewPrompted.current = true; void openNotificationSettings(); } },
          ]);
          return;
        }
        if (!channelReviewPrompted.current) {
          Alert.alert('请确认横幅与锁屏显示', '基础通知权限已经通过。但 Android 的横幅、锁屏展示通常是独立系统设置，无法由研伴自动申请或修改。请进入“患者随访提醒”通知渠道，打开横幅（悬浮通知）、锁屏显示和震动；返回后可重新检查并发送测试通知。', [
            { text: '稍后', style: 'cancel' },
            { text: '打开通知渠道', onPress: () => { channelReviewPrompted.current = true; void openNotificationSettings(); } },
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
        '通知、精确提醒和可读取的通知渠道设置均已满足。请另外确认系统“横幅/悬浮通知”和“锁屏显示”已开启；这两项设置可能无法由 App 读取。部分手机厂商的自启动设置也需手动允许。',
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
      await openAppBatterySettings();
    } catch (error) {
      Alert.alert('无法打开系统设置', error instanceof Error ? error.message : '请在手机设置中找到研伴的电池或后台运行设置。');
    }
  };
  const requestReliableBackground = () => {
    Alert.alert(
      '申请后台提醒运行授权',
      '通知和精确闹钟权限均已开启，但系统电池优化可能使息屏提醒延迟。你可以自愿允许系统不优化研伴，以改善重要随访提醒的后台送达；并不能保证永久保活。',
      [
        { text: '暂不', style: 'cancel' },
        {
          text: '打开系统授权',
          onPress: () => void requestBatteryOptimizationExemption().catch((error) =>
            Alert.alert('无法打开授权页面', error instanceof Error ? error.message : '请使用下方「系统电池优化列表」手动调整。')),
        },
      ],
    );
  };
  const standbyBucketLabel = (bucket?: number) => {
    switch (bucket) {
      case 10: return '活跃';
      case 20: return '工作集';
      case 30: return '频繁';
      case 40: return '罕用';
      case 45: return '受限';
      case 50: return '从未使用';
      default: return '未提供';
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
        {Platform.OS === 'android' ? (
          <Card>
            <View style={styles.taskTop}>
              <View style={{ flex: 1 }}>
                <Text style={styles.cardHeading}>手机日历提醒</Text>
                <Text style={styles.settingsSubtitle}>推荐 · 由日历应用独立提醒</Text>
              </View>
              <View style={[styles.reminderStatusDot, { backgroundColor: calendarReminder?.enabled && calendarReminder.permissionGranted ? theme.success : theme.accent }]} />
            </View>
            <Text style={styles.helperText}>同一天共用两条日程：「研伴 · 今日随访提醒」，上午 09:30 与晚上 19:00 通知，不展示患者姓名、电话或数量。未来日程以研伴数据库为准；写入后由手机日历应用负责提醒。</Text>
            <Text style={styles.helperText}>
              状态：{calendarReminder?.enabled ? calendarReminder.permissionGranted ? '已开启' : '已开启但日历权限失效' : '尚未开启'}
              {' · '}已同步日期 {calendarReminder?.syncedDates ?? 0}
            </Text>
            <Text style={styles.helperText}>日历账户可能云同步日程标题与时间。建议优先使用手机本地日历。</Text>
            <View style={{ height: 10 }} />
            <PrimaryButton
              title={calendarBusy ? '正在处理…' : calendarReminder?.enabled ? '更换日历（高级设置）' : '一键开启 · 优先使用本地日历'}
              disabled={calendarBusy}
              onPress={() => void enableCalendarReminders()} />
            {calendarAdvanced ? (
              <View style={{ marginTop: 12 }}>
                <Text style={styles.cardHeading}>选择用于提醒的日历</Text>
                <Text style={styles.helperText}>已隐藏生日、纪念日、倒数日等专用日历；只有高级选项会展示技术账户。</Text>
                {preferredWritableCalendars(calendarOptions).map(calendar => (
                  <Pressable key={calendar.id} accessibilityRole="button"
                    onPress={() => void selectCalendarReminder(calendar)} disabled={calendarBusy}
                    style={[styles.calendarOptionRow, calendar.id === calendarReminder?.calendarId && styles.calendarOptionSelected]}>
                    <Text style={styles.calendarOptionName}>{calendar.isLocal ? '手机本地日历' : calendar.name}</Text>
                    <Text style={styles.helperText}>{calendar.isLocal ? '推荐 · 存储在本机' : '账户日历 · 可能同步到云端'}{calendar.id === calendarReminder?.calendarId ? ' · 已选' : ''}</Text>
                  </Pressable>
                ))}
                {preferredWritableCalendars(calendarOptions).length === 0 ? (
                  <Text style={styles.helperText}>没有识别到普通可写日历。请先在手机日历中创建普通日历。</Text>
                ) : null}
                <Pressable accessibilityRole="button" onPress={() => setCalendarAdvanced(false)} style={styles.calendarOptionRow}>
                  <Text style={styles.calendarOptionName}>收起高级设置</Text>
                </Pressable>
              </View>
            ) : null}
            {calendarReminder?.enabled ? (
              <View style={{ marginTop: 12, gap: 8 }}>
                <Text style={styles.cardHeading}>响铃设置 · 请务必验证</Text>
                <Text style={styles.helperText}>研伴已请求系统日历在 09:00 提醒，但 OPPO / 一加日历的“响铃提醒”是独立开关，普通日历接口无法替你强制打开。</Text>
                <PrimaryButton title={calendarBusy ? '正在创建测试…' : '创建 2 分钟后的日历响铃测试'} disabled={calendarBusy}
                  onPress={() => {
                    setCalendarBusy(true);
                    createCalendarRingingTest()
                      .then(() => {
                        setCalendarTestCreated(true);
                        Alert.alert('日历测试已创建', '约 2 分钟后开始。请立即打开测试日程，手动打开“响铃提醒”开关，然后返回桌面锁屏等待。', [
                          { text: '稍后', style: 'cancel' },
                          { text: '打开测试日程', onPress: () => void openCalendarRingingTest().catch(error =>
                            Alert.alert('无法打开日历', error instanceof Error ? error.message : '请手动打开日历。')) },
                        ]);
                      })
                      .catch(error => Alert.alert('创建测试失败', error instanceof Error ? error.message : '请选择有效日历。'))
                      .finally(() => setCalendarBusy(false));
                  }} />
                {calendarTestCreated ? (
                  <PrimaryButton title="打开测试日程 · 设置响铃提醒" secondary
                    onPress={() => void openCalendarRingingTest().catch(error => Alert.alert('无法打开日历', error instanceof Error ? error.message : '请手动打开日历。'))} />
                ) : null}
                <PrimaryButton title="打开下一条正式随访日程 · 检查响铃" secondary
                  onPress={() => void openNextCalendarReminder().then(found => {
                    if (!found) Alert.alert('暂无未来随访日程', '当前没有已同步的未来日期。可以先创建 2 分钟测试。');
                  }).catch(error => Alert.alert('无法打开日程', error instanceof Error ? error.message : '请手动打开日历。'))} />
                <Text style={styles.helperText}>如果测试没有响铃，请检查系统日历 App 的通知、声音、锁屏和该日程的“响铃提醒”开关。不能以“日程已创建”代表响铃成功。</Text>
              </View>
            ) : null}
            {calendarReminder?.enabled ? (
              <>
                <View style={{ height: 8 }} />
                <PrimaryButton title={calendarBusy ? '正在处理…' : '立即重新同步日历'} secondary disabled={calendarBusy}
                  onPress={() => {
                    setCalendarBusy(true);
                    refreshLocalReminders(true).then(() => onRefresh(true)).then(() => refreshCalendarStatus())
                      .then(() => Alert.alert('同步请求已提交', '请检查上方状态和系统日历的未来随访日程。'))
                      .catch(error => Alert.alert('同步失败', error instanceof Error ? error.message : '请检查权限。'))
                      .finally(() => setCalendarBusy(false));
                  }} />
                <View style={{ height: 8 }} />
                <PrimaryButton title="关闭日历提醒 · 恢复研伴闹钟" secondary disabled={calendarBusy} onPress={() => {
                  Alert.alert('切换回研伴闹钟？', '研伴将删除自己创建的日历日程，恢复原生闹钟。', [
                    { text: '取消', style: 'cancel' },
                    { text: '切换', onPress: () => void disableCalendarReminders() },
                  ]);
                }} />
              </>
            ) : null}
          </Card>
        ) : null}
        <Card>
          <View style={styles.taskTop}>
            <View style={{ flex: 1 }}>
              <Text style={styles.cardHeading}>原生闹钟（备用 / 测试）</Text>
              <Text style={styles.settingsSubtitle}>日历提醒未启用时使用</Text>
            </View>
            <View style={[styles.reminderStatusDot, { backgroundColor: reminderReady && (Platform.OS !== 'android' || Boolean(reminderDiagnostics?.batteryOptimizationExempt)) ? theme.success : theme.accent }]} />
          </View>
          <Text style={[styles.reminderReadinessText, { marginTop: 12 }]}>
            {!reminderReady ? '基础提醒权限尚未配置完整'
              : Platform.OS === 'android' && !reminderDiagnostics?.batteryOptimizationExempt
                ? '提醒权限已开启 · 仍存在电池后台限制风险'
                : '基础提醒权限已开启'}
          </Text>
          <Text style={styles.helperText}>
            {calendarReminder?.enabled
              ? '当前正式随访提醒已交给手机日历。本区域仅用于旧版原生闹钟的备用配置与通知测试；日历通知需到日历应用中单独开启。'
              : '尚未启用日历模式时，正式提醒仍使用研伴原生闹钟。请确认研伴通知渠道、横幅、锁屏和震动已启用。'}
          </Text>
          {Platform.OS === 'android' ? (
            <View style={{ marginTop: 10, marginBottom: 4 }}>
              <PrimaryButton title="检查横幅、锁屏和震动设置" onPress={() => { channelReviewPrompted.current = true; void openNotificationSettings(); }} secondary />
            </View>
          ) : null}
          <View style={{ height: 14 }} />
          {!calendarReminder?.enabled ? (
            <PrimaryButton
              title={configuringReminders ? '正在检查…' : reminderReady ? '检查原生闹钟' : '开启原生闹钟提醒'}
              onPress={() => void configureReminders()}
              disabled={configuringReminders}
              loading={configuringReminders}
            />
          ) : null}

          {Platform.OS === 'android' ? (
            <View style={{ marginTop: 12, marginBottom: 8 }}>
              <Text style={styles.cardHeading}>后台运行授权</Text>
              <Text style={styles.helperText}>
                电池优化豁免：{reminderDiagnostics?.batteryOptimizationExempt ? '已授权' : '未授权'}
                {' · '}系统后台限制：{reminderDiagnostics?.backgroundRestricted ? '受限' : '未报告限制'}
              </Text>
              {!reminderDiagnostics?.batteryOptimizationExempt ? (
                <>
                  <Text style={styles.helperText}>
                    目前息屏后曾出现延迟提醒。可在这里主动向 Android 申请电池优化豁免，授权与否由你决定。
                  </Text>
                  <View style={{ height: 8 }} />
                  <PrimaryButton title="申请后台提醒运行授权" onPress={requestReliableBackground} />
                </>
              ) : (
                <Text style={styles.helperText}>Android 电池优化豁免已获得；仍可能受到厂商后台及强行停止策略影响。</Text>
              )}
              <View style={{ height: 8 }} />
              <PrimaryButton
                title="系统电池优化列表"
                secondary
                onPress={() => void openBatteryOptimizationSettings().catch((error) =>
                  Alert.alert('无法打开电池优化设置', error instanceof Error ? error.message : '请在手机设置中进入电池管理。'))}
              />
              <View style={{ height: 8 }} />
              <PrimaryButton title="研伴应用后台设置" secondary onPress={() => void openBackgroundSettings()} />
              <Text style={styles.helperText}>
                均使用 Android 标准系统入口，不会静默修改授权；强行停止后仍无法保证本地提醒。
              </Text>
            </View>
          ) : null}
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
                  <Text style={styles.helperText}>后台限制：{reminderDiagnostics ? reminderDiagnostics.backgroundRestricted ? '系统已限制' : '未报告限制' : '未知'} · 电池优化豁免：{reminderDiagnostics?.batteryOptimizationExempt ? '已获得' : '未获得'}</Text>
                  <Text style={styles.helperText}>Android 待机分组：{standbyBucketLabel(reminderDiagnostics?.appStandbyBucket)}（厂商后台策略可能不同）</Text>
                  <Text style={styles.helperText}>系统通知：{reminderDiagnostics?.notificationsEnabled ? '允许' : '受限'} · 通道重要级别：{reminderDiagnostics?.channelImportance ?? '未知'}（横幅通常需要至少 4）</Text>
                  <Text style={styles.helperText}>通知渠道锁屏可见性：{reminderDiagnostics ? reminderDiagnostics.channelLockscreenVisibility === 1 ? '公开（渠道请求）' : '受限或隐藏' : '未读取'}。实际锁屏显示还取决于系统全局锁屏通知设置，App 不能代替用户开启。</Text>
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
                  <Text style={styles.helperText}>系统入口：原生广播 · {reminderDiagnostics.testReceiverReceivedAt > 0 ? "已到达" : "尚无到达记录"}</Text>
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
              {Platform.OS === 'android' && reminderDiagnostics !== null && reminderDiagnostics.dailyPlannedAt > 0 ? (
                <Text style={styles.helperText}>
                  正式随访闹钟：{new Date(reminderDiagnostics.dailyPlannedAt).toLocaleString('zh-CN', { hour12: false })}
                  {' · '}接收入口：原生广播
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
              <Text style={styles.helperText}>V2.0.7 已回退到原生广播直接投递：系统到点启动接收器，先发布通知，再执行最多 5 秒震动；不经由前台服务启动作为首要环节。请验证正常返回桌面与息屏是否恢复准时提醒。</Text>
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
          <InfoLine label="应用版本" value="2.0.15-preview" />
          <InfoLine label="研究方案" value={STUDY_PROTOCOL_VERSION} />
          <Text style={styles.helperText}>当前使用两步患者信息登记与同意确认。研究资格核查和正式知情同意仍应按研究方案执行。</Text>
        </SettingsDisclosure>
        <Text style={styles.privacyNote}>患者信息保存在本机加密数据库；新入组流程不调用外部 AI 服务。</Text>
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
    { id: 'home', title: '首页', ios: 'house.fill', android: 'home', },
    { id: 'followups', title: '随访', ios: 'calendar', android: 'calendar_month' },
    { id: 'patients', title: '患者', ios: 'person.2.fill', android: 'groups' },
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
  const [todayContacts, setTodayContacts] = useState<DueFollowupContact[]>([]);
  const [briefingVisible, setBriefingVisible] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // Show on the first unlocked app launch. Re-show on re-entry only if the
  // app has been away for at least two minutes (never on return from dialer).
  const briefingPendingRef = useRef(true);
  const lastBriefingAtRef = useRef(0);
  const backgroundEnteredAtRef = useRef<number | null>(null);
  const skipNextResumeBriefingRef = useRef(false);
  const initializationInProgress = useRef(false);
  const initializationComplete = useRef(false);
  const exactAlarmPermissionRef = useRef<boolean | null>(null);

  const refresh = useCallback(async (forceReminderReschedule = false) => {
    try {
      setRefreshing(true);
      const [nextSummary, nextTasks, nextScreenings, operator, contacts] = await Promise.all([
        getDashboardSummary(),
        getTasks(),
        listScreenings(),
        getOperatorName(),
        listDueFollowupContacts(),
      ]);
      setSummary(nextSummary);
      setTasks(nextTasks);
      setScreenings(nextScreenings);
      setActor(operator);
      setTodayContacts(contacts);
      if (briefingPendingRef.current) {
        briefingPendingRef.current = false;
        lastBriefingAtRef.current = Date.now();
        setBriefingVisible(true);
      }
      const exactAlarmGranted = await getExactAlarmPermission();
      const permissionChanged = exactAlarmPermissionRef.current !== null
        && exactAlarmPermissionRef.current !== exactAlarmGranted;
      // Run calendar reconciliation asynchronously after rendering the data.
      // Do not delay homepage readiness, app resume or patient navigation.
      void refreshLocalReminders(forceReminderReschedule || permissionChanged)
        .catch(reminderError => console.warn('Follow-up reminder sync needs attention:', reminderError));
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
      if (state === 'background') {
        backgroundEnteredAtRef.current = Date.now();
      }
      if (state === 'active') {
        const now = Date.now();
        const elapsed = backgroundEnteredAtRef.current === null
          ? 0 : now - backgroundEnteredAtRef.current;
        backgroundEnteredAtRef.current = null;
        // A returning call, file picker or short app switch must not trigger
        // a second interrupting patient list. No patient data is sent outside.
        if (!skipNextResumeBriefingRef.current &&
          elapsed >= 120_000 && now - lastBriefingAtRef.current >= 120_000) {
          briefingPendingRef.current = true;
        }
        skipNextResumeBriefingRef.current = false;
        void checkBackupAccessAndInitialize();
      }
    });
    return () => subscription.remove();
  }, [checkBackupAccessAndInitialize]);

  const openTodayBriefing = async () => {
    try {
      const contacts = await listDueFollowupContacts();
      setTodayContacts(contacts);
      briefingPendingRef.current = false;
      lastBriefingAtRef.current = Date.now();
      setBriefingVisible(true);
    } catch (error) {
      Alert.alert('无法打开今日随访', error instanceof Error ? error.message : '请检查本机患者数据库。');
    }
  };

  const openPatientDialer = async (rawPhone: string) => {
    const cleaned = rawPhone.trim().replace(/[^+0-9]/g, '');
    const phone = cleaned.startsWith('+')
      ? '+' + cleaned.slice(1).replace(/\+/g, '')
      : cleaned.replace(/\+/g, '');
    // Dialer preview only. Never use ACTION_CALL or request CALL_PHONE.
    if (phone.replace(/\D/g, '').length < 3) {
      Alert.alert('电话号码无效', '请先进入患者档案核对联系电话。');
      return;
    }
    setBriefingVisible(false);
    skipNextResumeBriefingRef.current = true;
    try {
      await Linking.openURL('tel:' + phone);
    } catch (error) {
      skipNextResumeBriefingRef.current = false;
      Alert.alert('无法打开拨号界面', error instanceof Error ? error.message : '当前设备没有可用的拨号应用。');
    }
  };

  const openBriefingTask = (taskId: string) => {
    setBriefingVisible(false);
    setTab('followups');
    setPage({ kind: 'task', id: taskId });
  };

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
      content = <HomeTab summary={summary} tasks={tasks} screenings={screenings} onOpen={setPage} onRefresh={refresh} onOpenFollowups={() => goTab('followups')} />;
    } else if (tab === 'patients') {
      content = <PatientListPage onOpen={setPage} onRefresh={refresh} />;
    } else if (tab === 'followups') {
      content = <FollowupsPage tasks={tasks} onOpen={setPage} onRefresh={refresh} />;
    } else {
      content = <SettingsPage onOpen={setPage} onRefresh={refresh} />;
    }
  } else if (page.kind === 'patientEntry' || page.kind === 'existingPatient' || page.kind === 'screening' ||
    page.kind === 'result' || page.kind === 'consent' || page.kind === 'enrollment') {
    content = <PatientEntryPage actor={actor} onOpen={setPage} onRefresh={refresh} onBack={() => setPage({ kind: 'tab' })} />;
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
          <SymbolView name={{ ios: 'calendar.badge.clock', android: 'calendar_month', web: 'calendar_month' }} size={22} tintColor="#FFFFFF" />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.brandName}>研伴</Text>
          <Text style={styles.brandCaption}>让每一次关怀，都如期而至</Text>
        </View>
        {refreshing ? <ActivityIndicator color={theme.primary} /> : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="打开今日随访患者及电话号码"
          onPress={() => { void openTodayBriefing(); }}
          style={styles.briefingHeaderButton}
        >
          <Text style={styles.briefingHeaderButtonText}>
            {'今日随访' + (todayContacts.length > 0 ? ' ' + todayContacts.length : '')}
          </Text>
        </Pressable>
      </View>
      <View style={styles.fill}>{content}</View>
      {page.kind === 'tab' ? <TabBar active={tab} onChange={goTab} /> : null}
      <TodayFollowupDialog
        visible={briefingVisible}
        contacts={todayContacts}
        onClose={() => setBriefingVisible(false)}
        onDial={(phone) => { void openPatientDialer(phone); }}
        onOpenTask={openBriefingTask}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({

  // V2.0.11 calendar-first visual system: shared surfaces and navigation.
  // These styles are reused by patient, follow-up, screening, record and settings pages.
  yanbanBottomAccent: { height: 3, width: 28, backgroundColor: '#00A9A6', borderRadius: 2 },
  registrationSteps: { flexDirection: 'row', gap: 8, marginBottom: 4 },
  registrationStep: { flex: 1, borderRadius: 13, paddingVertical: 13, alignItems: 'center', backgroundColor: '#E5F1F0' },
  registrationStepActive: { backgroundColor: '#BDF5EF', borderWidth: 1, borderColor: '#00A8A7' },
  registrationStepLabel: { fontSize: 13, fontWeight: '800', color: '#065A61' },
  registrationNotes: { minHeight: 180, paddingTop: 16, textAlignVertical: 'top' },
  calendarOptionRow: { paddingVertical: 12, paddingHorizontal: 13, borderRadius: 12, borderWidth: 1, borderColor: '#CDE5E8', backgroundColor: '#F8FCFC', marginTop: 8 },
  calendarOptionSelected: { backgroundColor: '#D7F8F2', borderColor: '#00A5A4' },
  calendarOptionName: { fontWeight: '800', color: '#0A3442', fontSize: 14 },
  briefingOverlay: {
    flex: 1,
    backgroundColor: 'rgba(16, 32, 39, 0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 22,
    paddingVertical: 26,
  },
  briefingPanel: {
    width: '100%',
    maxWidth: 440,
    maxHeight: '78%',
    backgroundColor: theme.paper,
    borderRadius: 22,
    paddingTop: 20,
    paddingHorizontal: 18,
    paddingBottom: 16,
    shadowColor: '#12282B',
    shadowOpacity: 0.15,
    shadowOffset: { width: 0, height: 12 },
    shadowRadius: 22,
    elevation: 12,
  },
  briefingTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginBottom: 10 },
  briefingHeaderText: { flex: 1 },
  briefingEyebrow: { fontSize: 12, color: theme.primary, fontWeight: '600' },
  briefingTitle: { color: theme.ink, fontSize: 21, lineHeight: 28, fontWeight: '700', marginTop: 3 },
  briefingSubtitle: { color: theme.muted, fontSize: 12, lineHeight: 18, marginTop: 6 },
  briefingClose: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 18, backgroundColor: theme.canvas },
  briefingCloseText: { fontSize: 25, lineHeight: 29, color: theme.muted, fontWeight: '300' },
  briefingList: { flexShrink: 1, maxHeight: 420, marginTop: 4 },
  briefingListContent: { paddingBottom: 2 },
  briefingContact: { paddingVertical: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.border },
  briefingContactMain: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  briefingPatientName: { color: theme.ink, fontSize: 16, fontWeight: '700' },
  briefingPatientMeta: { color: theme.muted, fontSize: 12, lineHeight: 18, marginTop: 4 },
  briefingStatus: { color: theme.primaryDark, backgroundColor: theme.primarySoft, borderRadius: 10, overflow: 'hidden', fontSize: 11, fontWeight: '600', paddingHorizontal: 8, paddingVertical: 4 },
  briefingStatusOverdue: { color: theme.danger, backgroundColor: theme.dangerSoft },
  briefingContactActions: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginTop: 10 },
  briefingDialButton: { flex: 1, minHeight: 38, borderRadius: 10, backgroundColor: theme.primarySoft, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 4 },
  briefingDialText: { flexShrink: 1, color: theme.primaryDark, fontWeight: '700', fontSize: 14 },
  briefingDialArrow: { color: theme.primary, fontSize: 20, fontWeight: '600' },
  briefingNoPhone: { flex: 1, color: theme.muted, fontSize: 12 },
  briefingTaskLink: { minHeight: 38, paddingHorizontal: 7, justifyContent: 'center', alignItems: 'center' },
  briefingTaskLinkText: { color: theme.primary, fontSize: 12, fontWeight: '600' },
  briefingEmpty: { alignItems: 'center', paddingTop: 28, paddingBottom: 20, gap: 7 },
  briefingEmptyIcon: { backgroundColor: theme.successSoft, color: theme.success, width: 45, height: 45, borderRadius: 23, textAlign: 'center', textAlignVertical: 'center', overflow: 'hidden', fontSize: 22, fontWeight: '700' },
  briefingEmptyTitle: { color: theme.ink, fontSize: 15, fontWeight: '700' },
  briefingEmptyCaption: { color: theme.muted, fontSize: 12, textAlign: 'center' },
  briefingFooter: { paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.border, gap: 12 },
  briefingPrivacy: { color: theme.muted, fontSize: 11, lineHeight: 16, textAlign: 'center' },
  briefingDone: { backgroundColor: theme.primary, minHeight: 42, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  briefingDoneText: { color: '#FFFFFF', fontSize: 14, fontWeight: '700' },
  briefingHeaderButton: { minHeight: 36, justifyContent: 'center', alignItems: 'center', backgroundColor: '#E0F9F6', borderRadius: 14, paddingHorizontal: 12, marginLeft: 10 },
  briefingHeaderButtonText: { color: theme.primaryDark, fontSize: 12, fontWeight: '700' },
  safe: { flex: 1, backgroundColor: theme.canvas, paddingTop: Platform.OS === 'android' ? (StatusBar.currentHeight ?? 0) : 0 },
  fill: { flex: 1 },
  appHeader: {
    height: 67,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 18,
    borderBottomColor: theme.border,
    borderBottomWidth: 0,
    backgroundColor: '#FFFFFF',
  },
  brandMark: { width: 41, height: 41, borderRadius: 14, backgroundColor: '#00AFAE', alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  brandMarkText: { color: '#FFFFFF', fontSize: 18, fontWeight: '800' },
  brandName: { color: '#083A45', fontSize: 21, fontWeight: '900', letterSpacing: 1.0 },
  brandCaption: { color: '#66969B', fontSize: 10, fontWeight: '600', marginTop: 1 },
  pageContent: { paddingHorizontal: 16, paddingTop: 18, paddingBottom: 36, gap: 15 },
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
  card: { backgroundColor: theme.paper, borderRadius: 21, padding: 19, borderWidth: 0, shadowColor: '#208C95', shadowOpacity: 0.05, shadowRadius: 12, elevation: 2 },
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
  pageTitle: { color: '#0B3847', fontSize: 28, lineHeight: 36, fontWeight: '900', letterSpacing: 0.3 },
  pageSubtitle: { color: theme.muted, fontSize: 15, marginTop: 5, lineHeight: 23 },
  label: { color: theme.ink, ...typeScale.label, marginBottom: 8 },
  requiredMark: { color: theme.danger, fontWeight: '700' },
  field: { marginTop: 14 },
  input: { borderColor: '#CDE5E8', borderWidth: 1, borderRadius: 14, color: theme.ink, fontSize: 16, paddingHorizontal: 14, paddingVertical: 12, backgroundColor: '#F8FCFC', minHeight: 52 },
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
  button: { backgroundColor: theme.primary, borderRadius: 15, minHeight: 52, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
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
  avatar: { height: 46, width: 46, backgroundColor: '#D7F8F3', borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#008F8E', fontWeight: '900', fontSize: 19 },
  patientName: { color: '#0C3745', fontSize: 17, fontWeight: '800' },
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
  tabBar: { flexDirection: 'row', backgroundColor: '#FFFFFF', borderTopColor: '#DFF0F0', borderTopWidth: 1, height: 74, paddingBottom: Platform.OS === 'ios' ? 5 : 0 },
  tabItem: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 3, minHeight: 48 },
  tabText: { color: '#819399', fontSize: 12, fontWeight: '700' },
  tabActive: { color: '#00A6A5', fontWeight: '900' },
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

