import { useEffect, useState } from 'react';

export function useResource(load, interval = 0) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let timer;
    setLoading(true);
    setError('');
    async function update() {
      try {
        const value = await load(controller.signal);
        if (!controller.signal.aborted) { setData(value); setError(''); }
      } catch (problem) {
        if (!controller.signal.aborted) setError(problem.message);
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          if (interval) timer = setTimeout(update, interval);
        }
      }
    }
    update();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [load, interval, revision]);
  return { data, error, loading, refresh: () => setRevision(value => value + 1) };
}
