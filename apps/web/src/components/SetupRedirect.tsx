'use client';

import { useEffect } from 'react';

export function SetupRedirect() {
  useEffect(() => {
    fetch('/api/setup/status')
      .then((r) => r.json())
      .then((data) => {
        if (!data.setupComplete) {
          window.location.href = '/setup';
        }
      })
      .catch(() => {
        // If setup endpoint fails, don't redirect — app may be in a broken state
      });
  }, []);

  return null;
}
