// Reusable bottom-sheet action menu. Mobile equivalent of the desktop
// ContextMenu — invoked from long-press on notes, folders, tags. Also
// hosts simple prompts (e.g. "New folder name").
//
// Renders a slide-up Modal. iOS-styled by default; works on Android.

import React from 'react';
import {
  Modal, View, Text, Pressable, TextInput, KeyboardAvoidingView, Platform,
} from 'react-native';
import { MEO, FONT_SANS } from './theme';
import { Icon } from './Icon';

export interface ActionItem {
  label: string;
  icon?: keyof typeof Icon;
  destructive?: boolean;
  disabled?: boolean;
  onPress: () => void;
}

interface Props {
  visible: boolean;
  title?: string;
  items: ActionItem[];
  onClose: () => void;
}

export function ActionSheet({ visible, title, items, onClose }: Props) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable
        onPress={onClose}
        style={{ flex: 1, backgroundColor: 'rgba(31,28,23,0.4)', justifyContent: 'flex-end' }}
      >
        <Pressable
          onPress={(e) => e.stopPropagation()}
          style={{
            backgroundColor: MEO.overlay,
            borderTopLeftRadius: 18,
            borderTopRightRadius: 18,
            paddingTop: 8, paddingBottom: 32,
            borderTopWidth: 1, borderTopColor: MEO.paperEdge,
          }}
        >
          {/* Drag handle */}
          <View style={{ alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: MEO.paperEdge, marginVertical: 8 }} />

          {title ? (
            <Text style={{
              fontFamily: FONT_SANS, fontSize: 12, fontWeight: '600',
              color: MEO.ink3, textAlign: 'center',
              textTransform: 'uppercase', letterSpacing: 0.6,
              paddingVertical: 8,
            }}>{title}</Text>
          ) : null}

          {items.map((it, i) => {
            const I = it.icon ? Icon[it.icon] : null;
            return (
              <Pressable
                key={i}
                onPress={() => { if (!it.disabled) { it.onPress(); onClose(); } }}
                disabled={it.disabled}
                style={({ pressed }) => ({
                  flexDirection: 'row', alignItems: 'center', gap: 12,
                  paddingVertical: 14, paddingHorizontal: 20,
                  backgroundColor: pressed ? MEO.paperDeep : 'transparent',
                  opacity: it.disabled ? 0.4 : 1,
                })}
              >
                {I ? (
                  <I size={16} stroke={it.destructive ? MEO.danger : MEO.ink2} />
                ) : <View style={{ width: 16 }} />}
                <Text style={{
                  flex: 1, fontSize: 16,
                  color: it.destructive ? MEO.danger : MEO.ink,
                  fontFamily: FONT_SANS,
                }}>{it.label}</Text>
              </Pressable>
            );
          })}

          <View style={{ height: 8 }} />
          <Pressable
            onPress={onClose}
            style={({ pressed }) => ({
              marginHorizontal: 16, marginTop: 4,
              backgroundColor: pressed ? MEO.paperDeep : MEO.paper,
              borderRadius: 12, paddingVertical: 14, alignItems: 'center',
              borderWidth: 1, borderColor: MEO.paperEdge,
            })}
          >
            <Text style={{ fontSize: 16, fontWeight: '600', color: MEO.ink, fontFamily: FONT_SANS }}>Cancel</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ─── Prompt sheet: same shell, with a TextInput ───

interface PromptProps {
  visible: boolean;
  title: string;
  message?: string;
  placeholder?: string;
  initialValue?: string;
  submitLabel?: string;
  onSubmit: (value: string) => void;
  onClose: () => void;
}

export function PromptSheet({
  visible, title, message, placeholder, initialValue = '', submitLabel = 'Save', onSubmit, onClose,
}: PromptProps) {
  const [value, setValue] = React.useState(initialValue);

  // Reset on each open
  React.useEffect(() => {
    if (visible) setValue(initialValue);
  }, [visible, initialValue]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(31,28,23,0.4)' }}
      >
        <Pressable onPress={onClose} style={{ flex: 1 }} />
        <View
          style={{
            backgroundColor: MEO.overlay,
            borderTopLeftRadius: 18, borderTopRightRadius: 18,
            paddingTop: 8, paddingBottom: 32,
            borderTopWidth: 1, borderTopColor: MEO.paperEdge,
          }}
        >
          <View style={{ alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: MEO.paperEdge, marginVertical: 8 }} />
          <Text style={{
            fontFamily: FONT_SANS, fontSize: 16, fontWeight: '600',
            color: MEO.ink, textAlign: 'center', paddingVertical: 4,
          }}>{title}</Text>
          {message ? (
            <Text style={{
              fontFamily: FONT_SANS, fontSize: 13, color: MEO.ink3,
              textAlign: 'center', paddingHorizontal: 24, paddingVertical: 6,
            }}>{message}</Text>
          ) : null}
          <View style={{ paddingHorizontal: 20, paddingTop: 12, paddingBottom: 8 }}>
            <TextInput
              value={value}
              onChangeText={setValue}
              autoFocus
              placeholder={placeholder}
              placeholderTextColor={MEO.ink4}
              onSubmitEditing={() => { onSubmit(value); onClose(); }}
              autoCapitalize="words"
              style={{
                fontFamily: FONT_SANS, fontSize: 16, color: MEO.ink,
                borderWidth: 1, borderColor: MEO.accent, borderRadius: 8,
                paddingHorizontal: 12, paddingVertical: 10,
                backgroundColor: MEO.paper,
              }}
            />
          </View>
          <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingTop: 8 }}>
            <Pressable
              onPress={onClose}
              style={{
                flex: 1,
                backgroundColor: MEO.paper,
                borderRadius: 12, paddingVertical: 12, alignItems: 'center',
                borderWidth: 1, borderColor: MEO.paperEdge,
              }}
            >
              <Text style={{ fontSize: 15, fontWeight: '600', color: MEO.ink, fontFamily: FONT_SANS }}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={() => { onSubmit(value); onClose(); }}
              style={{
                flex: 1,
                backgroundColor: MEO.accent,
                borderRadius: 12, paddingVertical: 12, alignItems: 'center',
              }}
            >
              <Text style={{ fontSize: 15, fontWeight: '600', color: '#fff', fontFamily: FONT_SANS }}>{submitLabel}</Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
