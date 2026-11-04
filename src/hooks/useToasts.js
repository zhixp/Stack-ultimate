import { useCallback, useRef, useState } from 'react';

export function useToasts() {
  const [toasts, setToasts] = useState([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id) => setToasts((list) => list.filter((t) => t.id !== id)), []);

  const push = useCallback(
    (message, { tone = 'info', ttl = 4500, id } = {}) => {
      const toastId = id || nextId.current++;
      setToasts((list) => [...list.filter((t) => t.id !== toastId), { id: toastId, message, tone }].slice(-3));
      if (ttl) setTimeout(() => dismiss(toastId), ttl);
      return toastId;
    },
    [dismiss],
  );

  return { toasts, push, dismiss };
}
