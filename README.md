# AidLink Frontend

<div align="center">

![AidLink Logo](http://web.archive.org/web/20250107203856/https://via.placeholder.com/150)

**A production-grade decentralized humanitarian aid platform frontend built on the Stellar blockchain**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Next.js](https://img.shields.io/badge/Next.js-15-black)](https://nextjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue)](https://www.typescriptlang.org/)
[![Stellar](https://img.shields.io/badge/Stellar-Soroban-purple)](https://www.stellar.org/)
[![CI/CD](https://github.com/BarryArinze/aidlink-frontend/actions/workflows/ci.yml/badge.svg)](https://github.com/BarryArinze/aidlink-frontend/actions/workflows/ci.yml)

[Features](#-features) • [Tech Stack](#-tech-stack) • [Installation](#-installation) • [Documentation](#-documentation) • [Contributing](#-contributing)

</div>

## 🌟 Features

- **Transparent Donations**: Every transaction is tracked on the Stellar blockchain for full transparency
- **Campaign Management**: Create, fund, and track humanitarian aid campaigns with advanced filtering
- **Beneficiary Portal**: Claim aid with QR verification and track claim history
- **Admin Dashboard**: Verify beneficiaries, moderate campaigns, and monitor platform activity
- **Real-time Analytics**: Track donations, distributions, and impact metrics with live updates
- **Multi-wallet Support**: Compatible with Freighter, Rabet, XBull, and more wallet providers
- **Responsive Design**: Optimized for desktop, tablet, and mobile devices with bottom navigation
- **Dark/Light Mode**: Built-in theme switching with smooth transitions
- **Accessibility**: WCAG 2.1 AA compliant for inclusive design
- **Gamification**: Impact badges and achievements to encourage donor engagement
- **Social Sharing**: Share campaigns on X, Facebook, LinkedIn with one click
- **Campaign Comparison**: Compare up to 3 campaigns side-by-side for informed decisions
- **Export Functionality**: Export donation history in CSV or JSON formats
- **Notification Center**: Real-time notifications for donations and updates

## 🚀 Tech Stack

- **Framework**: Next.js 15 (App Router)
- **Language**: TypeScript
- **Styling**: TailwindCSS + shadcn/ui
- **State Management**: Zustand
- **Data Fetching**: React Query
- **Animations**: Framer Motion
- **Blockchain**: Stellar SDK + Soroban
- **Wallet Integration**: Stellar Wallet Kit
- **Testing**: Jest + Playwright
- **CI/CD**: GitHub Actions
- **Deployment**: Vercel

## 📋 Prerequisites

- Node.js 20 or higher
- npm or yarn
- Git

## 🛠️ Installation

1. Clone the repository:
```bash
git clone https://github.com/your-org/aidlink-frontend.git
cd aidlink-frontend
```

2. Install dependencies:
```bash
npm install
```

3. Set up environment variables:
```bash
cp .env.example .env.local
```

4. Run the development server:
```bash
npm run dev
```

5. Open [http://localhost:3000](http://localhost:3000) in your browser

## 🔧 Configuration

### Environment Variables

All client-side environment variables must be prefixed with `NEXT_PUBLIC_`. After changing any of them, restart the dev server.

Copy the example file and fill in your values:

```bash
cp .env.example .env.local
```

| Variable | Description | Default |
|---|---|---|
| `NEXT_PUBLIC_HORIZON_MAINNET` | Mainnet Horizon REST API URL | `https://horizon.stellar.org` |
| `NEXT_PUBLIC_HORIZON_TESTNET` | Testnet Horizon REST API URL | `https://horizon-testnet.stellar.org` |
| `NEXT_PUBLIC_HORIZON_FUTURENET` | Futurenet Horizon REST API URL | `https://horizon-futurenet.stellar.org` |
| `NEXT_PUBLIC_HORIZON_STANDALONE` | Standalone Horizon REST API URL | `http://localhost:8000` |
| `NEXT_PUBLIC_SOROBAN_RPC_MAINNET` | Mainnet Soroban RPC endpoint | `https://rpc.mainnet.stellar.org` |
| `NEXT_PUBLIC_SOROBAN_RPC_TESTNET` | Testnet Soroban RPC endpoint | `https://soroban-testnet.stellar.org` |
| `NEXT_PUBLIC_SOROBAN_RPC_FUTURENET` | Futurenet Soroban RPC endpoint | `https://rpc-futurenet.stellar.org` |
| `NEXT_PUBLIC_SOROBAN_RPC_STANDALONE` | Standalone Soroban RPC endpoint | `http://localhost:8000/soroban/rpc` |
| `NEXT_PUBLIC_DEFAULT_NETWORK` | Default network | `testnet` |
| `NEXT_PUBLIC_SUPPORTED_NETWORKS` | Comma-separated list of networks | `testnet,futurenet` |
| `NEXT_PUBLIC_AID_TOKEN_CONTRACT` | AID token contract ID | _(empty)_ |
| `NEXT_PUBLIC_CAMPAIGN_MANAGER_CONTRACT` | Campaign manager contract ID | _(empty)_ |
| `NEXT_PUBLIC_BENEFICIARY_REGISTRY_CONTRACT` | Beneficiary registry contract ID | _(empty)_ |
| `NEXT_PUBLIC_API_URL` | Backend API base URL | `http://localhost:3000/api` |
| `NEXT_PUBLIC_ENABLE_ANALYTICS` | Enable analytics tracking | `true` |
| `NEXT_PUBLIC_ENABLE_ERROR_TRACKING` | Enable error tracking | `true` |

### Network Configuration

The application supports multiple Stellar networks configured at runtime via environment variables:

- **Testnet** (`testnet`): Default for development and testing
- **Futurenet** (`futurenet`): For testing upcoming protocol features
- **Mainnet** (`mainnet`): Production network
- **Standalone** (`standalone`): Local development with Quickstart Docker image

## 📁 Project Structure

```
aidlink-frontend/
├── src/
│   ├── app/              # Next.js app router pages
│   │   ├── (auth)/       # Authentication pages
│   │   ├── (dashboard)/  # Dashboard pages
│   │   ├── (public)/     # Public pages
│   │   ├── api/          # API routes
│   │   ├── campaigns/    # Campaign pages
│   │   ├── beneficiary/  # Beneficiary portal
│   │   └── admin/        # Admin portal
│   ├── components/       # React components
│   │   ├── features/     # Feature-specific components
│   │   ├── layout/       # Layout components
│   │   └── ui/           # shadcn/ui components
│   ├── hooks/            # Custom React hooks
│   ├── lib/              # Utility libraries
│   │   └── soroban/      # Soroban SDK integration
│   ├── store/            # Zustand stores
│   ├── types/            # TypeScript types
│   ├── config/           # Configuration files
│   └── utils/            # Utility functions
├── e2e/                  # Playwright E2E tests
├── public/               # Static assets
├── .github/              # GitHub Actions workflows
└── docs/                 # Documentation
```

## 🧪 Testing

### Unit Tests
```bash
npm run test
```

### E2E Tests
```bash
npm run test:e2e
```

### Linting
```bash
npm run lint
```

### Type Checking
```bash
npm run type-check
```

## 🐳 Docker

Build the Docker image:
```bash
docker build -t aidlink-frontend .
```

Run the container:
```bash
docker run -p 3000:3000 aidlink-frontend
```

## 🚢 Deployment

### Vercel

The easiest way to deploy is using Vercel:

1. Push your code to GitHub
2. Import the project in Vercel
3. Add environment variables
4. Deploy

### Docker

Deploy using Docker to any container registry:
```bash
docker build -t aidlink-frontend .
docker tag aidlink-frontend your-registry/aidlink-frontend
docker push your-registry/aidlink-frontend
```

## 📚 Documentation

- [Architecture Documentation](./docs/ARCHITECTURE.md) - System architecture and design patterns
- [Component Documentation](./docs/COMPONENTS.md) - Reusable component library
- [API Documentation](./docs/API.md) - API endpoints and integration guide
- [Deployment Guide](./docs/DEPLOYMENT.md) - Deployment instructions for various platforms
- [Testing Guide](./docs/TESTING.md) - Testing strategies and best practices
- [Contributing Guide](./docs/CONTRIBUTING.md) - How to contribute to the project

## 🤝 Contributing

We welcome contributions! Please read our [Contributing Guide](./docs/CONTRIBUTING.md) before submitting a pull request.

## 📄 License

This project is licensed under the MIT License.

## 🙏 Acknowledgments

- Stellar Development Foundation
- shadcn/ui
- Vercel
- The open-source community

## 📞 Support

For support, email support@aidlink.org or open an issue on GitHub.

## 🔗 Links

- [Stellar Documentation](https://developers.stellar.org/)
- [Soroban Documentation](https://soroban.stellar.org/)
- [Next.js Documentation](https://nextjs.org/docs)
- [shadcn/ui Components](https://ui.shadcn.com/)

## 🌍 Live Demo

Check out the live demo at [demo.aidlink.org](https://demo.aidlink.org) (coming soon)

## 📈 Roadmap

- [ ] Multi-language support (i18n)
- [ ] Advanced analytics dashboard
- [ ] Mobile app (React Native)
- [ ] AI-powered campaign recommendations
- [ ] Integration with more blockchain networks
- [ ] Advanced reporting features
- [ ] Video verification for beneficiaries
- [ ] Smart contract audit and verification
