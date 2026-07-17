/**
 * @format
 */

import { AppRegistry } from 'react-native';
import App from './App';
import { name as appName } from './app.json';
import { AlarmFiredTask, RescheduleAlarmsTask, SafetyNetTask, ReconcilerTask } from './src/utils/alarmHeadlessTask';
import { debugTrace, debugTraceError } from './src/utils/debugTrace';

const wrapHeadlessTask = (taskName, taskFn) => async (data) => {
  debugTrace('HeadlessJsTaskStart', {
    taskName,
    contactId: data?.contactId ?? '',
    templateId: data?.templateId ?? '',
    requestCode: data?.requestCode ?? '',
  });
  try {
    await taskFn(data);
    debugTrace('HeadlessJsTaskEnd', { taskName, outcome: 'success' });
  } catch (error) {
    debugTraceError('HeadlessJsTaskEnd', error, { taskName, outcome: 'error' });
    throw error;
  }
};

AppRegistry.registerComponent(appName, () => App);

// Headless JS tasks — these run even when the app is fully killed,
// triggered by AlarmTaskService.kt (see AlarmReceiver.kt / BootReceiver.kt).
AppRegistry.registerHeadlessTask('AlarmFiredTask', () => wrapHeadlessTask('AlarmFiredTask', AlarmFiredTask));
AppRegistry.registerHeadlessTask('RescheduleAlarmsTask', () => wrapHeadlessTask('RescheduleAlarmsTask', RescheduleAlarmsTask));
AppRegistry.registerHeadlessTask('SafetyNetTask', () => wrapHeadlessTask('SafetyNetTask', SafetyNetTask));
AppRegistry.registerHeadlessTask('ReconcilerTask', () => wrapHeadlessTask('ReconcilerTask', ReconcilerTask));