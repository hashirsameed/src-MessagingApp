import React, { useState, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity,
  StyleSheet, TextInput, Modal, StatusBar, ScrollView,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { getAllPlatforms, insertPlatform, deletePlatform } from '../database/platformDB';
import { ErrorMessages, handleError, showError, showConfirm, showSuccess } from '../utils/errorHandler';

const ICON_OPTIONS = ['📧', '📲', '💌', '🔔', '📡', '🌐', '📞', '💻', '🗨️', '📤'];

export default function PlatformManagerScreen() {
  const [platforms, setPlatforms] = useState([]);
  const [modalVisible, setModalVisible] = useState(false);
  const [name, setName] = useState('');
  const [icon, setIcon] = useState('📧');
  const [urlScheme, setUrlScheme] = useState('');

  const loadPlatforms = () => {
    try {
      const data = getAllPlatforms();
      setPlatforms(data);
    } catch (error) {
      handleError(error, 'PlatformManagerScreen.loadPlatforms');
      showError('Error', ErrorMessages.DB_READ);
    }
  };

  useFocusEffect(
    useCallback(() => {
      loadPlatforms();
    }, [])
  );

  const handleAdd = () => {
    if (!name.trim()) {
      showError('Validation Error', ErrorMessages.VALIDATION_REQUIRED('platform name'));
      return;
    }
    if (!urlScheme.trim()) {
      showError('Validation Error', ErrorMessages.VALIDATION_REQUIRED('URL scheme'));
      return;
    }

    const newPlatform = {
      id: Date.now().toString(),
      name: name.trim(),
      icon: icon,
      url_scheme: urlScheme.trim(),
    };

    try {
      const ok = insertPlatform(newPlatform);
      if (!ok) {
        showError('Error', ErrorMessages.DB_WRITE);
        return;
      }
      loadPlatforms();
      setModalVisible(false);
      const savedName = name.trim();
      setName('');
      setIcon('📧');
      setUrlScheme('');
      showSuccess('Success', `"${savedName}" platform added successfully.`);
    } catch (error) {
      handleError(error, 'PlatformManagerScreen.handleAdd');
      showError('Error', ErrorMessages.DB_WRITE);
    }
  };

  const handleDelete = (id, name) => {
    showConfirm(
      'Delete Platform',
      `Are you sure you want to delete "${name}"?`,
      () => {
        try {
          const ok = deletePlatform(id);
          if (!ok) {
            showError('Error', ErrorMessages.DB_DELETE);
            return;
          }
          loadPlatforms();
          showSuccess('Deleted', `"${name}" has been removed.`);
        } catch (error) {
          handleError(error, 'PlatformManagerScreen.handleDelete');
          showError('Error', ErrorMessages.DB_DELETE);
        }
      },
      'Delete',
      true
    );
  };

  const renderItem = ({ item }) => (
    <View style={styles.card}>
      <View style={styles.cardLeft}>
        <View style={styles.iconContainer}>
          <Text style={styles.platformIcon}>{item.icon}</Text>
        </View>
        <View style={styles.platformInfo}>
          <Text style={styles.platformName}>{item.name}</Text>
          <Text style={styles.platformUrl} numberOfLines={1}>{item.url_scheme}</Text>
        </View>
      </View>
      <TouchableOpacity
        style={styles.deleteBtn}
        onPress={() => handleDelete(item.id, item.name)}>
        <Text style={styles.deleteBtnText}>Delete</Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <View style={styles.container}>
      <StatusBar backgroundColor="#fff" barStyle="dark-content" />

      <View style={styles.header}>
        <Text style={styles.headerTitle}>Platforms</Text>
        <Text style={styles.headerSubtitle}>Manage your messaging platforms</Text>
      </View>

      {/* Info Card */}
      <View style={styles.infoCard}>
        <Text style={styles.infoTitle}>How URL Schemes Work</Text>
        <Text style={styles.infoText}>SMS: <Text style={styles.infoCode}>sms:{'{phone}'}?body={'{message}'}</Text></Text>
        <Text style={styles.infoText}>WhatsApp: <Text style={styles.infoCode}>whatsapp://send?phone={'{phone}'}&text={'{message}'}</Text></Text>
        <Text style={styles.infoText}>Gmail: <Text style={styles.infoCode}>mailto:{'{phone}'}?body={'{message}'}</Text></Text>
      </View>

      <FlatList
        data={platforms}
        keyExtractor={item => item.id}
        renderItem={renderItem}
        contentContainerStyle={{ padding: 16, paddingBottom: 100 }}
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyIcon}>📡</Text>
            <Text style={styles.emptyTitle}>No Custom Platforms</Text>
            <Text style={styles.emptySubtitle}>Add a new platform to get started</Text>
          </View>
        }
      />

      <TouchableOpacity
        style={styles.fab}
        onPress={() => setModalVisible(true)}>
        <Text style={styles.fabText}>+ Add Platform</Text>
      </TouchableOpacity>

      {/* Add Platform Modal */}
      <Modal
        visible={modalVisible}
        animationType="slide"
        transparent={true}
        onRequestClose={() => setModalVisible(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Add New Platform</Text>

            <Text style={styles.label}>Platform Name</Text>
            <TextInput
              style={styles.input}
              placeholder="e.g. Gmail"
              placeholderTextColor="#BDBDBD"
              value={name}
              onChangeText={setName}
            />

            <Text style={styles.label}>Select Icon</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.iconScroll}>
              {ICON_OPTIONS.map(emoji => (
                <TouchableOpacity
                  key={emoji}
                  style={[styles.iconOption, icon === emoji && styles.iconOptionSelected]}
                  onPress={() => setIcon(emoji)}>
                  <Text style={styles.iconOptionText}>{emoji}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>

            <Text style={styles.label}>URL Scheme</Text>
            <Text style={styles.hint}>Use {'{phone}'} and {'{message}'} as placeholders</Text>
            <TextInput
              style={[styles.input, styles.urlInput]}
              placeholder="mailto:{phone}?body={message}"
              placeholderTextColor="#BDBDBD"
              value={urlScheme}
              onChangeText={setUrlScheme}
              autoCapitalize="none"
              multiline
            />

            <View style={styles.modalActions}>
              <TouchableOpacity
                style={styles.cancelBtn}
                onPress={() => setModalVisible(false)}>
                <Text style={styles.cancelBtnText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.addBtn}
                onPress={handleAdd}>
                <Text style={styles.addBtnText}>Add Platform</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8F9FA' },
  header: {
    backgroundColor: '#fff',
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#F0F0F0',
  },
  headerTitle: { fontSize: 28, fontWeight: '700', color: '#1A1A2E' },
  headerSubtitle: { fontSize: 14, color: '#888', marginTop: 2 },
  infoCard: {
    backgroundColor: '#EEF2FF',
    margin: 16,
    borderRadius: 12,
    padding: 14,
  },
  infoTitle: { fontSize: 13, fontWeight: '700', color: '#3730A3', marginBottom: 6 },
  infoText: { fontSize: 12, color: '#555', marginBottom: 4 },
  infoCode: { fontSize: 11, color: '#3730A3', fontFamily: 'monospace' },
  card: {
    backgroundColor: '#fff', borderRadius: 14, padding: 14,
    marginBottom: 10, flexDirection: 'row', alignItems: 'center',
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04, shadowRadius: 4, elevation: 2,
  },
  cardLeft: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  iconContainer: {
    width: 44, height: 44, borderRadius: 12,
    backgroundColor: '#F0F0F0', justifyContent: 'center',
    alignItems: 'center', marginRight: 12,
  },
  platformIcon: { fontSize: 22 },
  platformInfo: { flex: 1 },
  platformName: { fontSize: 15, fontWeight: '600', color: '#1A1A2E' },
  platformUrl: { fontSize: 11, color: '#9E9E9E', marginTop: 2 },
  deleteBtn: {
    backgroundColor: '#FFF5F5', paddingHorizontal: 12,
    paddingVertical: 6, borderRadius: 8,
    borderWidth: 1, borderColor: '#FFE0E0',
  },
  deleteBtnText: { color: '#D32F2F', fontSize: 12, fontWeight: '600' },
  fab: {
    position: 'absolute', bottom: 24, right: 20, left: 20,
    backgroundColor: '#1A1A2E', paddingVertical: 16,
    borderRadius: 14, alignItems: 'center', elevation: 5,
  },
  fabText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  emptyContainer: { alignItems: 'center', marginTop: 40 },
  emptyIcon: { fontSize: 50, marginBottom: 12 },
  emptyTitle: { fontSize: 18, fontWeight: '700', color: '#1A1A2E' },
  emptySubtitle: { fontSize: 13, color: '#888', marginTop: 6 },
  modalOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    backgroundColor: '#fff', borderTopLeftRadius: 24,
    borderTopRightRadius: 24, padding: 24, paddingBottom: 40,
  },
  modalTitle: { fontSize: 20, fontWeight: '700', color: '#1A1A2E', marginBottom: 20 },
  label: { fontSize: 13, fontWeight: '700', color: '#1A1A2E', marginBottom: 6, marginTop: 14 },
  hint: { fontSize: 11, color: '#9E9E9E', marginBottom: 8 },
  input: {
    backgroundColor: '#F8F9FA', borderRadius: 10,
    padding: 12, fontSize: 14, color: '#1A1A2E',
    borderWidth: 1, borderColor: '#EEEEEE',
  },
  urlInput: { height: 80, textAlignVertical: 'top' },
  iconScroll: { marginBottom: 4 },
  iconOption: {
    width: 44, height: 44, borderRadius: 10,
    backgroundColor: '#F8F9FA', justifyContent: 'center',
    alignItems: 'center', marginRight: 8,
    borderWidth: 1.5, borderColor: '#EEEEEE',
  },
  iconOptionSelected: { borderColor: '#1A1A2E', backgroundColor: '#EEF2FF' },
  iconOptionText: { fontSize: 22 },
  modalActions: { flexDirection: 'row', gap: 10, marginTop: 24 },
  cancelBtn: {
    flex: 1, paddingVertical: 14, borderRadius: 12,
    alignItems: 'center', borderWidth: 1, borderColor: '#EEEEEE',
  },
  cancelBtnText: { color: '#9E9E9E', fontWeight: '600', fontSize: 15 },
  addBtn: {
    flex: 1, backgroundColor: '#1A1A2E',
    paddingVertical: 14, borderRadius: 12, alignItems: 'center',
  },
  addBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
});