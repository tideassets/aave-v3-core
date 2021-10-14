const { expect } = require('chai');
import { BigNumber, utils } from 'ethers';
import { ReserveData, UserReserveData } from './helpers/utils/interfaces';
import { waitForTx, advanceTimeAndBlock } from '../helpers/misc-utils';
import { ProtocolErrors, RateMode } from '../helpers/types';
import { getACLManager } from '../helpers/contracts-getters';
import { MAX_UINT_AMOUNT, MAX_UNBACKED_MINT_CAP } from '../helpers/constants';
import { ACLManager } from '../types';
import AaveConfig from '../market-config';
import { TestEnv, makeSuite } from './helpers/make-suite';
import { getReserveData } from './helpers/utils/helpers';
import { getTxCostAndTimestamp } from './helpers/actions';
import {
  calcExpectedReserveDataAfterMintUnbacked,
  calcExpectedReserveDataAfterBackUnbacked,
  configuration as calculationsConfiguration,
} from './helpers/utils/calculations';
import './helpers/utils/wadraymath';

const expectEqual = (
  actual: UserReserveData | ReserveData,
  expected: UserReserveData | ReserveData
) => {
  expect(actual).to.be.almostEqualOrEqual(expected);
};

makeSuite('BridgeLogic: Testing with borrows', (testEnv: TestEnv) => {
  const { P_CALLER_NOT_BRIDGE, VL_UNBACKED_MINT_CAP_EXCEEDED } = ProtocolErrors;

  const depositAmount = utils.parseEther('1000');
  const borrowAmount = utils.parseEther('200');
  const withdrawAmount = utils.parseEther('100');
  const feeBps = BigNumber.from(30);
  const denominatorBP = BigNumber.from(10000);
  const bridgeProtocolFeeBps = BigNumber.from(2000);

  const mintAmount = withdrawAmount.mul(denominatorBP.sub(feeBps)).div(denominatorBP);
  const feeAmount = withdrawAmount.mul(feeBps).div(denominatorBP);

  let aclManager: ACLManager;

  before(async () => {
    calculationsConfiguration.reservesParams = AaveConfig.ReservesConfig;

    const { users, poolAdmin, configurator } = testEnv;

    aclManager = await getACLManager();

    await aclManager.addBridge(users[2].address);
    await aclManager.addBridge(users[3].address);

    await configurator.connect(poolAdmin.signer).updateBridgeProtocolFee(bridgeProtocolFeeBps);
  });

  it('User 0 deposit 1000 dai.', async () => {
    const { users, pool, dai } = testEnv;
    await dai.connect(users[0].signer).mint(depositAmount);
    await dai.connect(users[0].signer).approve(pool.address, MAX_UINT_AMOUNT);
    await pool.connect(users[0].signer).deposit(dai.address, depositAmount, users[0].address, 0);
  });

  it('User 1 deposit 2 eth', async () => {
    const { users, pool, weth } = testEnv;
    await weth.connect(users[1].signer).deposit({ value: utils.parseEther('2') });
    await weth.connect(users[1].signer).approve(pool.address, MAX_UINT_AMOUNT);
    await pool
      .connect(users[1].signer)
      .deposit(weth.address, utils.parseEther('2'), users[1].address, 0);
  });

  it('User 1 borrows 200 dai with variable debt', async () => {
    const { users, pool, dai } = testEnv;
    await pool
      .connect(users[1].signer)
      .borrow(dai.address, borrowAmount, RateMode.Variable, 0, users[1].address);
  });

  it('User 1 borrows 200 dai with stable debt', async () => {
    const { users, pool, dai } = testEnv;
    await pool
      .connect(users[1].signer)
      .borrow(dai.address, borrowAmount, RateMode.Stable, 0, users[1].address);
  });

  it('User 1 tries to perform fast withdraw 100 aDai from L2 (revert expected)', async () => {
    const { users, pool, dai } = testEnv;
    await expect(
      pool.connect(users[1].signer).mintUnbacked(dai.address, mintAmount, users[0].address, 0)
    ).to.be.revertedWith(P_CALLER_NOT_BRIDGE);
  });

  it('RiskAdmin updates the unbackedMintCap to 10 aDai (10 left) and user 1 tries to perform fast withdraw 100 aDai from L2 (revert expected)', async () => {
    const { users, riskAdmin, pool, configurator, dai } = testEnv;
    expect(await configurator.connect(riskAdmin.signer).setUnbackedMintCap(dai.address, '10'));
    await expect(
      pool.connect(users[2].signer).mintUnbacked(dai.address, mintAmount, users[0].address, 0)
    ).to.be.revertedWith(VL_UNBACKED_MINT_CAP_EXCEEDED);

    expect(
      await configurator
        .connect(riskAdmin.signer)
        .setUnbackedMintCap(dai.address, MAX_UNBACKED_MINT_CAP)
    );
  });

  it('User 2 perform fast withdraw 100 aDai from L2', async () => {
    const { users, pool, dai, helpersContract } = testEnv;
    const reserveDataBefore = await getReserveData(helpersContract, dai.address);
    const tx = await waitForTx(
      await pool.connect(users[2].signer).mintUnbacked(dai.address, mintAmount, users[2].address, 0)
    );
    const { txTimestamp } = await getTxCostAndTimestamp(tx);
    const expectedDataAfter = calcExpectedReserveDataAfterMintUnbacked(
      mintAmount.toString(),
      reserveDataBefore,
      txTimestamp
    );
    const reserveDataAfter = await getReserveData(helpersContract, dai.address);
    expectEqual(reserveDataAfter, expectedDataAfter);
  });

  it('RiskAdmin updates the unbackedMintCap to 100 aDai (0 left) and user 1 tries to perform fast withdraw 1 aDai from L2 (revert expected)', async () => {
    const { users, riskAdmin, pool, configurator, dai } = testEnv;
    expect(await configurator.connect(riskAdmin.signer).setUnbackedMintCap(dai.address, '100'));
    await expect(
      pool.connect(users[2].signer).mintUnbacked(dai.address, mintAmount, users[0].address, 0)
    ).to.be.revertedWith(VL_UNBACKED_MINT_CAP_EXCEEDED);

    expect(
      await configurator
        .connect(riskAdmin.signer)
        .setUnbackedMintCap(dai.address, MAX_UNBACKED_MINT_CAP)
    );
  });

  it('User 2 perform another fast withdraw 100 aDai from L2', async () => {
    const { users, pool, dai, helpersContract } = testEnv;
    const reserveDataBefore = await getReserveData(helpersContract, dai.address);
    const tx = await waitForTx(
      await pool.connect(users[2].signer).mintUnbacked(dai.address, mintAmount, users[2].address, 0)
    );
    const { txTimestamp } = await getTxCostAndTimestamp(tx);
    const reserveDataAfter = await getReserveData(helpersContract, dai.address);
    const expectedDataAfter = calcExpectedReserveDataAfterMintUnbacked(
      mintAmount.toString(),
      reserveDataBefore,
      txTimestamp
    );
    expectEqual(reserveDataAfter, expectedDataAfter);
  });

  it('Wait 1 days', async () => {
    await advanceTimeAndBlock(60 * 60 * 24);
  });

  it('User 2 perform invalid fast withdraw 100 aDai from L2', async () => {
    const { users, pool, dai, helpersContract } = testEnv;
    const reserveDataBefore = await getReserveData(helpersContract, dai.address);
    const tx = await waitForTx(
      await pool.connect(users[2].signer).mintUnbacked(dai.address, mintAmount, users[2].address, 0)
    );
    const { txTimestamp } = await getTxCostAndTimestamp(tx);
    const reserveDataAfter = await getReserveData(helpersContract, dai.address);
    const expectedDataAfter = calcExpectedReserveDataAfterMintUnbacked(
      mintAmount.toString(),
      reserveDataBefore,
      txTimestamp
    );
    expectEqual(reserveDataAfter, expectedDataAfter);
  });

  it('Wait 6 days', async () => {
    await advanceTimeAndBlock(60 * 60 * 24 * 6);
  });

  it('100 bridged dai used to back unbacked', async () => {
    // Let user 3 be bridge for now
    const { users, pool, dai, aDai, helpersContract } = testEnv;
    await dai.connect(users[3].signer).mint(withdrawAmount);
    await dai.connect(users[3].signer).approve(pool.address, MAX_UINT_AMOUNT);

    const reserveDataBefore = await getReserveData(helpersContract, dai.address);

    const tx = await waitForTx(
      await pool.connect(users[3].signer).backUnbacked(dai.address, mintAmount, feeAmount)
    );

    const { txTimestamp } = await getTxCostAndTimestamp(tx);

    const reserveDataAfter = await getReserveData(helpersContract, dai.address);

    const expectedReserveDataAfter = calcExpectedReserveDataAfterBackUnbacked(
      await aDai.scaledTotalSupply(),
      mintAmount.toString(),
      feeAmount.toString(),
      bridgeProtocolFeeBps.toString(),
      reserveDataBefore,
      txTimestamp
    );

    expectEqual(reserveDataAfter, expectedReserveDataAfter);
  });

  it('user 1 performs unauthorized backing', async () => {
    const { users, pool, dai } = testEnv;
    await dai.connect(users[1].signer).mint(withdrawAmount);
    await dai.connect(users[1].signer).approve(pool.address, MAX_UINT_AMOUNT);

    await expect(
      pool.connect(users[1].signer).backUnbacked(dai.address, mintAmount, feeAmount)
    ).to.be.revertedWith(P_CALLER_NOT_BRIDGE);
  });

  it('100 bridged dai used to back unbacked', async () => {
    // Let user 3 be bridge for now
    const { users, pool, dai, aDai, helpersContract } = testEnv;
    await dai.connect(users[3].signer).mint(withdrawAmount);
    await dai.connect(users[3].signer).approve(pool.address, MAX_UINT_AMOUNT);

    const reserveDataBefore = await getReserveData(helpersContract, dai.address);

    const tx = await waitForTx(
      await pool.connect(users[3].signer).backUnbacked(dai.address, mintAmount, feeAmount)
    );

    const { txTimestamp } = await getTxCostAndTimestamp(tx);

    const reserveDataAfter = await getReserveData(helpersContract, dai.address);

    const expectedReserveDataAfter = calcExpectedReserveDataAfterBackUnbacked(
      await aDai.scaledTotalSupply(),
      mintAmount.toString(),
      feeAmount.toString(),
      bridgeProtocolFeeBps.toString(),
      reserveDataBefore,
      txTimestamp
    );

    expectEqual(reserveDataAfter, expectedReserveDataAfter);
  });

  it('User donates 100 dai to aDai holders', async () => {
    // Let user 3 be bridge for now
    const { users, pool, dai, aDai, helpersContract } = testEnv;
    await dai.connect(users[3].signer).mint(withdrawAmount);
    await dai.connect(users[3].signer).approve(pool.address, MAX_UINT_AMOUNT);

    const reserveDataBefore = await getReserveData(helpersContract, dai.address);

    const tx = await waitForTx(
      await pool.connect(users[3].signer).backUnbacked(dai.address, '0', withdrawAmount)
    );

    const { txTimestamp } = await getTxCostAndTimestamp(tx);
    const reserveDataAfter = await getReserveData(helpersContract, dai.address);

    const expectedReserveDataAfter = calcExpectedReserveDataAfterBackUnbacked(
      await aDai.scaledTotalSupply(),
      '0',
      withdrawAmount.toString(),
      bridgeProtocolFeeBps.toString(),
      reserveDataBefore,
      txTimestamp
    );

    expectEqual(reserveDataAfter, expectedReserveDataAfter);
    expect(reserveDataBefore.unbacked).to.be.eq(mintAmount);
    expect(reserveDataAfter.unbacked).to.be.eq(mintAmount);
    expect(reserveDataAfter.liquidityIndex.gt(reserveDataBefore.liquidityIndex)).to.be.eq(true);
  });

  it('Safety module cover 100 unbacked dai', async () => {
    // Let user 3 be bridge for now
    const { users, pool, dai, aDai, helpersContract } = testEnv;
    await dai.connect(users[3].signer).mint(withdrawAmount);
    await dai.connect(users[3].signer).approve(pool.address, MAX_UINT_AMOUNT);

    const reserveDataBefore = await getReserveData(helpersContract, dai.address);

    const tx = await waitForTx(
      await pool.connect(users[3].signer).backUnbacked(dai.address, mintAmount, '0')
    );

    const { txTimestamp } = await getTxCostAndTimestamp(tx);
    const reserveDataAfter = await getReserveData(helpersContract, dai.address);

    const expectedReserveDataAfter = calcExpectedReserveDataAfterBackUnbacked(
      await aDai.scaledTotalSupply(),
      mintAmount.toString(),
      '0',
      bridgeProtocolFeeBps.toString(),
      reserveDataBefore,
      txTimestamp
    );

    expectEqual(reserveDataAfter, expectedReserveDataAfter);
    expect(reserveDataBefore.unbacked).to.be.eq(mintAmount);
    expect(reserveDataAfter.unbacked).to.be.eq('0');
  });
});
