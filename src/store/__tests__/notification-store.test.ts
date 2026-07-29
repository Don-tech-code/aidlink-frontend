import {
  MAX_NOTIFICATIONS,
  NOTIFICATION_STORAGE_KEY,
  useNotificationStore,
  type Notification,
} from '../notification-store'

function resetStore() {
  localStorage.removeItem(NOTIFICATION_STORAGE_KEY)
  useNotificationStore.setState({
    notifications: [],
    unreadCount: 0,
  })
}

function seedNotification(
  overrides: Partial<Omit<Notification, 'id' | 'timestamp' | 'read'>> = {}
) {
  useNotificationStore.getState().addNotification({
    type: 'system',
    title: 'Test notification',
    message: 'Test message',
    ...overrides,
  })
}

describe('useNotificationStore', () => {
  beforeEach(() => {
    resetStore()
  })

  it('starts with an empty inbox (no demo notifications)', () => {
    const { notifications, unreadCount } = useNotificationStore.getState()
    expect(notifications).toEqual([])
    expect(unreadCount).toBe(0)
  })

  it('persists notifications across a simulated page reload', async () => {
    seedNotification({
      type: 'donation',
      title: 'Donation Received',
      message: 'You received 100 XLM',
      actionUrl: '/dashboard',
    })

    const beforeReload = useNotificationStore.getState().notifications
    expect(beforeReload).toHaveLength(1)
    expect(beforeReload[0].title).toBe('Donation Received')

    const persisted = localStorage.getItem(NOTIFICATION_STORAGE_KEY)
    expect(persisted).toBeTruthy()

    // Simulate an in-memory wipe (page reload) while keeping storage intact.
    useNotificationStore.setState({
      notifications: [],
      unreadCount: 0,
    })
    localStorage.setItem(NOTIFICATION_STORAGE_KEY, persisted!)

    await useNotificationStore.persist.rehydrate()

    const afterReload = useNotificationStore.getState().notifications
    expect(afterReload).toHaveLength(1)
    expect(afterReload[0].title).toBe('Donation Received')
    expect(afterReload[0].message).toBe('You received 100 XLM')
    expect(afterReload[0].actionUrl).toBe('/dashboard')
  })

  it('revives timestamp as a Date instance after rehydration', async () => {
    seedNotification({ title: 'Date revive check' })

    const persisted = localStorage.getItem(NOTIFICATION_STORAGE_KEY)
    expect(persisted).toBeTruthy()
    expect(JSON.parse(persisted!).state.notifications[0].timestamp).toEqual(
      expect.any(String)
    )

    useNotificationStore.setState({
      notifications: [],
      unreadCount: 0,
    })
    localStorage.setItem(NOTIFICATION_STORAGE_KEY, persisted!)

    await useNotificationStore.persist.rehydrate()

    const [notification] = useNotificationStore.getState().notifications
    expect(notification.timestamp).toBeInstanceOf(Date)
    expect(Number.isNaN(notification.timestamp.getTime())).toBe(false)
  })

  it('caps the store at 50 notifications (FIFO eviction)', () => {
    for (let i = 0; i < MAX_NOTIFICATIONS + 1; i += 1) {
      seedNotification({
        title: `Notification ${i}`,
        message: `Message ${i}`,
      })
    }

    const { notifications } = useNotificationStore.getState()
    expect(notifications).toHaveLength(MAX_NOTIFICATIONS)
    // Newest first: index 0 is the 51st insert (Notification 50).
    expect(notifications[0].title).toBe(`Notification ${MAX_NOTIFICATIONS}`)
    // Oldest remaining should be Notification 1 (Notification 0 was evicted).
    expect(notifications[notifications.length - 1].title).toBe('Notification 1')
    expect(notifications.some((n) => n.title === 'Notification 0')).toBe(false)
  })

  it('keeps unreadCount correct when an unread notification is evicted', () => {
    // Fill to capacity with unread notifications.
    for (let i = 0; i < MAX_NOTIFICATIONS; i += 1) {
      seedNotification({ title: `Unread ${i}` })
    }

    expect(useNotificationStore.getState().unreadCount).toBe(MAX_NOTIFICATIONS)

    // Adding one more evicts the oldest unread and adds a new unread → still 50.
    seedNotification({ title: 'Newest unread' })

    const { notifications, unreadCount } = useNotificationStore.getState()
    expect(notifications).toHaveLength(MAX_NOTIFICATIONS)
    expect(unreadCount).toBe(MAX_NOTIFICATIONS)
    expect(notifications.every((n) => !n.read)).toBe(true)
  })

  it('does not over-decrement unreadCount when a read notification is evicted', () => {
    for (let i = 0; i < MAX_NOTIFICATIONS; i += 1) {
      seedNotification({ title: `Item ${i}` })
    }

    const oldestId =
      useNotificationStore.getState().notifications[MAX_NOTIFICATIONS - 1].id
    useNotificationStore.getState().markAsRead(oldestId)

    expect(useNotificationStore.getState().unreadCount).toBe(
      MAX_NOTIFICATIONS - 1
    )

    seedNotification({ title: 'After eviction' })

    const { notifications, unreadCount } = useNotificationStore.getState()
    expect(notifications).toHaveLength(MAX_NOTIFICATIONS)
    // Evicted was read (no unread change from eviction); new one is unread → back to 50.
    expect(unreadCount).toBe(MAX_NOTIFICATIONS)
    expect(notifications.some((n) => n.id === oldestId)).toBe(false)
  })
})
