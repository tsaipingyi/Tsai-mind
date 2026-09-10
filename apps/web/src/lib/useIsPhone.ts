import { useEffect, useState } from 'react';

/** The phone breakpoint (design/mobile-v2 is drawn at 390px; anything up to 700px gets the simplified layout). */
export const PHONE_QUERY = '(max-width: 700px)';

export function isPhoneNow(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(PHONE_QUERY).matches;
}

/** true when the viewport is phone-sized; re-renders on resize / rotation. */
export function useIsPhone(): boolean {
  const [phone, setPhone] = useState(isPhoneNow);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const m = window.matchMedia(PHONE_QUERY);
    const onChange = () => setPhone(m.matches);
    onChange();
    m.addEventListener('change', onChange);
    return () => m.removeEventListener('change', onChange);
  }, []);
  return phone;
}
