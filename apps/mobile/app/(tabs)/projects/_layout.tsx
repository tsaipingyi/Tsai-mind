import { Stack } from 'expo-router';
import { C } from '../../../src/theme';

/** 项目 tab: list → project (list / map) → node, all with the tab bar visible and their own headers. */
export const unstable_settings = { initialRouteName: 'index' };

export default function ProjectsLayout() {
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: C.paper } }} />;
}
