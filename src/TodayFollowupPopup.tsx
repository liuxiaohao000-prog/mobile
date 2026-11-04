import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator, Alert, Linking, Modal, Pressable, ScrollView,
  StyleSheet, Text, View,
} from 'react-native';
import { dateKey } from './domain/dates';
import { getPatient } from './storage/repository';
import { theme } from './theme';
import type { FollowupTask } from './types';

type TodayPatient = {
  id: string;
  name: string;
  number: string;
  phone: string;
  months: number[];
};

export function TodayFollowupPopup({
  visible,
  tasks,
  onClose,
  onOpenFollowups,
}: {
  visible: boolean;
  tasks: FollowupTask[];
  onClose: () => void;
  onOpenFollowups: () => void;
}) {
  const [patients, setPatients] = useState<TodayPatient[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(false);
    const today = dateKey(new Date());
    const dueTasks = tasks.filter(task => task.plannedDate === today && task.status === 'DUE');
    const grouped = new Map<string, FollowupTask[]>();
    for (const task of dueTasks) {
      const existing = grouped.get(task.patientId) ?? [];
      existing.push(task);
      grouped.set(task.patientId, existing);
    }
    void (async () => {
      try {
        const result = await Promise.all(Array.from(grouped.entries()).map(async ([id, patientTasks]) => {
          const patient = await getPatient(id);
          return {
            id,
            name: patient?.name ?? patientTasks[0].patientName,
            number: patient?.patientNumber ?? patientTasks[0].patientNumber,
            phone: patient?.phone?.trim() ?? '',
            months: patientTasks.map(task => task.nodeMonth).sort((a, b) => a - b),
          };
        }));
        if (!cancelled) setPatients(result);
      } catch {
        if (!cancelled) setLoadError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [visible, tasks]);

  const openDialer = async (phone: string) => {
    const normalized = phone.replace(/[^0-9+]/g, '');
    if (!normalized) return;
    try {
      await Linking.openURL('tel:' + normalized);
      onClose();
    } catch {
      Alert.alert('无法打开拨号界面', '请检查手机是否安装了拨号应用。');
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.dialog}>
          <View style={styles.heading}>
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>今日随访提醒</Text>
              <Text style={styles.subtitle}>{dateKey(new Date())} · 待随访患者</Text>
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel="关闭今日随访提醒" onPress={onClose} style={styles.close}>
              <Text style={styles.closeText}>×</Text>
            </Pressable>
          </View>
          {loading ? (
            <View style={styles.empty}><ActivityIndicator color={theme.primary} /><Text style={styles.muted}>正在读取今日随访…</Text></View>
          ) : loadError ? (
            <Text style={styles.emptyText}>读取随访名单失败，请到随访页面查看。</Text>
          ) : patients.length === 0 ? (
            <Text style={styles.emptyText}>今天没有待完成的随访任务。</Text>
          ) : (
            <>
              <Text style={styles.count}>今天有 {patients.length} 位患者需要随访</Text>
              <ScrollView style={styles.list} contentContainerStyle={styles.listContent} nestedScrollEnabled>
                {patients.map(patient => (
                  <View key={patient.id} style={styles.patientRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.patientName}>{patient.name}</Text>
                      <Text style={styles.meta}>{patient.number} · 第 {patient.months.join('、')} 个月</Text>
                    </View>
                    {patient.phone ? (
                      <Pressable accessibilityRole="button" accessibilityLabel={`拨号 ${patient.name} ${patient.phone}`} onPress={() => void openDialer(patient.phone)} style={styles.phoneButton}>
                        <Text style={styles.phone}>☎ {patient.phone}</Text>
                      </Pressable>
                    ) : <Text style={styles.muted}>未留电话</Text>}
                  </View>
                ))}
              </ScrollView>
            </>
          )}
          <Pressable accessibilityRole="button" onPress={onOpenFollowups} style={styles.primary}>
            <Text style={styles.primaryText}>查看随访任务</Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={onClose} style={styles.secondary}>
            <Text style={styles.secondaryText}>稍后处理</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'center', backgroundColor: 'rgba(15,23,42,0.48)', padding: 22 },
  dialog: { backgroundColor: theme.paper, borderRadius: 18, padding: 20, maxHeight: '82%' },
  heading: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 14 },
  title: { fontSize: 20, fontWeight: '700', color: theme.ink },
  subtitle: { marginTop: 5, fontSize: 13, color: theme.muted },
  close: { paddingHorizontal: 8, paddingVertical: 1 },
  closeText: { fontSize: 28, color: theme.muted },
  count: { color: theme.primaryDark, fontWeight: '600', marginBottom: 6 },
  list: { flexGrow: 0, marginBottom: 12 },
  listContent: { paddingBottom: 4 },
  patientRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 13, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  patientName: { fontWeight: '700', fontSize: 16, color: theme.ink },
  meta: { fontSize: 12, color: theme.muted, marginTop: 5 },
  phoneButton: { backgroundColor: theme.primarySoft, borderRadius: 9, paddingHorizontal: 10, paddingVertical: 10, maxWidth: '55%' },
  phone: { color: theme.primaryDark, fontWeight: '700', fontSize: 14 },
  muted: { fontSize: 13, color: theme.muted, marginTop: 8 },
  empty: { padding: 25, alignItems: 'center' },
  emptyText: { color: theme.muted, textAlign: 'center', paddingVertical: 28 },
  primary: { alignItems: 'center', backgroundColor: theme.primary, padding: 13, borderRadius: 10 },
  primaryText: { fontWeight: '700', color: '#FFFFFF' },
  secondary: { padding: 12, alignItems: 'center' },
  secondaryText: { color: theme.muted },
});
