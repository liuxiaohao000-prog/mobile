import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { dateKey } from './domain/dates';
import { theme } from './theme';
import type { DashboardSummary, FollowupTask } from './types';

type Props = {
  summary: DashboardSummary;
  tasks: FollowupTask[];
  onOpenTask: (id: string) => void;
  onAddPatient: () => void;
  onOpenFollowups: () => void;
  onRefresh: () => void;
};

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const ACTIVE = (task: FollowupTask) =>
  task.status !== 'COMPLETED' && task.status !== 'CANCELLED';

// A date always represents the task's scheduled date, not the day an
// overdue reminder happened. Counts are by follow-up tasks, not patients.
export default function FollowupCalendarHome({
  summary, tasks, onOpenTask, onAddPatient, onOpenFollowups, onRefresh,
}: Props) {
  const now = new Date();
  const year = now.getFullYear();
  const [month, setMonth] = useState(now.getMonth());
  const [selectedDay, setSelectedDay] = useState<number | null>(now.getDate());
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstWeekday = new Date(year, month, 1).getDay();
  const today = dateKey(now);

  const { pendingByDay, completedCount } = useMemo(() => {
    const prefix = `${year}-${String(month + 1).padStart(2, '0')}-`;
    const monthly = tasks.filter(task => task.plannedDate.startsWith(prefix));
    const map = new Map<number, FollowupTask[]>();
    for (const task of monthly) {
      if (!ACTIVE(task)) continue;
      const day = Number(task.plannedDate.slice(-2));
      const existing = map.get(day) ?? [];
      existing.push(task);
      map.set(day, existing);
    }
    return {
      pendingByDay: map,
      completedCount: monthly.filter(task => task.status === 'COMPLETED').length,
    };
  }, [tasks, year, month]);

  const monthlyPending = Array.from(pendingByDay.values()).reduce((sum, items) => sum + items.length, 0);
  const total = monthlyPending + completedCount;
  const rate = total > 0 ? Math.round(completedCount * 100 / total) : 0;
  const selectedTasks = selectedDay === null ? [] : pendingByDay.get(selectedDay) ?? [];
  const selectedDate = selectedDay === null ? null : dateKey(new Date(year, month, selectedDay));
  const isTodaySelected = selectedDate === today;
  const changeMonth = (next: number) => {
    if (next < 0 || next > 11) return;
    setMonth(next);
    setSelectedDay(next === new Date().getMonth() ? new Date().getDate() : null);
  };

  return (
    <ScrollView contentContainerStyle={s.page} showsVerticalScrollIndicator={false}>
      <View style={s.hero}>
        <View style={s.heroCircleOne} />
        <View style={s.heroCircleTwo} />
        <View style={s.heroDecor}>
          <Text style={s.heroDecorText}>＋</Text>
        </View>
        <Text style={s.heroOverline}>YANBAN  /  CARE CALENDAR</Text>
        <Text style={s.heroTitle}>随访日历</Text>
        <Text style={s.heroSubtitle}>让每一次关怀，都如期而至。</Text>
        <View style={s.heroBadge}>
          <Text style={s.heroBadgeText}>✦  关心每一天 · 不遗漏每一次随访</Text>
        </View>
      </View>

      <View style={s.monthSelector}>
        <View style={s.yearColumn}>
          <Text style={s.yearCaption}>当前年份</Text>
          <Text style={s.yearText}>{year}<Text style={s.yearUnit}> 年</Text></Text>
        </View>
        <View style={s.monthGrid}>
          {Array.from({ length: 12 }, (_, index) => (
            <Pressable
              key={index}
              accessibilityRole="button"
              accessibilityLabel={`${year}年${index + 1}月`}
              accessibilityState={{ selected: month === index }}
              onPress={() => changeMonth(index)}
              style={[s.monthPill, month === index && s.monthPillActive]}
            >
              <Text style={[s.monthPillText, month === index && s.monthPillTextActive]}>{index + 1}月</Text>
            </Pressable>
          ))}
        </View>
      </View>

      <View style={s.calendarCard}>
        <View style={s.calendarHeading}>
          <View style={s.calendarHeadingLeft}>
            <View style={s.headingAccent} />
            <Text style={s.monthTitle}>{month + 1}<Text style={s.monthTitleUnit}> 月</Text></Text>
            <Text style={s.calendarYear}>{year}年</Text>
          </View>
          <View style={s.monthTotal}>
            <Text style={s.monthTotalCaption}>本月待随访</Text>
            <Text style={s.monthTotalNumber}>{monthlyPending}<Text style={s.monthTotalUnit}> 项</Text></Text>
          </View>
        </View>
        <View style={s.weekdayRow}>
          {WEEKDAYS.map((label, index) => (
            <Text key={label} style={[s.weekdayText, (index === 0 || index === 6) && s.weekendText]}>{label}</Text>
          ))}
        </View>
        <View style={s.dateGrid}>
          {Array.from({ length: firstWeekday }, (_, index) => <View key={`empty-${index}`} style={s.dateCell} />)}
          {Array.from({ length: daysInMonth }, (_, index) => {
            const day = index + 1;
            const pending = pendingByDay.get(day)?.length ?? 0;
            const selected = selectedDay === day;
            const isToday = dateKey(new Date(year, month, day)) === today;
            return (
              <Pressable
                key={day}
                accessibilityRole="button"
                accessibilityLabel={`${month + 1}月${day}日${pending > 0 ? `，待随访${pending}项` : '，无待随访'}`}
                accessibilityState={{ selected }}
                onPress={() => setSelectedDay(day)}
                style={s.dateCell}
              >
                <View style={[s.dateInner, pending > 0 && s.dateWithTasks, selected && s.dateSelected, isToday && s.dateToday]}>
                  <Text style={[s.dayNumber, pending > 0 && s.dayNumberAlert, selected && pending === 0 && s.dayNumberSelected]}>{day}</Text>
                  {pending > 0 ? <Text style={s.pendingLabel} numberOfLines={1}>待随访:{pending}</Text> : null}
                </View>
              </Pressable>
            );
          })}
        </View>
        <View style={s.legend}>
          <View style={s.legendDot} />
          <Text style={s.legendText}>红色代表当天有未完成的随访 · 点击日期查看任务</Text>
        </View>
      </View>

      <Pressable accessibilityRole="button" onPress={onOpenFollowups} style={s.overview}>
        <View style={s.overviewIcon}><Text style={s.overviewIconText}>✓</Text></View>
        <View style={s.overviewHeading}>
          <Text style={s.overviewTitle}>本月随访概览</Text>
          <Text style={s.overviewSubtitle}>随访有序，安心在握</Text>
        </View>
        <View style={s.overviewStat}>
          <Text style={[s.overviewValue, { color: theme.danger }]}>{monthlyPending}</Text>
          <Text style={s.overviewLabel}>待随访</Text>
        </View>
        <View style={s.overviewStat}>
          <Text style={s.overviewValue}>{completedCount}</Text>
          <Text style={s.overviewLabel}>已完成</Text>
        </View>
        <Text style={s.overviewChevron}>›</Text>
      </Pressable>

      <View style={s.daySection}>
        <View style={s.sectionHead}>
          <View>
            <Text style={s.sectionEyebrow}>{selectedDate ?? `${year}年${month + 1}月`}</Text>
            <Text style={s.sectionTitle}>{selectedDay === null ? '选择日期查看随访' : isTodaySelected ? '今天的随访' : `${month + 1}月${selectedDay}日 · 随访`}</Text>
          </View>
          <Pressable accessibilityRole="button" onPress={onRefresh} style={s.refresh}>
            <Text style={s.refreshText}>刷新 ↻</Text>
          </Pressable>
        </View>
        {selectedTasks.length ? selectedTasks.map(task => (
          <Pressable key={task.id} accessibilityRole="button" onPress={() => onOpenTask(task.id)} style={s.taskRow}>
            <View style={s.taskAvatar}><Text style={s.taskAvatarText}>{task.patientName.slice(0, 1) || '患'}</Text></View>
            <View style={{ flex: 1 }}>
              <Text style={s.taskName}>{task.patientName}</Text>
              <Text style={s.taskSub}>{task.patientNumber} · 第{task.nodeMonth}个月随访</Text>
            </View>
            <Text style={s.taskLink}>查看 ›</Text>
          </Pressable>
        )) : <View style={s.dayEmpty}>
          <Text style={s.dayEmptySymbol}>✦</Text>
          <Text style={s.dayEmptyText}>{selectedDay === null ? '点击日历中的某一天' : '这一天没有待随访任务'}</Text>
        </View>}
      </View>

      <Pressable accessibilityRole="button" onPress={onAddPatient} style={s.addButton}>
        <Text style={s.addButtonText}>＋  新增或补录患者</Text>
      </Pressable>
      <Text style={s.footer}>本机加密保存 · {summary.activePatients} 位在组患者 · 完成率 {rate}%</Text>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  page: { paddingHorizontal: 15, paddingTop: 12, paddingBottom: 32, gap: 15, backgroundColor: theme.canvas },
  hero: { minHeight: 166, backgroundColor: '#00B5BA', borderRadius: 26, paddingHorizontal: 22, paddingVertical: 21, overflow: 'hidden', justifyContent: 'center' },
  heroCircleOne: { position: 'absolute', width: 260, height: 260, borderRadius: 130, borderWidth: 36, borderColor: 'rgba(255,255,255,0.13)', right: -82, top: -158 },
  heroCircleTwo: { position: 'absolute', width: 150, height: 150, borderRadius: 75, backgroundColor: 'rgba(3,71,92,0.19)', right: -38, bottom: -72 },
  heroDecor: { position: 'absolute', right: 26, top: 45, height: 68, width: 68, borderRadius: 21, backgroundColor: 'rgba(255,255,255,0.2)', alignItems: 'center', justifyContent: 'center', transform: [{ rotate: '-15deg' }] },
  heroDecorText: { fontSize: 51, fontWeight: '800', color: '#E8FFFC', lineHeight: 60 },
  heroOverline: { color: '#C5FBF9', fontSize: 10, fontWeight: '800', letterSpacing: 1.7 },
  heroTitle: { color: '#FFFFFF', fontWeight: '900', fontSize: 34, letterSpacing: 1.2, marginTop: 5 },
  heroSubtitle: { color: '#F1FFFE', fontSize: 14, fontWeight: '600', marginTop: 6 },
  heroBadge: { alignSelf: 'flex-start', backgroundColor: 'rgba(255,255,255,0.16)', paddingHorizontal: 11, paddingVertical: 6, marginTop: 14, borderRadius: 18 },
  heroBadgeText: { color: '#E5FEFB', fontSize: 11, fontWeight: '600' },
  monthSelector: { borderRadius: 21, padding: 14, flexDirection: 'row', backgroundColor: '#E9FCFC', alignItems: 'center', gap: 13 },
  yearColumn: { width: 80, gap: 5 },
  yearCaption: { color: '#65858B', fontSize: 11, fontWeight: '600' },
  yearText: { color: '#073544', fontWeight: '900', fontSize: 23 },
  yearUnit: { fontSize: 12, fontWeight: '500' },
  monthGrid: { flex: 1, flexDirection: 'row', flexWrap: 'wrap', gap: 5, justifyContent: 'space-between' },
  monthPill: { width: '14.6%', borderRadius: 11, minHeight: 34, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFFFFF' },
  monthPillActive: { backgroundColor: '#009E9F' },
  monthPillText: { fontSize: 12, fontWeight: '700', color: '#38515A' },
  monthPillTextActive: { color: '#FFFFFF' },
  calendarCard: { padding: 13, paddingTop: 19, borderRadius: 25, backgroundColor: '#FFFFFF', shadowColor: '#168C92', shadowOpacity: 0.08, shadowRadius: 18, elevation: 3 },
  calendarHeading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 5, paddingBottom: 17 },
  calendarHeadingLeft: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  headingAccent: { width: 5, height: 32, borderRadius: 3, backgroundColor: '#00BEB7' },
  monthTitle: { fontSize: 32, fontWeight: '900', color: '#092F3B' },
  monthTitleUnit: { fontSize: 18, fontWeight: '800' },
  calendarYear: { color: '#708188', fontSize: 14, fontWeight: '600', marginLeft: 2 },
  monthTotal: { backgroundColor: '#E8F8F8', borderRadius: 16, paddingHorizontal: 13, paddingVertical: 7, alignItems: 'flex-end' },
  monthTotalCaption: { fontSize: 11, color: '#54777D' },
  monthTotalNumber: { fontSize: 21, fontWeight: '900', color: '#F0524D' },
  monthTotalUnit: { fontSize: 12, fontWeight: '600', color: '#54777D' },
  weekdayRow: { flexDirection: 'row', borderRadius: 12, backgroundColor: '#E8F7F8', marginBottom: 6, paddingVertical: 10 },
  weekdayText: { width: '14.2857%', color: '#506873', textAlign: 'center', fontSize: 12, fontWeight: '700' },
  weekendText: { color: '#F0524D' },
  dateGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  dateCell: { width: '14.2857%', height: 61, alignItems: 'center', justifyContent: 'center', padding: 2, borderBottomColor: '#EBF2F2', borderBottomWidth: StyleSheet.hairlineWidth },
  dateInner: { width: '100%', height: '100%', borderRadius: 10, alignItems: 'center', justifyContent: 'center', gap: 4, borderWidth: 1, borderColor: 'transparent' },
  dateWithTasks: { backgroundColor: '#FFEBEA' },
  dateSelected: { borderColor: '#00AAA7', borderWidth: 1.5 },
  dateToday: { borderColor: '#14B8B5' },
  dayNumber: { fontSize: 16, color: '#193943', fontWeight: '700' },
  dayNumberAlert: { color: '#D7252A', fontWeight: '900' },
  dayNumberSelected: { color: '#009E9F' },
  pendingLabel: { fontSize: 9, color: '#C51E28', fontWeight: '800', letterSpacing: -0.4 },
  legend: { flexDirection: 'row', alignItems: 'center', paddingTop: 10, paddingHorizontal: 5, gap: 6 },
  legendDot: { width: 8, height: 8, borderRadius: 3, backgroundColor: '#F0524D' },
  legendText: { fontSize: 10, color: '#75898F', flex: 1 },
  overview: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#DDF9F6', borderRadius: 22, paddingHorizontal: 13, paddingVertical: 16, gap: 9 },
  overviewIcon: { width: 43, height: 48, backgroundColor: '#00B7AE', borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  overviewIconText: { color: '#FFFFFF', fontSize: 30, fontWeight: '900' },
  overviewHeading: { flex: 1 },
  overviewTitle: { fontSize: 14, color: '#063C45', fontWeight: '900' },
  overviewSubtitle: { fontSize: 10, color: '#6A9092', marginTop: 4 },
  overviewStat: { alignItems: 'center', borderLeftColor: '#B9DEDE', borderLeftWidth: 1, paddingLeft: 8 },
  overviewValue: { fontSize: 22, fontWeight: '900', color: '#008981' },
  overviewLabel: { fontSize: 10, color: '#5C7279', marginTop: 1 },
  overviewChevron: { fontSize: 27, color: '#64848B' },
  daySection: { backgroundColor: '#FFFFFF', borderRadius: 22, paddingHorizontal: 16, paddingVertical: 16, gap: 12 },
  sectionHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  sectionEyebrow: { fontSize: 11, fontWeight: '700', color: '#00A3A1', letterSpacing: 0.5 },
  sectionTitle: { color: '#092F3B', fontWeight: '900', fontSize: 18, marginTop: 4 },
  refresh: { borderRadius: 11, backgroundColor: '#E9F8F7', paddingVertical: 8, paddingHorizontal: 11 },
  refreshText: { color: '#008B8B', fontSize: 12, fontWeight: '700' },
  taskRow: { flexDirection: 'row', alignItems: 'center', gap: 10, borderTopColor: '#F0F4F4', borderTopWidth: 1, paddingVertical: 10 },
  taskAvatar: { width: 41, height: 41, borderRadius: 14, backgroundColor: '#C8F4F0', justifyContent: 'center', alignItems: 'center' },
  taskAvatarText: { fontSize: 18, fontWeight: '800', color: '#008A87' },
  taskName: { color: '#103A47', fontWeight: '800', fontSize: 15 },
  taskSub: { color: '#82949A', fontSize: 11, marginTop: 5 },
  taskLink: { fontSize: 12, fontWeight: '800', color: '#008D90' },
  dayEmpty: { alignItems: 'center', paddingVertical: 20, gap: 7 },
  dayEmptySymbol: { fontSize: 23, color: '#00C3B4' },
  dayEmptyText: { color: '#83949A', fontSize: 13 },
  addButton: { backgroundColor: '#073B48', minHeight: 49, borderRadius: 15, justifyContent: 'center', alignItems: 'center' },
  addButtonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 15 },
  footer: { fontSize: 11, color: '#889CA1', textAlign: 'center', marginBottom: 10 },
});
