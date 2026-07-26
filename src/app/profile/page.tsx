'use client'

import { Navigation } from '@/components/layout/navigation'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useWalletStore } from '@/store/wallet-store'
import { formatAddress } from '@/lib/utils'
import { Wallet, AlertCircle, Heart, Settings } from 'lucide-react'

export default function ProfilePage() {
  const { address, isConnected } = useWalletStore()

  if (!isConnected) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <AlertCircle className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
          <h2 className="text-2xl font-bold mb-2">Wallet Not Connected</h2>
          <p className="text-muted-foreground mb-4">Please connect your wallet to view your profile</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background">
      <Navigation />

      <main className="container py-8">
        <div className="mb-8">
          <h1 className="text-3xl font-bold mb-2">Profile</h1>
          <p className="text-muted-foreground">Manage your account and view your activity</p>
        </div>

        <Card className="mb-8">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Wallet Address</CardTitle>
            <Wallet className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-sm font-medium">{formatAddress(address || '')}</div>
          </CardContent>
        </Card>

        <div className="grid gap-6 md:grid-cols-2">
          <Card>
            <CardHeader className="flex flex-row items-center space-y-0 pb-2">
              <Heart className="h-4 w-4 text-muted-foreground mr-2" />
              <CardTitle className="text-sm font-medium">My Donations</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-center py-8">
                <Heart className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                <h3 className="text-lg font-semibold mb-2">No Donations Yet</h3>
                <p className="text-muted-foreground">Your donation history will appear here.</p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center space-y-0 pb-2">
              <Settings className="h-4 w-4 text-muted-foreground mr-2" />
              <CardTitle className="text-sm font-medium">Account Settings</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-center py-8">
                <Settings className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                <h3 className="text-lg font-semibold mb-2">Settings Coming Soon</h3>
                <p className="text-muted-foreground">Account settings will be available in a future update.</p>
              </div>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  )
}
