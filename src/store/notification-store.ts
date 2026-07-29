import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

export type NotificationType = 'donation' | 'campaign' | 'system' | 'beneficiary' | 'transaction'

export interface Notification {
  id: string
  type: NotificationType
  title: string
  message: string
  timestamp: Date
  read: boolean
  actionUrl?: string
}

export interface NotificationStore {
  notifications: Notification[]
  unreadCount: number
  addNotification: (notification: Omit<Notification, 'id' | 'timestamp' | 'read'>) => void
  markAsRead: (id: string) => void
  markAllAsRead: () => void
  removeNotification: (id: string) => void
  clearAll: () => void
}

export const NOTIFICATION_STORAGE_KEY = 'notification-storage'
export const MAX_NOTIFICATIONS = 50

function createNotificationId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
}

function reviveNotificationTimestamps(
  notifications: Notification[]
): Notification[] {
  return notifications.map((notification) => ({
    ...notification,
    timestamp:
      notification.timestamp instanceof Date
        ? notification.timestamp
        : new Date(notification.timestamp),
  }))
}

export const useNotificationStore = create<NotificationStore>()(
  persist(
    (set) => ({
      notifications: [],
      unreadCount: 0,

      addNotification: (notification) =>
        set((state) => {
          let notifications = state.notifications
          let unreadCount = state.unreadCount + 1

          // FIFO eviction: newest are prepended, so the oldest is last.
          if (notifications.length >= MAX_NOTIFICATIONS) {
            const oldest = notifications[notifications.length - 1]
            notifications = notifications.slice(0, -1)
            if (oldest && !oldest.read) {
              unreadCount = Math.max(0, unreadCount - 1)
            }
          }

          const next: Notification = {
            ...notification,
            id: createNotificationId(),
            timestamp: new Date(),
            read: false,
          }

          return {
            notifications: [next, ...notifications],
            unreadCount,
          }
        }),

      markAsRead: (id) =>
        set((state) => {
          const target = state.notifications.find((n) => n.id === id)
          if (!target || target.read) {
            return state
          }

          return {
            notifications: state.notifications.map((n) =>
              n.id === id ? { ...n, read: true } : n
            ),
            unreadCount: Math.max(0, state.unreadCount - 1),
          }
        }),

      markAllAsRead: () =>
        set((state) => ({
          notifications: state.notifications.map((n) => ({ ...n, read: true })),
          unreadCount: 0,
        })),

      removeNotification: (id) =>
        set((state) => {
          const target = state.notifications.find((n) => n.id === id)
          if (!target) {
            return state
          }

          return {
            notifications: state.notifications.filter((n) => n.id !== id),
            unreadCount: target.read
              ? state.unreadCount
              : Math.max(0, state.unreadCount - 1),
          }
        }),

      clearAll: () =>
        set({
          notifications: [],
          unreadCount: 0,
        }),
    }),
    {
      name: NOTIFICATION_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage, {
        reviver: (key, value) => {
          if (key === 'timestamp' && typeof value === 'string') {
            return new Date(value)
          }
          return value
        },
      }),
      partialize: (state) => ({
        notifications: state.notifications,
        unreadCount: state.unreadCount,
      }),
      onRehydrateStorage: () => (state) => {
        if (!state) return
        state.notifications = reviveNotificationTimestamps(state.notifications)
        state.unreadCount = state.notifications.filter((n) => !n.read).length
      },
    }
  )
)
