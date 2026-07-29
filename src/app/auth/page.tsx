'use client'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Wallet, Shield, CheckCircle2, AlertCircle } from 'lucide-react'
import { useState } from 'react'
import { useWalletStore } from '@/store/wallet-store'
import { toast } from 'sonner'
import { useRouter } from 'next/navigation'
import type { WalletId } from '@/lib/wallet/wallet-service'

export default function AuthPage() {
  const [isConnecting, setIsConnecting] = useState(false)
  const { setWallet, isConnected, network } = useWalletStore()
  const router = useRouter()

  const handleConnectWallet = async (walletId: WalletId) => {
    setIsConnecting(true)
    try {
      const { walletService } = await import('@/lib/wallet/wallet-service')
      
      // Connect with the specified wallet
      const walletInfo = await walletService.connect(walletId, network)
      
      // Get balance from Soroban SDK
      const { sorobanSDK } = await import('@/lib/soroban/sdk')
      const balance = await sorobanSDK.getBalance(walletInfo.address)
      
      setWallet({
        isConnected: true,
        address: walletInfo.address,
        publicKey: walletInfo.publicKey,
        network: walletInfo.network as 'mainnet' | 'testnet' | 'futurenet' | 'standalone',
        balance,
      })
      
      toast.success('Wallet connected successfully!', {
        description: `Connected to ${walletInfo.address.substring(0, 8)}...${walletInfo.address.substring(walletInfo.address.length - 4)}`,
      })
      
      router.push('/dashboard')
    } catch (error) {
      console.error('Wallet connection error:', error)
      toast.error('Failed to connect wallet', {
        description: error instanceof Error ? error.message : `Please make sure ${walletId} is installed and try again`,
      })
    } finally {
      setIsConnecting(false)
    }
  }

  if (isConnected) {
    router.push('/dashboard')
    return null
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/50 p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <Wallet className="h-12 w-12 text-primary mx-auto mb-4" />
          <h1 className="text-3xl font-bold mb-2">Connect Your Wallet</h1>
          <p className="text-muted-foreground">
            Connect your Stellar wallet to access the AidLink platform
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Choose Wallet</CardTitle>
            <CardDescription>
              Select your preferred wallet to connect
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Button
              onClick={() => handleConnectWallet('freighter')}
              disabled={isConnecting}
              className="w-full h-12 text-lg"
              size="lg"
            >
              {isConnecting ? (
                <>Connecting...</>
              ) : (
                <>
                  <Wallet className="mr-2 h-5 w-5" />
                  Connect with Stellar Wallet
                </>
              )}
            </Button>

            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <span className="w-full border-t" />
              </div>
              <div className="relative flex justify-center text-xs uppercase">
                <span className="bg-background px-2 text-muted-foreground">
                  Or continue with
                </span>
              </div>
            </div>

            <div className="grid gap-2">
              <Button 
                variant="outline" 
                className="w-full" 
                disabled={isConnecting}
                onClick={() => handleConnectWallet('freighter')}
              >
                <Shield className="mr-2 h-4 w-4" />
                Freighter
              </Button>
              <Button 
                variant="outline" 
                className="w-full" 
                disabled={isConnecting}
                onClick={() => handleConnectWallet('rabet')}
              >
                <Shield className="mr-2 h-4 w-4" />
                Rabet
              </Button>
              <Button 
                variant="outline" 
                className="w-full" 
                disabled={isConnecting}
                onClick={() => handleConnectWallet('xbull')}
              >
                <Shield className="mr-2 h-4 w-4" />
                XBull
              </Button>
            </div>
          </CardContent>
        </Card>

        <div className="mt-6 space-y-3">
          <div className="flex items-start gap-2 text-sm text-muted-foreground">
            <CheckCircle2 className="h-4 w-4 text-green-500 mt-0.5" />
            <span>Secure connection with Stellar blockchain</span>
          </div>
          <div className="flex items-start gap-2 text-sm text-muted-foreground">
            <CheckCircle2 className="h-4 w-4 text-green-500 mt-0.5" />
            <span>Your private keys never leave your device</span>
          </div>
          <div className="flex items-start gap-2 text-sm text-muted-foreground">
            <CheckCircle2 className="h-4 w-4 text-green-500 mt-0.5" />
            <span>Transparent and trackable transactions</span>
          </div>
        </div>

        <div className="mt-6 p-4 bg-yellow-50 dark:bg-yellow-900/20 rounded-lg border border-yellow-200 dark:border-yellow-800">
          <div className="flex items-start gap-2">
            <AlertCircle className="h-4 w-4 text-yellow-600 dark:text-yellow-500 mt-0.5" />
            <div className="text-sm text-yellow-800 dark:text-yellow-200">
              <p className="font-medium mb-1">Testnet Mode</p>
              <p className="text-xs">
                Currently connected to Stellar Testnet. No real funds are used.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
