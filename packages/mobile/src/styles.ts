import { StyleSheet, Platform } from 'react-native';

export const colors = {
  bg: '#ffffff',
  bgAlt: '#f6f7f8',
  border: '#e5e7eb',
  borderStrong: '#d1d5db',
  text: '#1f2328',
  textMuted: '#6b7280',
  accent: '#f5b400',
  accentSoft: '#fef3c7',
  danger: '#ef4444',
  ok: '#10b981',
};

export const styles = StyleSheet.create({
  authWrap: {
    flexGrow: 1,
    padding: 24,
    backgroundColor: colors.bg,
    justifyContent: 'center',
  },
  card: {
    backgroundColor: colors.bgAlt,
    borderRadius: 12,
    padding: 24,
    borderWidth: 1,
    borderColor: colors.border,
  },
  h1: { fontSize: 22, fontWeight: '700', color: colors.text, marginBottom: 4 },
  sub: { color: colors.textMuted, fontSize: 13, marginBottom: 16, lineHeight: 18 },
  label: { fontSize: 12, color: colors.textMuted, marginTop: 12, marginBottom: 4, fontWeight: '500' },
  input: {
    borderWidth: 1, borderColor: colors.borderStrong,
    borderRadius: 6, padding: 10, fontSize: 15,
    backgroundColor: colors.bg, color: colors.text,
  },
  primary: {
    backgroundColor: colors.accent,
    borderRadius: 6, padding: 12,
    alignItems: 'center',
    marginTop: 20,
  },
  primaryText: { color: colors.text, fontWeight: '600', fontSize: 15 },
  secretBox: {
    backgroundColor: colors.accentSoft,
    borderColor: colors.accent, borderWidth: 1,
    borderRadius: 6, padding: 14, marginVertical: 12,
  },
  secretText: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 14, color: colors.text,
  },

  listWrap: { flex: 1, backgroundColor: colors.bg },
  listHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    padding: 12, borderBottomWidth: 1, borderColor: colors.border,
    backgroundColor: colors.bgAlt,
  },
  listSearch: {
    margin: 12, padding: 10,
    borderWidth: 1, borderColor: colors.borderStrong, borderRadius: 6,
    backgroundColor: colors.bg, color: colors.text,
  },
  noteItem: {
    padding: 14, borderBottomWidth: 1, borderColor: colors.border,
  },
  noteItemTitle: { fontSize: 16, fontWeight: '600', color: colors.text, marginBottom: 4 },
  noteItemPreview: { fontSize: 13, color: colors.textMuted },
  noteItemMeta: { fontSize: 11, color: colors.textMuted, marginTop: 4 },
  fab: {
    position: 'absolute', right: 16, bottom: 24,
    backgroundColor: colors.accent,
    width: 56, height: 56, borderRadius: 28,
    alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 4,
    elevation: 4,
  },
  fabText: { fontSize: 28, color: colors.text, fontWeight: '700', lineHeight: 30 },

  editorWrap: { flex: 1, backgroundColor: colors.bg },
  editorTitle: {
    fontSize: 22, fontWeight: '700', color: colors.text,
    paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8,
  },
  editorFolder: {
    fontSize: 12, color: colors.textMuted,
    paddingHorizontal: 16, paddingBottom: 8,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  editorBody: {
    flex: 1,
    paddingHorizontal: 16, paddingVertical: 12,
    fontSize: 15, lineHeight: 22, color: colors.text,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    textAlignVertical: 'top',
  },
  statusbar: {
    padding: 8, paddingHorizontal: 12,
    borderTopWidth: 1, borderColor: colors.border,
    backgroundColor: colors.bgAlt,
    flexDirection: 'row', justifyContent: 'space-between',
  },
  statusText: { fontSize: 11, color: colors.textMuted },
});
