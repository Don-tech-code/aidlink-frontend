import { xdr, Address, Contract, scValToNative } from '@stellar/stellar-sdk';
import { UserRole } from '@/types';

// Soroban Role mapping: 0 = donor, 1 = ngo, 2 = beneficiary, 3 = admin
const ROLE_MAP: Record<number, UserRole> = {
  0: 'donor',
  1: 'ngo',
  2: 'beneficiary',
  3: 'admin',
};

export class BeneficiaryRegistryClient {
  private contractId: string;
  private networkUrl: string;

  constructor(
    contractId: string = process.env.NEXT_PUBLIC_BENEFICIARY_REGISTRY_CONTRACT || '',
    networkUrl: string = process.env.NEXT_PUBLIC_STELLAR_NETWORK_URL || 'https://horizon-testnet.stellar.org'
  ) {
    this.contractId = contractId;
    this.networkUrl = networkUrl;
  }

  async getRole(publicKey: string): Promise<UserRole | null> {
    if (!publicKey || !this.contractId) {
      return null;
    }

    try {
      const addressScVal = new Address(publicKey).toScVal();
      const contract = new Contract(this.contractId);
      const call = contract.call('get_role', addressScVal);

      return null;
    } catch (err) {
      console.error('BeneficiaryRegistryClient.getRole failed:', err);
      throw err;
    }
  }

  async updateVerificationStatus(account: string, status: number): Promise<void> {
    if (!account || !this.contractId) {
      throw new Error('Contract ID and target account are required');
    }

    try {
      const accountScVal = new Address(account).toScVal();
      const statusScVal = xdr.ScVal.scvU32(status);

      const contract = new Contract(this.contractId);
      contract.call('update_verification_status', accountScVal, statusScVal);
    } catch (err) {
      console.error('BeneficiaryRegistryClient.updateVerificationStatus failed:', err);
      throw err;
    }
  }
}

export const beneficiaryRegistryClient = new BeneficiaryRegistryClient();
