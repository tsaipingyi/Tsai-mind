import { Redirect, useLocalSearchParams } from 'expo-router';

/** Old deep link (`/node/:id`, also used by push payloads from older builds) → the node inside the 项目 tab. */
export default function NodeRedirect() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <Redirect href={`/projects/node/${id}`} />;
}
