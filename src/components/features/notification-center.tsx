'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Bell, CheckCheck, Trash2, X } from 'lucide-react'
import { useNotificationStore } from '@/store/notification-store'
import { formatDistanceToNow } from 'date-fns'

export function NotificationCenter() {
  const { notifications, unreadCount, markAsRead, markAllAsRead, removeNotification } =
    useNotificationStore()
  const [isOpen, setIsOpen] = useState(false)

  const getNotificationIcon = (type: string) => {
    switch (type) {
      case 'donation':
        return '💰'
      case 'campaign':
        return '🎯'
      case 'system':
        return '⚙️'
      case 'beneficiary':
        return '👤'
      case 'transaction':
        return '📊'
      default:
        return '📢'
    }
  }

  const getNotificationColor = (type: string) => {
    switch (type) {
      case 'donation':
        return 'bg-green-500'
      case 'campaign':
        return 'bg-blue-500'
      case 'system':
        return 'bg-gray-500'
      case 'beneficiary':
        return 'bg-purple-500'
      case 'transaction':
        return 'bg-orange-500'
      default:
        return 'bg-gray-500'
    }
  }

  const handleNotificationClick = (id: string, actionUrl?: string) => {
    markAsRead(id)
    if (actionUrl) {
      window.location.href = actionUrl
    }
    setIsOpen(false)
  }

  return (
    <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="relative">
          <Bell className="h-5 w-5" />
          {unreadCount > 0 && (
            <Badge
              className="absolute -top-1 -right-1 h-5 w-5 flex items-center justify-center p-0 text-xs"
              variant="destructive"
            >
              {unreadCount}
            </Badge>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel className="flex items-center justify-between">
          <span>Notifications</span>
          {unreadCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-auto p-1 text-xs"
              onClick={(e) => {
                e.stopPropagation()
                markAllAsRead()
              }}
            >
              <CheckCheck className="h-4 w-4 mr-1" />
              Mark all read
            </Button>
          )}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        
        <ScrollArea className="h-96">
          {notifications.length === 0 ? (
            <div className="p-4 text-center text-muted-foreground">
              <Bell className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p className="text-sm">No notifications</p>
            </div>
          ) : (
            <div className="p-2">
              {notifications.map((notification) => (
                <div
                  key={notification.id}
                  className={`p-3 rounded-lg mb-2 cursor-pointer transition-colors hover:bg-muted/50 ${
                    !notification.read ? 'bg-muted/30' : ''
                  }`}
                  onClick={() => handleNotificationClick(notification.id, notification.actionUrl)}
                >
                  <div className="flex items-start gap-3">
                    <div
                      className={`h-8 w-8 rounded-full flex items-center justify-center text-sm ${getNotificationColor(
                        notification.type
                      )}`}
                    >
                      {getNotificationIcon(notification.type)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-sm font-medium truncate">{notification.title}</p>
                        {!notification.read && (
                          <div className="h-2 w-2 rounded-full bg-blue-500 mt-1.5 flex-shrink-0" />
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground line-clamp-2">
                        {notification.message}
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">
                        {formatDistanceToNow(new Date(notification.timestamp), { addSuffix: true })}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 flex-shrink-0"
                      onClick={(e) => {
                        e.stopPropagation()
                        removeNotification(notification.id)
                      }}
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>

        {notifications.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-center text-destructive focus:text-destructive"
              onClick={() => {
                if (confirm('Are you sure you want to clear all notifications?')) {
                  useNotificationStore.getState().clearAll()
                }
              }}
            >
              <Trash2 className="h-4 w-4 mr-2" />
              Clear all notifications
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
