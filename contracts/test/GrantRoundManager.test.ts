// --- External imports ---
import { artifacts, ethers, waffle } from 'hardhat';
import { Artifact } from 'hardhat/types';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signer-with-address';
import { deployMockContract } from '@ethereum-waffle/mock-contract';
import { MockContract } from 'ethereum-waffle';
import { expect } from 'chai';

// --- Our imports ---
import { ETH_ADDRESS, WETH_ADDRESS, UNISWAP_ROUTER, UNISWAP_FEES, tokens, approve, balanceOf, setBalance } from './utils'; // prettier-ignore
import { GrantRoundManager } from '../typechain';
import { Donation } from '@dgrants/types';

// --- Parse and define helpers ---
const { isAddress, parseUnits } = ethers.utils;
const { deployContract } = waffle;
const randomAddress = () => ethers.Wallet.createRandom().address;
const gtcAddress = tokens['gtc'].address;

// --- GrantRoundManager tests ---
describe('GrantRoundManager', () => {
  let user: SignerWithAddress;
  let manager: GrantRoundManager;
  let mockToken: MockContract;
  let mockRegistry: MockContract;

  before(async () => {
    [user] = await ethers.getSigners();

    // Deploy mock contracts
    mockRegistry = await deployMockContract(user, artifacts.readArtifactSync('GrantRegistry').abi);
    mockToken = await deployMockContract(user, ['function totalSupply() returns(uint256)']);
    await mockRegistry.mock.grantCount.returns('1');
    await mockToken.mock.totalSupply.returns('0');

    // Deploy Manager
    const managerArtifact: Artifact = await artifacts.readArtifact('GrantRoundManager');
    manager = <GrantRoundManager>(
      await deployContract(user, managerArtifact, [mockRegistry.address, UNISWAP_ROUTER, gtcAddress])
    );
  });

  describe('constructor', () => {
    it('deploys properly', async () => {
      // Verify deploy
      expect(isAddress(manager.address), 'Failed to deploy GrantRoundManager').to.be.true;

      // Verify constructor parameters
      expect(await manager.registry()).to.equal(mockRegistry.address);
      expect(await manager.router()).to.equal(UNISWAP_ROUTER);
      expect(await manager.donationToken()).to.equal(gtcAddress);
    });

    it('reverts when deploying with an invalid grant registry', async () => {
      // Test that deployment fails if provided Registry address has no code
      const managerArtifact: Artifact = await artifacts.readArtifact('GrantRoundManager');
      await expect(
        deployContract(user, managerArtifact, [randomAddress(), UNISWAP_ROUTER, gtcAddress])
      ).to.be.revertedWith('function call to a non-contract account');
    });

    it('reverts when deploying with an invalid router', async () => {
      // Test that deployment fails if provided Router address has no code
      const managerArtifact: Artifact = await artifacts.readArtifact('GrantRoundManager');
      await expect(
        deployContract(user, managerArtifact, [mockRegistry.address, randomAddress(), gtcAddress])
      ).to.be.revertedWith('GrantRoundManager: Invalid router');
    });

    it('reverts when deploying with an invalid donation token', async () => {
      // First we test a donation token address that has no code
      const managerArtifact: Artifact = await artifacts.readArtifact('GrantRoundManager');
      await expect(
        deployContract(user, managerArtifact, [mockRegistry.address, UNISWAP_ROUTER, randomAddress()])
      ).to.be.revertedWith('function call to a non-contract account');

      // Now we test a donation token that has no supply
      await mockToken.mock.totalSupply.returns('0');
      await expect(
        deployContract(user, managerArtifact, [mockRegistry.address, UNISWAP_ROUTER, mockToken.address])
      ).to.be.revertedWith('GrantRoundManager: Invalid token');
    });
  });

  describe('createGrantRound', () => {
    let mockRegistry: MockContract;
    let mockMatchingToken: MockContract;
    let registry: string;
    // Create round
    const metadataAdmin = randomAddress();
    const payoutAdmin = randomAddress();
    const startTime = '50000000000000'; // random timestamp far in the future
    const endTime = '60000000000000'; // random timestamp far in the future
    const metaPtr = 'https://metadata-pointer.com';
    const minContribution = '100';
    beforeEach(async () => {
      // Deploy and configure mocks (used to pass the validation in the GrantRound constructor)
      mockRegistry = await deployMockContract(user, ['function grantCount() returns(uint96)']);
      await mockRegistry.mock.grantCount.returns('0');
      registry = mockRegistry.address;

      mockMatchingToken = await deployMockContract(user, ['function totalSupply() returns(uint256)']);
    });
    it('creates new grant rounds', async () => {
      // Create a valid token supply
      await mockMatchingToken.mock.totalSupply.returns('100');
      const tx = await manager.createGrantRound(
        metadataAdmin,
        payoutAdmin,
        mockMatchingToken.address,
        registry,
        startTime,
        endTime,
        metaPtr,
        minContribution
      );

      // Verify event log was emitted
      await expect(tx).to.emit(manager, 'GrantRoundCreated');

      // Parse data from the event to get the address of the new GrantRound
      const receipt = await ethers.provider.getTransactionReceipt(tx.hash);
      const log = manager.interface.parseLog(receipt.logs[0]);
      const { grantRound: grantRoundAddress } = log.args;

      // Verify GrantRound was properly created
      const grantRound = await ethers.getContractAt('GrantRound', grantRoundAddress);
      expect(await grantRound.metadataAdmin()).to.equal(metadataAdmin);
      expect(await grantRound.payoutAdmin()).to.equal(payoutAdmin);
      expect(await grantRound.registry()).to.equal(registry);
      expect(await grantRound.donationToken()).to.equal(gtcAddress);
      expect(await grantRound.matchingToken()).to.equal(mockMatchingToken.address);
      expect(await grantRound.startTime()).to.equal(startTime);
      expect(await grantRound.endTime()).to.equal(endTime);
      expect(await grantRound.metaPtr()).to.equal(metaPtr);
      expect(await grantRound.minContribution()).to.equal(minContribution);
    });

    it('reverts when creating a round with an invalid matching token', async () => {
      await mockMatchingToken.mock.totalSupply.returns('0');
      await expect(
        manager.createGrantRound(
          metadataAdmin,
          payoutAdmin,
          mockMatchingToken.address,
          registry,
          startTime,
          endTime,
          metaPtr,
          minContribution
        )
      ).to.be.revertedWith('GrantRoundManager: Invalid matching token');
    });
  });

  describe('swapAndDonate', () => {
    let mockRound: MockContract;
    let donation: Donation;
    const farTimestamp = '10000000000'; // date of 2286-11-20

    beforeEach(async () => {
      // Deploy a mock GrantRound
      mockRound = await deployMockContract(user, artifacts.readArtifactSync('GrantRound').abi);
      await mockRound.mock.donationToken.returns(gtcAddress);
      await mockRound.mock.isActive.returns(true);

      // Configure default donation data
      donation = {
        grantId: 0,
        rounds: [mockRound.address],
        tokenIn: gtcAddress,
        fee: UNISWAP_FEES[0],
        deadline: farTimestamp, // arbitrary date far in the future
        amountIn: '1',
        amountOutMinimum: '0',
        sqrtPriceLimitX96: '0',
      };
    });

    it('reverts if no rounds are specified', async () => {
      await expect(manager.swapAndDonate({ ...donation, rounds: [] })).to.be.revertedWith(
        'GrantRoundManager: Must specify at least one round'
      );
    });

    it('reverts if an invalid grant ID is provided', async () => {
      await expect(manager.swapAndDonate({ ...donation, grantId: '500' })).to.be.revertedWith(
        'GrantRoundManager: Grant does not exist in registry'
      );
    });

    it('reverts if a provided grant round has a different donation token than the GrantRoundManager', async () => {
      await mockRound.mock.donationToken.returns(ETH_ADDRESS);
      await expect(manager.swapAndDonate(donation)).to.be.revertedWith(
        "GrantRoundManager: GrantRound's donation token does not match GrantRoundManager's donation token"
      );
    });

    it('reverts if a provided grant round is not active', async () => {
      await mockRound.mock.isActive.returns(false);
      await expect(manager.swapAndDonate(donation)).to.be.revertedWith('GrantRoundManager: GrantRound is not active');
    });

    it('input token GTC, output token GTC', async () => {
      // Give the user 100 GTC
      const amountIn = parseUnits('100', 18);
      await setBalance('gtc', user.address, amountIn);

      // Set payee address to be a random address
      const payee = randomAddress();
      await mockRegistry.mock.getGrantPayee.returns(payee);

      // Execute donation to the payee
      expect(await balanceOf('gtc', payee)).to.equal('0');
      await approve('gtc', user, manager.address);
      await manager.swapAndDonate({ ...donation, amountIn });
      expect(await balanceOf('gtc', payee)).to.equal(amountIn);
    });

    it('input token ETH, output token GTC', async () => {
      // Set payee address to be a random address
      const payee = randomAddress();
      await mockRegistry.mock.getGrantPayee.returns(payee);

      // Use the 1% GTC/ETH pool to swap from ETH (input) to GTC (donationToken). The 1% pool is currently the most liquid
      const amountIn = parseUnits('10', 18);
      const tx = await manager.swapAndDonate(
        { ...donation, tokenIn: WETH_ADDRESS, fee: UNISWAP_FEES[2], amountIn },
        { value: amountIn, gasPrice: '0' } // zero gas price to make balance checks simpler
      );

      // Get the amountOut from the swap from the GrantDonation log
      const receipt = await ethers.provider.getTransactionReceipt(tx.hash);
      const log = manager.interface.parseLog(receipt.logs[receipt.logs.length - 1]); // the event we want is the last one
      const { amountOut } = log.args;
      expect(await balanceOf('gtc', payee)).to.equal(amountOut);
    });

    it.skip('input token DAI, output token GTC', async () => {
      // TODO skipped because there is no DAI-GTC pool, so this fails as Uniswap V3 tries to swap directly in
      // the specified pool. Need to determine how to specify a route

      // Give the user 100 DAI
      const amountIn = parseUnits('100', 18);
      await setBalance('dai', user.address, amountIn);

      // Set payee address to be a random address
      const payee = randomAddress();
      await mockRegistry.mock.getGrantPayee.returns(payee);

      // Execute donation to the payee
      await approve('dai', user, manager.address);
      console.log(1);
      console.log('tokens.dai.address: ', tokens.dai.address);
      const tx = await manager.swapAndDonate({ ...donation, tokenIn: tokens.dai.address, amountIn });
      console.log(2);
      expect(await balanceOf('dai', user.address)).to.equal('0');

      // Get the amountOut from the swap from the GrantDonation log
      const receipt = await ethers.provider.getTransactionReceipt(tx.hash);
      const log = manager.interface.parseLog(receipt.logs[receipt.logs.length - 1]); // the event we want is the last one
      const { amountOut } = log.args;
      expect(await balanceOf('gtc', payee)).to.equal(amountOut);
    });

    it('emits a log on a successful donation', async () => {
      // Set donation token to GTC and give the user 100 GTC
      const amountIn = parseUnits('100', 18);
      await setBalance('gtc', user.address, amountIn);

      // Set payee address to be a random address
      const payee = randomAddress();
      await mockRegistry.mock.getGrantPayee.returns(payee);

      // Execute donation to the payee
      await approve('gtc', user, manager.address);
      const tx = await manager.swapAndDonate({ ...donation, amountIn });
      await expect(tx)
        .to.emit(manager, 'GrantDonation')
        .withArgs('0', gtcAddress, amountIn, amountIn, [mockRound.address]);
    });
  });
});
