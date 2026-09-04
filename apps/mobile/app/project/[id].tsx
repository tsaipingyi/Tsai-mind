import { Redirect, useLocalSearchParams } from 'expo-router';

/** Old deep link (`/project/:id`) → the project inside the 项目 tab. */
export default function ProjectRedirect() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <Redirect href={`/projects/${id}`} />;
}
