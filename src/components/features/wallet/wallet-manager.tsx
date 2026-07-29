'use client';

import { useState } from 'react';
import { useWalletEnhanced } from '@/hooks/use-wallet-enhanced';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Copy, Check } from 'lucide-react';
import { toast } from 'sonner';

export function WalletManager() {
  const { wallet, loading, error, connectWallet, disconnectWallet, switchNetwork, refreshBalance } = useWalletEnhanced();
  const [copied, setCopied] = useState(false);

  const handleCopyAddress = async () => {
    try {
      await navigator.clipboard.writeText(wallet.publicKey);
      setCopied(true);
      toast.success('Address copied to clipboard!');
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      toast.error('Failed to copy address');
    }
  };

  return (
    <Card className="p-6">
      <div className="flex justify-between items-start mb-4">
        <div>
          <h3 className="text-lg font-semibold">Wallet Status</h3>
          {wallet.isConnected && (
            <Badge variant="secondary" className="mt-2">
              {wallet.network}
            </Badge>
          )}
        </div>
        {wallet.isConnected ? (
          <Button variant="outline" onClick={disconnectWallet} disabled={loading}>
            Disconnect
          </Button>
        ) : (
          <Button onClick={connectWallet} disabled={loading}>
            {loading ? 'Connecting...' : 'Connect Wallet'}
          </Button>
        )}
      </div>

      {error && <p className="text-red-500 mb-4">{error}</p>}

      {wallet.isConnected && (
        <div className="space-y-4">
          <div>
            <p className="text-sm text-muted-foreground">Public Key</p>
            <div className="flex items-center gap-2">
              <p className="font-mono text-sm">{wallet.publicKey}</p>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0"
                onClick={handleCopyAddress}
                aria-label="Copy address"
              >
                {copied ? (
                  <Check className="h-3.5 w-3.5 text-green-600" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
              </Button>
            </div>
          </div>
          <div>
            <p className="text-sm text-muted-foreground">Balance</p>
            <p className="text-2xl font-bold">{wallet.balance.toFixed(2)} XLM</p>
          </div>

          <div className="flex gap-2">
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="outline" size="sm">Switch Network</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Select Network</DialogTitle>
                </DialogHeader>
                <div className="space-y-2">
                  <Button
                    variant={wallet.network === 'testnet' ? 'default' : 'outline'}
                    className="w-full"
                    onClick={() => switchNetwork('testnet')}
                  >
                    Testnet
                  </Button>
                  <Button
                    variant={wallet.network === 'mainnet' ? 'default' : 'outline'}
                    className="w-full"
                    onClick={() => switchNetwork('mainnet')}
                  >
                    Mainnet
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
            <Button variant="outline" size="sm" onClick={refreshBalance} disabled={loading}>
              Refresh Balance
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
