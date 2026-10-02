import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { backend } from '../lib/backend/current.js';
import { useAuth } from './AuthContext.jsx';
import { playSound } from '../lib/sound.js';

const NotificationsContext = createContext(null);

/**
 * OS notifications. Loads from backend.notifications on login;
 * push/markRead/dismiss/clearAll all write through the backend.
 */
export function NotificationsProvider({ children }) {
  const { user } = useAuth();
  const [notifications, setNotifications] = useState([]);

  useEffect(() => {
    let cancelled = false;
    if (!user) {
      setNotifications([]);
      return;
    }
    (async () => {
      try {
        const list = await backend.notifications.list();
        if (!cancelled) setNotifications(Array.isArray(list) ? list : []);
      } catch (e) {
        console.error('[drift] notifications load failed:', e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const push = useCallback(async (title, body) => {
    const notif = await backend.notifications.push({ title, body });
    setNotifications((prev) => [notif, ...prev]);
    playSound('notification');
    return notif;
  }, []);

  const markRead = useCallback(async (id) => {
    await backend.notifications.markRead(id);
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
  }, []);

  const dismiss = useCallback(async (id) => {
    await backend.notifications.dismiss(id);
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  }, []);

  const clearAll = useCallback(async () => {
    await backend.notifications.clearAll();
    setNotifications([]);
  }, []);

  const unreadCount = notifications.filter((n) => !n.read).length;

  const value = { notifications, unreadCount, push, markRead, dismiss, clearAll };
  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}

export function useNotifications() {
  const ctx = useContext(NotificationsContext);
  if (!ctx) throw new Error('useNotifications must be used inside <NotificationsProvider>.');
  return ctx;
}
