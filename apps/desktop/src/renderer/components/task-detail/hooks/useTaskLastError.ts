import { useEffect, useState } from 'react';
import type { TaskLogEntry, TaskLogPhase, TaskLogs } from '../../../../shared/types';

export interface LastErrorEntry {
  phase: TaskLogPhase;
  content: string;
  detail?: string;
  timestamp: string;
}

const PHASE_ORDER: TaskLogPhase[] = ['validation', 'coding', 'planning'];

function findLatestErrorEntry(logs: TaskLogs | null): LastErrorEntry | null {
  if (!logs) return null;

  let latest: TaskLogEntry | null = null;
  for (const phase of PHASE_ORDER) {
    const entries = logs.phases[phase]?.entries ?? [];
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.type !== 'error') continue;
      if (!latest || new Date(entry.timestamp).getTime() > new Date(latest.timestamp).getTime()) {
        latest = entry;
      }
      break;
    }
  }

  if (!latest) return null;
  return {
    phase: latest.phase,
    content: latest.content,
    detail: latest.detail,
    timestamp: latest.timestamp,
  };
}

export function useTaskLastError(
  projectId: string | undefined,
  specId: string | undefined,
  enabled: boolean,
): { error: LastErrorEntry | null; loading: boolean } {
  const [error, setError] = useState<LastErrorEntry | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!enabled || !projectId || !specId) {
      setError(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

    window.electronAPI.getTaskLogs(projectId, specId)
      .then((result) => {
        if (cancelled) return;
        if (result.success && result.data) {
          setError(findLatestErrorEntry(result.data));
        } else {
          setError(null);
        }
      })
      .catch(() => {
        if (!cancelled) setError(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [projectId, specId, enabled]);

  return { error, loading };
}
