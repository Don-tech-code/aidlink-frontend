'use client'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { motion } from 'framer-motion'
import { Heart, Shield, Globe, Zap, Users, TrendingUp, ArrowRight } from 'lucide-react'
import Link from 'next/link'

export function LandingPage() {
  const features = [
    {
      icon: Shield,
      title: 'Transparent Transactions',
      description: 'Every donation is tracked on the Stellar blockchain, ensuring complete transparency and accountability.',
    },
    {
      icon: Zap,
      title: 'Instant Settlement',
      description: 'Funds reach beneficiaries in seconds, not days, eliminating delays in emergency situations.',
    },
    {
      icon: Globe,
      title: 'Global Reach',
      description: 'Borderless aid distribution with support for multiple currencies and regions worldwide.',
    },
    {
      icon: Users,
      title: 'Direct Impact',
      description: 'Donors can see exactly how their contributions are making a difference in real-time.',
    },
  ]

  const stats = [
    { label: 'Total Donations', value: '$2.5M+', icon: TrendingUp },
    { label: 'Active Campaigns', value: '150+', icon: Heart },
    { label: 'Beneficiaries Helped', value: '50K+', icon: Users },
    { label: 'NGO Partners', value: '45+', icon: Globe },
  ]

  return (
    <div className="min-h-screen">
      {/* Navigation */}
      <nav className="border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container flex h-16 items-center justify-between">
          <div className="flex items-center space-x-2">
            <Heart className="h-6 w-6 text-primary" />
            <span className="text-xl font-bold">AidLink</span>
          </div>
          <div className="flex items-center space-x-4">
            <Link href="/auth">
              <Button variant="ghost">Connect Wallet</Button>
            </Link>
            <Link href="/dashboard">
              <Button>Get Started</Button>
            </Link>
          </div>
        </div>
      </nav>

      {/* Hero Section */}
      <section className="container py-20 md:py-32">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="mx-auto max-w-4xl text-center"
        >
          <h1 className="mb-6 text-4xl font-bold tracking-tight sm:text-6xl">
            Transforming Humanitarian Aid with{' '}
            <span className="text-primary">Blockchain Technology</span>
          </h1>
          <p className="mb-8 text-lg text-muted-foreground sm:text-xl">
            Transparent, efficient, and secure aid distribution powered by Stellar. Every donation
            makes a real impact, tracked on the blockchain.
          </p>
          <div className="flex flex-col gap-4 sm:flex-row sm:justify-center">
            <Link href="/dashboard">
              <Button size="lg" className="text-lg">
                Start Donating <ArrowRight className="ml-2 h-5 w-5" />
              </Button>
            </Link>
            <Link href="/campaigns">
              <Button size="lg" variant="outline" className="text-lg">
                View Campaigns
              </Button>
            </Link>
          </div>
        </motion.div>
      </section>

      {/* Stats Section */}
      <section className="border-y bg-muted/50">
        <div className="container py-12">
          <div className="grid gap-8 md:grid-cols-2 lg:grid-cols-4">
            {stats.map((stat, index) => (
              <motion.div
                key={stat.label}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: index * 0.1 }}
                className="text-center"
              >
                <stat.icon className="mx-auto mb-2 h-8 w-8 text-primary" />
                <div className="text-3xl font-bold">{stat.value}</div>
                <div className="text-sm text-muted-foreground">{stat.label}</div>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* Features Section */}
      <section className="container py-20">
        <div className="mx-auto mb-12 max-w-2xl text-center">
          <h2 className="mb-4 text-3xl font-bold">Why Choose AidLink?</h2>
          <p className="text-muted-foreground">
            Built on Stellar blockchain to ensure transparency, speed, and security in aid distribution.
          </p>
        </div>
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
          {features.map((feature, index) => (
            <motion.div
              key={feature.title}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: index * 0.1 }}
            >
              <Card className="h-full">
                <CardHeader>
                  <feature.icon className="mb-2 h-8 w-8 text-primary" />
                  <CardTitle>{feature.title}</CardTitle>
                </CardHeader>
                <CardContent>
                  <CardDescription>{feature.description}</CardDescription>
                </CardContent>
              </Card>
            </motion.div>
          ))}
        </div>
      </section>

      {/* CTA Section */}
      <section className="border-t bg-muted/50">
        <div className="container py-20">
          <div className="mx-auto max-w-3xl text-center">
            <h2 className="mb-4 text-3xl font-bold">Ready to Make a Difference?</h2>
            <p className="mb-8 text-lg text-muted-foreground">
              Join thousands of donors and NGOs already using AidLink to transform humanitarian aid.
            </p>
            <div className="flex flex-col gap-4 sm:flex-row sm:justify-center">
              <Link href="/auth">
                <Button size="lg" className="text-lg">
                  Connect Your Wallet
                </Button>
              </Link>
              <Link href="/ngo-onboarding">
                <Button size="lg" variant="outline" className="text-lg">
                  Register as NGO
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t bg-background">
        <div className="container py-8">
          <div className="flex flex-col items-center justify-between gap-4 md:flex-row">
            <div className="flex items-center space-x-2">
              <Heart className="h-5 w-5 text-primary" />
              <span className="font-semibold">AidLink</span>
            </div>
            <div className="flex gap-6 text-sm text-muted-foreground">
              <Link href="/about" className="hover:text-foreground">
                About
              </Link>
              <Link href="/privacy" className="hover:text-foreground">
                Privacy
              </Link>
              <Link href="/terms" className="hover:text-foreground">
                Terms
              </Link>
              <Link href="/contact" className="hover:text-foreground">
                Contact
              </Link>
            </div>
            <div className="text-sm text-muted-foreground">
              © 2026 AidLink. Built on Stellar.
            </div>
          </div>
        </div>
      </footer>
    </div>
  )
}
